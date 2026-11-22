import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import proxyAddr from '@fastify/proxy-addr';
import { openDatabase } from './db.js';
import { createSessionStore } from './auth/sessions.js';
import { createPhotoStore } from './media/store.js';
import { forbidden, HttpError, unauthenticated } from './http/errors.js';
import {
  applySecurityHeaders,
  assertSameOrigin,
  isSecureRequest,
  sessionCookieName,
} from './http/security.js';
import authRoutes from './routes/auth.js';
import taskRoutes from './routes/tasks.js';
import photoRoutes, { mediaRoutes } from './routes/photos.js';
import adminRoutes from './routes/admin.js';
import roomRoutes from './routes/rooms.js';

/**
 * Hlavičkám X-Forwarded-* se věří jen tehdy, když spojení přišlo z adresy
 * uvedené v TRUST_PROXY, a jen pro daný počet skoků. Cokoliv dál v řetězu
 * mohl podvrhnout klient.
 */
export function trustedProxies(config) {
  if (config.trustProxy.length === 0) return false;
  const allowed = proxyAddr.compile(config.trustProxy);
  return (address, hop) => hop < config.trustProxyHops && allowed(address, hop);
}

const tooManyRequests = (_request, context) =>
  new HttpError(
    429,
    'rate_limited',
    `Příliš mnoho požadavků. Zkuste to znovu za ${Math.max(1, Math.ceil(context.ttl / 1000))} s`,
  );

export async function buildApp(config) {
  const app = Fastify({
    logger:
      config.logger ??
      {
        level: config.logLevel,
        redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      },
    trustProxy: trustedProxies(config),
    bodyLimit: 64 * 1024,
    routerOptions: { maxParamLength: 64 },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, useDefaults: false } },
  });

  const db = openDatabase(config, app.log);
  const sessions = createSessionStore(db, config);
  const photos = await createPhotoStore(config, app.log);

  const insertEvent = db.prepare(
    'INSERT INTO task_events (task_id, user_id, type, from_status, to_status, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const pendingUsers = db.prepare("SELECT COUNT(*) FROM users WHERE status = 'pending'").pluck();

  const ctx = {
    db,
    config,
    sessions,
    photos,
    addEvent: (taskId, userId, type, from, to, at, note = null) => insertEvent.run(taskId, userId, type, from, to, at, note),

    // Jediné místo, kde se rozhoduje, kdo smí do systému zasahovat. Uživatel
    // se při každém požadavku načítá z databáze znovu, takže zablokování nebo
    // odebrání práv platí okamžitě.
    requireUser: async (request) => {
      if (!request.user) throw unauthenticated();
      if (request.user.mustChangePassword) {
        throw new HttpError(403, 'password_change_required', 'Nejdřív si změňte dočasné heslo');
      }
    },
    requireAdmin: async (request) => {
      await ctx.requireUser(request);
      if (request.user.role !== 'admin') throw forbidden('Tato část je jen pro správce');
    },

    describeSession(request) {
      const user = request.user;
      return {
        user: user
          ? { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword }
          : null,
        pendingUsers: user?.role === 'admin' && !user.mustChangePassword ? pendingUsers.get() : undefined,
        limits: { maxUploadBytes: config.maxUploadBytes, maxPhotosPerTask: config.maxPhotosPerTask },
      };
    },
  };

  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('viewer', {
    getter() {
      return this.user && !this.user.mustChangePassword ? this.user : null;
    },
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 2, headerPairs: 32 },
  });
  if (config.rateLimits) {
    // Výchozí strop pro cesty API, které nemají vlastní. Musí být zaregistrován
    // dřív než samotný limiter, aby ho ten při zakládání cesty už viděl.
    app.addHook('onRoute', (route) => {
      if (route.url.startsWith('/api/') && !route.config?.rateLimit) {
        route.config = { ...route.config, rateLimit: { max: 600, timeWindow: '1 minute' } };
      }
    });
    await app.register(rateLimit, {
      global: false,
      errorResponseBuilder: tooManyRequests,
      // Přihlášení se počítají podle účtu, ostatní podle adresy.
      keyGenerator: (request) => (request.user ? `u:${request.user.id}` : `ip:${request.ip}`),
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(config, request, reply);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...error.extra } });
    }
    if (error.validation) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Požadavek obsahuje neplatná data' } });
    }
    const status = error.statusCode ?? 500;
    if (status === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'too_large', message: 'Odesílaná data jsou příliš velká' } });
    }
    if (status === 503 && error.code === 'busy') {
      return reply.code(503).send({ error: { code: 'busy', message: error.message } });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: 'Požadavek se nepodařilo zpracovat' } });
    }
    request.log.error({ err: error }, 'neočekávaná chyba');
    return reply.code(500).send({ error: { code: 'server_error', message: 'Na serveru se něco pokazilo' } });
  });

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        assertSameOrigin(config, request);
        const token = request.cookies[sessionCookieName(isSecureRequest(config, request))];
        if (token) {
          const user = sessions.resolve(token);
          if (user) {
            request.user = user;
            request.sessionToken = token;
          }
        }
      });

      const routeOptions = { ctx };

      api.get('/health', async () => {
        db.prepare('SELECT 1').get();
        return { ok: true };
      });
      await api.register(authRoutes, routeOptions);
      await api.register(taskRoutes, routeOptions);
      await api.register(photoRoutes, routeOptions);
      await api.register(roomRoutes, routeOptions);
      await api.register(adminRoutes, routeOptions);

      api.setNotFoundHandler(async (_request, reply) =>
        reply.code(404).send({ error: { code: 'not_found', message: 'Tato adresa API neexistuje' } }),
      );
    },
    { prefix: '/api' },
  );

  await app.register(mediaRoutes, { ctx });

  await app.register(fastifyStatic, {
    root: config.publicDir,
    index: 'index.html',
    // Soubory se zaregistrují při startu jednotlivě; neznámé adresy tak jdou
    // rovnou do obsluhy „nenalezeno“ a neprocházejí čtením z disku.
    wildcard: false,
    cacheControl: false,
    dotfiles: 'ignore',
    setHeaders(reply, filePath) {
      // Písma se nemění; ostatní soubory si prohlížeč před použitím ověří,
      // takže se nová verze po aktualizaci projeví hned.
      const immutable = filePath.endsWith('.woff2');
      reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  // Adresy jako /ukol/12 obsluhuje aplikace v prohlížeči.
  app.setNotFoundHandler((request, reply) => {
    const wantsPage =
      request.method === 'GET' &&
      !request.url.startsWith('/media/') &&
      !/\.[a-z0-9]{2,5}($|\?)/i.test(request.url) &&
      String(request.headers.accept ?? '').includes('text/html');
    if (wantsPage) {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Nenalezeno' } });
  });

  app.addHook('onClose', async () => {
    db.close();
  });

  return app;
}

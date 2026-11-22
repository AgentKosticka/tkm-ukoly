import { badRequest, conflict, HttpError, unauthenticated } from '../http/errors.js';
import { isSecureRequest, sessionCookieName, sessionCookieOptions } from '../http/security.js';
import {
  hashPassword,
  needsRehash,
  passwordProblem,
  usernameProblem,
  verifyPassword,
} from '../auth/passwords.js';
import { AttemptLimiter } from '../util/limiter.js';

const credentials = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', maxLength: 64 },
    password: { type: 'string', maxLength: 1024 },
  },
};

const WINDOW_MS = 15 * 60 * 1000;

export default async function authRoutes(app, { ctx }) {
  const { db, config, sessions } = ctx;

  // Brzdí se dvojice adresa + jméno a adresa samotná. Účet se nikdy nezamyká
  // jen podle jména, jinak by šlo kohokoliv (třeba správce) odstavit hádáním hesla.
  const perIpAndUser = new AttemptLimiter({ limit: 5, windowMs: WINDOW_MS });
  const perIp = new AttemptLimiter({ limit: 20, windowMs: WINDOW_MS });

  const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
  const insertUser = db.prepare(
    "INSERT INTO users (username, password_hash, role, status, created_at) VALUES (?, ?, 'user', 'pending', ?)",
  );
  const countPending = db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").pluck();
  const setLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
  const setHash = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?');
  const rehash = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  const getHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').pluck();

  // Ověřuje se i u neexistujícího jména, aby se z doby odpovědi nedalo
  // poznat, které účty existují.
  const dummyHash = await hashPassword('neexistujici-ucet', config.scryptCost);

  const limit = (max, timeWindow) => ({ rateLimit: { max, timeWindow } });

  function setSessionCookie(request, reply, token) {
    const secure = isSecureRequest(config, request);
    reply.setCookie(sessionCookieName(secure), token, sessionCookieOptions(config, secure));
  }

  function clearSessionCookie(request, reply) {
    const secure = isSecureRequest(config, request);
    reply.clearCookie(sessionCookieName(secure), { ...sessionCookieOptions(config, secure), maxAge: undefined });
  }

  function tooManyAttempts(reply, seconds) {
    reply.header('Retry-After', seconds);
    const minutes = Math.ceil(seconds / 60);
    return new HttpError(
      429,
      'too_many_attempts',
      `Příliš mnoho neúspěšných pokusů. Zkuste to znovu za ${minutes} min`,
    );
  }

  app.get('/me', async (request) => ctx.describeSession(request));

  app.post(
    '/auth/register',
    { schema: { body: credentials }, config: limit(8, '1 hour') },
    async (request, reply) => {
      const { username, password } = request.body;
      const nameIssue = usernameProblem(username);
      if (nameIssue) throw badRequest('invalid_username', nameIssue, { field: 'username' });
      const passwordIssue = passwordProblem(password, username);
      if (passwordIssue) throw badRequest('invalid_password', passwordIssue, { field: 'password' });

      if (findUser.get(username)) {
        throw new HttpError(409, 'username_taken', 'Toto jméno už někdo používá', { field: 'username' });
      }
      if (countPending.get() >= config.maxPendingUsers) {
        throw new HttpError(503, 'registrations_paused', 'Registrace jsou teď pozastavené. Obraťte se na správce');
      }

      const hash = await hashPassword(password, config.scryptCost);
      try {
        insertUser.run(username, hash, Date.now());
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          throw conflict('username_taken', 'Toto jméno už někdo používá');
        }
        throw err;
      }
      request.log.info({ username }, 'nová registrace čeká na schválení');
      reply.code(201);
      return { status: 'pending' };
    },
  );

  app.post(
    '/auth/login',
    { schema: { body: credentials }, config: limit(30, '5 minutes') },
    async (request, reply) => {
      const { username, password } = request.body;
      const userKey = username.toLowerCase().slice(0, 64);
      const ipKey = request.ip;
      const pairKey = `${ipKey}|${userKey}`;

      const wait = Math.max(perIpAndUser.retryAfter(pairKey), perIp.retryAfter(ipKey));
      if (wait > 0) throw tooManyAttempts(reply, wait);

      const user = usernameProblem(username) ? undefined : findUser.get(username);
      const valid = await verifyPassword(password, user ? user.password_hash : dummyHash);

      if (!user || !valid) {
        perIpAndUser.fail(pairKey);
        perIp.fail(ipKey);
        throw new HttpError(401, 'bad_credentials', 'Nesprávné jméno nebo heslo');
      }
      perIpAndUser.reset(pairKey);

      // Stav účtu se prozradí až po zadání správného hesla.
      if (user.status === 'pending') {
        throw new HttpError(403, 'account_pending', 'Účet ještě čeká na schválení správcem');
      }
      if (user.status !== 'approved') {
        throw new HttpError(403, 'account_disabled', 'Účet je zablokovaný. Obraťte se na správce');
      }

      if (needsRehash(user.password_hash, config.scryptCost)) {
        rehash.run(await hashPassword(password, config.scryptCost), user.id);
      }

      // Stará session (pokud nějaká byla) se zahodí, nová dostane čerstvý token.
      if (request.sessionToken) sessions.destroy(request.sessionToken);
      const token = sessions.create(user.id);
      setLogin.run(Date.now(), user.id);
      setSessionCookie(request, reply, token);
      request.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        mustChangePassword: user.must_change_password === 1,
      };
      return ctx.describeSession(request);
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    if (request.sessionToken) sessions.destroy(request.sessionToken);
    clearSessionCookie(request, reply);
    request.user = null;
    return { ok: true };
  });

  app.post(
    '/auth/password',
    {
      config: limit(10, '15 minutes'),
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: {
            currentPassword: { type: 'string', maxLength: 1024 },
            newPassword: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (request) => {
      // Záměrně bez requireUser: změna hesla musí jít i při vynucené změně.
      const user = request.user;
      if (!user) throw unauthenticated();
      const { currentPassword, newPassword } = request.body;

      const valid = await verifyPassword(currentPassword, getHash.get(user.id));
      if (!valid) {
        throw badRequest('bad_current_password', 'Současné heslo nesouhlasí', { field: 'currentPassword' });
      }
      const issue = passwordProblem(newPassword, user.username);
      if (issue) throw badRequest('invalid_password', issue, { field: 'newPassword' });
      if (newPassword === currentPassword) {
        throw badRequest('same_password', 'Nové heslo musí být jiné než současné', { field: 'newPassword' });
      }

      setHash.run(await hashPassword(newPassword, config.scryptCost), user.id);
      // Ostatní zařízení se odhlásí, tohle zůstane přihlášené.
      sessions.destroyOthers(user.id, user.tokenHash);
      user.mustChangePassword = false;
      return ctx.describeSession(request);
    },
  );
}

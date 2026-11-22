import { HttpError } from './errors.js';

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'ukolnicek';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function isSecureRequest(config, request) {
  if (config.cookieSecure === 'always') return true;
  if (config.cookieSecure === 'never') return false;
  return request.protocol === 'https';
}

export function sessionCookieName(secure) {
  // Prefix __Host- zaručí, že cookie nastavil jen tento původ přes HTTPS.
  return secure ? '__Host-sid' : 'sid';
}

export function sessionCookieOptions(config, secure) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: Math.floor(config.sessionIdleMs / 1000),
  };
}

/**
 * Ochrana proti CSRF nad rámec SameSite=Strict: požadavky, které něco mění,
 * musí přijít ze stejného původu a nést vlastní hlavičku, kterou cizí stránka
 * bez povolení CORS nepošle.
 */
export function assertSameOrigin(config, request) {
  if (SAFE_METHODS.has(request.method)) return;
  const expected = config.publicOrigin ?? `${request.protocol}://${request.host}`;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (origin !== expected) throw new HttpError(403, 'bad_origin', 'Požadavek přišel z jiné adresy');
  } else {
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      throw new HttpError(403, 'bad_origin', 'Požadavek přišel z jiné adresy');
    }
  }
  if (request.headers[CSRF_HEADER] !== CSRF_VALUE) {
    throw new HttpError(403, 'bad_origin', 'Požadavek nemá očekávanou hlavičku');
  }
}

export function applySecurityHeaders(config, request, reply) {
  reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (request.protocol === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

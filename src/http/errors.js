export class HttpError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
    this.expose = true;
  }
}

export const badRequest = (code, message, extra) => new HttpError(400, code, message, extra);
export const unauthenticated = () => new HttpError(401, 'unauthenticated', 'Pro tuto akci se přihlaste');
export const forbidden = (message = 'K této akci nemáte oprávnění') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Nenalezeno') => new HttpError(404, 'not_found', message);
export const conflict = (code, message) => new HttpError(409, code, message);

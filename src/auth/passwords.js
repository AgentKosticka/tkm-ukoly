import crypto from 'node:crypto';
import { Semaphore } from '../util/semaphore.js';

// scrypt s parametry podle doporučení OWASP (N = 2^16, r = 8, p = 2).
// Jedno ověření zabere zhruba 64 MB paměti, proto jich souběžně běží nejvýš
// několik a zbytek čeká ve frontě omezené délky.
const R = 8;
const P = 2;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const gate = new Semaphore(2, 24);

function scrypt(password, salt, cost) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: 2 ** cost, r: R, p: P, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password, cost = 16) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await gate.run(() => scrypt(password, salt, cost));
  return `scrypt$${cost}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 10 || cost > 20) return false;
  if (Number(parts[2]) !== R || Number(parts[3]) !== P) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const key = await gate.run(() => scrypt(password, salt, cost));
  return crypto.timingSafeEqual(key, expected);
}

export function needsRehash(stored, cost) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  return parts[0] !== 'scrypt' || Number(parts[1]) !== cost;
}

/** Čitelné jednorázové heslo, např. pro prvního správce nebo reset. */
export function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 5 === 4 && i < 19) out += '-';
  }
  return out;
}

const COMMON = new Set([
  'password', 'password1', 'password123', 'heslo', 'heslo123', 'heslo1234', 'hesloheslo',
  '1234567890', '12345678910', '0123456789', '9876543210', 'qwertyuiop', 'qwertzuiop',
  'asdfghjkl', 'qwerty12345', 'qwertz12345', 'iloveyou123', 'administrator', 'adminadmin',
  'admin12345', 'letmein123', 'welcome123', 'litomerice', 'technickyklub', 'tkmlitomerice',
  '1111111111', '0000000000', 'aaaaaaaaaa', 'abcdefghij', 'abcd123456', '1q2w3e4r5t',
  '1q2w3e4r5t6z', '1q2w3e4r5t6y', 'passw0rd123', 'tajneheslo', 'mojeheslo', 'nevimheslo',
]);

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Vrací českou chybovou hlášku, nebo null, když heslo vyhovuje. */
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string') return 'Zadejte heslo';
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `Heslo musí mít aspoň ${PASSWORD_MIN} znaků`;
  if (length > PASSWORD_MAX) return `Heslo může mít nejvýš ${PASSWORD_MAX} znaků`;
  const lower = password.toLowerCase();
  const name = username.toLowerCase();
  if (name && (lower === name || (name.length >= 5 && lower.includes(name)))) {
    return 'Heslo nesmí obsahovat uživatelské jméno';
  }
  if (COMMON.has(lower)) return 'Tohle heslo je příliš běžné, zvolte jiné';
  if (new Set(lower).size < 5) return 'Heslo je příliš jednoduché, použijte více různých znaků';
  return null;
}

export const USERNAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$';
const usernameRe = new RegExp(USERNAME_PATTERN);

export function usernameProblem(username) {
  if (typeof username !== 'string' || !usernameRe.test(username)) {
    return 'Jméno musí mít 3–32 znaků: písmena bez diakritiky, číslice, tečka, pomlčka nebo podtržítko';
  }
  return null;
}

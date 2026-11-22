import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Proměnná ${name} musí být celé číslo v rozsahu ${min}–${max}`);
  }
  return value;
}

function oneOf(name, allowed, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) {
    throw new Error(`Proměnná ${name} musí být jedna z hodnot: ${allowed.join(', ')}`);
  }
  return raw;
}

// Položky oddělené čárkou nebo mezerou.
function list(name) {
  return (process.env[name] || '').split(/[\s,]+/).filter(Boolean);
}

function origin(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Proměnná ${name} musí začínat http:// nebo https://`);
  }
  return url.origin;
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
  const config = {
    root,
    publicDir: path.join(root, 'public'),
    dataDir,
    dbFile: path.join(dataDir, 'ukoly.db'),
    photosDir: path.join(dataDir, 'photos'),
    tmpDir: path.join(dataDir, 'tmp'),
    backupDir: path.join(dataDir, 'backups'),

    host: process.env.HOST || '127.0.0.1',
    port: int('PORT', 3000, { min: 0, max: 65535 }),
    // Adresy nebo rozsahy reverzních proxy, kterým aplikace věří hlavičky
    // X-Forwarded-*. Např. „loopback“ nebo „172.16.0.0/12“. Prázdné = žádná proxy.
    trustProxy: list('TRUST_PROXY'),
    // Kolik proxy za sebou smí být v řetězu. Běžně jedna (Caddy); za tunelem
    // dvě (tunel a Caddy).
    trustProxyHops: int('TRUST_PROXY_HOPS', 1, { min: 1, max: 5 }),
    // Pevně daná veřejná adresa; když chybí, odvozuje se z požadavku.
    publicOrigin: origin('PUBLIC_ORIGIN'),
    cookieSecure: oneOf('COOKIE_SECURE', ['auto', 'always', 'never'], 'auto'),

    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || null,

    maxUploadBytes: 20 * 1024 * 1024,
    maxImagePixels: int('MAX_IMAGE_MEGAPIXELS', 64, { min: 1, max: 400 }) * 1_000_000,
    // JPEG XL kodér potřebuje zhruba 25–50 B paměti na pixel; větší fotky se
    // archivují záložní cestou.
    jxlMaxPixels: int('JXL_MAX_MEGAPIXELS', 24, { min: 0, max: 400 }) * 1_000_000,
    jxlEnabled: oneOf('JXL', ['auto', 'off'], 'auto') === 'auto',
    cjxlPath: process.env.CJXL_PATH || 'cjxl',
    djxlPath: process.env.DJXL_PATH || 'djxl',
    maxPhotosPerTask: int('MAX_PHOTOS_PER_TASK', 40, { min: 1, max: 500 }),
    maxPendingUsers: int('MAX_PENDING_USERS', 100, { min: 1, max: 10000 }),
    maxRooms: int('MAX_ROOMS', 50, { min: 1, max: 500 }),

    sessionIdleMs: 14 * 24 * 60 * 60 * 1000,
    sessionMaxMs: 60 * 24 * 60 * 60 * 1000,

    logLevel: process.env.LOG_LEVEL || 'info',
    rateLimits: true,
    scryptCost: 16,
    ...overrides,
  };
  return config;
}

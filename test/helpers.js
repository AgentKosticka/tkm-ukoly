import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { ensureAdmin } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

export const ADMIN = { username: 'spravce', password: 'Velmi-Tajne-Heslo-1' };
export const PASSWORD = 'dlouhe-testovaci-heslo';

export async function startApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukoly-test-'));
  const config = loadConfig({
    dataDir,
    dbFile: path.join(dataDir, 'ukoly.db'),
    photosDir: path.join(dataDir, 'photos'),
    tmpDir: path.join(dataDir, 'tmp'),
    backupDir: path.join(dataDir, 'backups'),
    adminUsername: ADMIN.username,
    adminPassword: ADMIN.password,
    logger: false,
    scryptCost: 10,
    rateLimits: false,
    trustProxy: [],
    ...overrides,
  });
  const app = await buildApp(config);
  await ensureAdmin(app.ctx.db, config, { info() {}, warn() {} }, () => {});
  await app.ready();
  return {
    app,
    config,
    db: app.ctx.db,
    photos: app.ctx.photos,
    client: () => new Client(app),
    async stop() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Malý klient nad app.inject, který si pamatuje cookies jako prohlížeč. */
export class Client {
  constructor(app) {
    this.app = app;
    this.cookies = new Map();
    this.headers = { 'x-requested-with': 'ukolnicek' };
  }

  async request(method, url, { body, headers = {}, payload } = {}) {
    const cookieHeader = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await this.app.inject({
      method,
      url,
      headers: {
        ...this.headers,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      payload: body !== undefined ? JSON.stringify(body) : payload,
    });
    for (const c of response.cookies) {
      if (c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let json;
    try {
      json = response.json();
    } catch {
      json = undefined;
    }
    return { status: response.statusCode, json, headers: response.headers, raw: response.rawPayload, cookies: response.cookies };
  }

  get(url, opts) {
    return this.request('GET', url, opts);
  }
  post(url, body, opts) {
    return this.request('POST', url, { body: body ?? {}, ...opts });
  }
  patch(url, body, opts) {
    return this.request('PATCH', url, { body, ...opts });
  }
  delete(url, opts) {
    return this.request('DELETE', url, opts);
  }

  login(username, password) {
    return this.post('/api/auth/login', { username, password });
  }

  upload(taskId, data, { filename = 'foto.jpg', type = 'image/jpeg', field = 'photo' } = {}) {
    const boundary = `----test${crypto.randomBytes(8).toString('hex')}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return this.request('POST', `/api/tasks/${taskId}/photos`, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([head, data, tail]),
    });
  }
}

/** Zaregistruje uživatele, nechá ho schválit správcem a přihlásí ho. */
export async function approvedUser(ctx, username, password = PASSWORD) {
  const user = ctx.client();
  const registered = await user.post('/api/auth/register', { username, password });
  if (registered.status !== 201) throw new Error(`registrace selhala: ${JSON.stringify(registered.json)}`);
  const admin = await adminClient(ctx);
  const { json } = await admin.get('/api/admin/users');
  const row = json.users.find((u) => u.username === username);
  await admin.post(`/api/admin/users/${row.id}/approve`);
  const login = await user.login(username, password);
  if (login.status !== 200) throw new Error(`přihlášení selhalo: ${JSON.stringify(login.json)}`);
  user.id = row.id;
  return user;
}

export async function adminClient(ctx) {
  const admin = ctx.client();
  const login = await admin.login(ADMIN.username, ADMIN.password);
  if (login.status !== 200) throw new Error(`přihlášení správce selhalo: ${JSON.stringify(login.json)}`);
  return admin;
}

function noise(width, height, channels) {
  const raw = Buffer.alloc(width * height * channels);
  let seed = 987654321;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    const x = Math.floor(i / channels) % width;
    raw[i] = (Math.floor((x / width) * 200) + (seed % 40)) & 0xff;
  }
  return raw;
}

export const SECRET_MARKER = 'TajnyFotak-XYZ';

export async function jpegWithExif({ width = 640, height = 480, orientation = 6 } = {}) {
  return sharp(noise(width, height, 3), { raw: { width, height, channels: 3 } })
    .withIccProfile('p3')
    .withExif({
      IFD0: { Make: SECRET_MARKER, ImageDescription: 'popis s adresou' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 32/1 3/1', GPSLongitudeRef: 'E', GPSLongitude: '14/1 7/1 53/1' },
    })
    .jpeg({ quality: 85 })
    .toBuffer()
    .then((buf) => sharp(buf).withMetadata({ orientation }).jpeg({ quality: 85 }).toBuffer());
}

export async function pngWithAlpha({ width = 320, height = 240 } = {}) {
  return sharp(noise(width, height, 4), { raw: { width, height, channels: 4 } })
    .withIccProfile('p3')
    .withExif({ IFD0: { Make: SECRET_MARKER } })
    .png()
    .toBuffer();
}

export async function lossyWebp({ width = 320, height = 240 } = {}) {
  return sharp(noise(width, height, 3), { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Make: SECRET_MARKER } })
    .webp({ quality: 80 })
    .toBuffer();
}

/** Platný JPEG nafouknutý komentáři přesně na zadanou velikost. */
export async function jpegOfSize(bytes) {
  const base = await sharp(noise(64, 64, 3), { raw: { width: 64, height: 64, channels: 3 } }).jpeg().toBuffer();
  let remaining = bytes - base.length;
  const segments = [];
  while (remaining > 0) {
    // Segment: 2 bajty značka + 2 bajty délka + data (délka zahrnuje sama sebe).
    let total = Math.min(remaining, 65537);
    if (remaining - total > 0 && remaining - total < 4) total -= 4;
    if (total < 4) throw new Error('velikost nejde trefit');
    const seg = Buffer.alloc(total, 0x41);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(total - 2, 2);
    segments.push(seg);
    remaining -= total;
  }
  const out = Buffer.concat([base.subarray(0, 2), ...segments, base.subarray(2)]);
  if (out.length !== bytes) throw new Error('velikost nesedí');
  return out;
}

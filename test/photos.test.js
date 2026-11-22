import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { stripJpegMetadata } from '../src/media/jpeg.js';
import {
  SECRET_MARKER,
  adminClient,
  approvedUser,
  jpegOfSize,
  jpegWithExif,
  lossyWebp,
  pngWithAlpha,
  startApp,
} from './helpers.js';

const MAX = 20 * 1024 * 1024;

function storedFiles(ctx, id) {
  const dir = path.join(ctx.config.photosDir, id.slice(0, 2));
  return fs.readdirSync(dir).filter((name) => name.startsWith(id)).sort();
}

function allStoredBytes(ctx) {
  const chunks = [];
  for (const dir of fs.readdirSync(ctx.config.photosDir)) {
    for (const name of fs.readdirSync(path.join(ctx.config.photosDir, dir))) {
      chunks.push(fs.readFileSync(path.join(ctx.config.photosDir, dir, name)));
    }
  }
  return Buffer.concat(chunks);
}

describe('fotky', () => {
  let ctx;
  let user;
  let other;
  let admin;
  let taskId;

  before(async () => {
    ctx = await startApp();
    admin = await adminClient(ctx);
    user = await approvedUser(ctx, 'fotograf');
    other = await approvedUser(ctx, 'divak');
    taskId = (await user.post('/api/tasks', { title: 'Úkol s fotkami' })).json.task.id;
  });
  after(() => ctx.stop());

  test('JPEG: náhledy ve WebP, archiv beze ztráty a bez metadat', async () => {
    const input = await jpegWithExif({ width: 640, height: 480, orientation: 6 });
    assert.ok(input.includes(SECRET_MARKER), 'testovací fotka má obsahovat EXIF');

    const res = await user.upload(taskId, input, { filename: '../../zly nazev.jpg' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const photo = res.json.photo;
    assert.match(photo.id, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual([photo.width, photo.height], [480, 640], 'rozměry po otočení podle EXIF');
    assert.match(photo.color, /^#[0-9a-f]{6}$/);

    const row = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(photo.id);
    assert.equal(row.source_format, 'jpeg');
    assert.equal(row.archive_restores_to, 'jpeg');
    assert.equal(row.archive_format, ctx.photos.jxlAvailable ? 'jxl' : 'jpeg');
    assert.ok(row.archive_bytes < input.length, 'archiv je menší než původní soubor');

    const files = storedFiles(ctx, photo.id);
    assert.equal(files.length, 3);
    assert.ok(files.every((name) => !name.includes('zly')), 'název od klienta se nepoužívá');

    // Náhled a zobrazovací verze jsou veřejné, otočené a bez metadat.
    for (const [variant, limit] of [['thumb', 480], ['view', 2000]]) {
      const media = await ctx.client().get(`/media/${photo.id}/${variant}`);
      assert.equal(media.status, 200);
      assert.equal(media.headers['content-type'], 'image/webp');
      assert.match(media.headers['cache-control'], /immutable/);
      assert.equal(media.headers['x-content-type-options'], 'nosniff');
      const meta = await sharp(media.raw).metadata();
      assert.equal(meta.format, 'webp');
      assert.ok(meta.width <= limit && meta.height <= limit);
      assert.ok(meta.height > meta.width, 'fotka je na výšku');
      assert.equal(meta.exif, undefined);
    }

    // Stažený originál je bajt po bajtu očištěný vstup: stejné pixely, žádné GPS.
    const original = await user.get(`/api/photos/${photo.id}/original`);
    assert.equal(original.status, 200);
    assert.equal(original.headers['content-type'], 'image/jpeg');
    assert.match(original.headers['content-disposition'], /^attachment; filename="ukol-\d+-[\w-]{6}\.jpg"$/);
    assert.ok(original.raw.equals(stripJpegMetadata(input, { orientation: 6 })));
    const [before, after] = await Promise.all([sharp(input).raw().toBuffer(), sharp(original.raw).raw().toBuffer()]);
    assert.ok(before.equals(after), 'obrazová data se nezměnila');
    const meta = await sharp(original.raw).metadata();
    assert.equal(meta.orientation, 6, 'orientace zůstala');
    assert.ok(meta.icc, 'barevný profil zůstal');
    assert.ok(!original.raw.includes(SECRET_MARKER));

    assert.ok(!allStoredBytes(ctx).includes(SECRET_MARKER), 'EXIF není v žádném uloženém souboru');
    assert.deepEqual(fs.readdirSync(ctx.config.tmpDir), [], 'dočasné soubory jsou uklizené');
  });

  test('PNG s průhledností: archiv je pixelově shodný a menší', async () => {
    const input = await pngWithAlpha();
    const res = await user.upload(taskId, input, { filename: 'snimek.png', type: 'image/png' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const row = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(res.json.photo.id);
    assert.equal(row.source_format, 'png');
    assert.equal(row.archive_format, ctx.photos.jxlAvailable ? 'jxl' : 'webp');
    assert.ok(row.archive_bytes < input.length);

    const original = await user.get(`/api/photos/${row.id}/original`);
    assert.equal(original.status, 200);
    const [a, b] = await Promise.all([
      sharp(input).raw().toBuffer({ resolveWithObject: true }),
      sharp(original.raw).raw().toBuffer({ resolveWithObject: true }),
    ]);
    assert.equal(b.info.channels, 4);
    assert.ok(a.data.equals(b.data), 'pixely včetně průhlednosti jsou shodné');
    const [ma, mb] = await Promise.all([sharp(input).metadata(), sharp(original.raw).metadata()]);
    assert.ok(ma.icc.equals(mb.icc), 'barevný profil je shodný');
    assert.ok(!original.raw.includes(SECRET_MARKER));
  });

  test('ztrátový WebP zůstane, jak je, jen bez metadat', async () => {
    const input = await lossyWebp();
    const res = await user.upload(taskId, input, { filename: 'obrazek.webp', type: 'image/webp' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const row = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(res.json.photo.id);
    assert.equal(row.archive_format, 'webp');
    assert.ok(row.archive_bytes <= input.length);
    const original = await user.get(`/api/photos/${row.id}/original`);
    assert.ok(!original.raw.includes(SECRET_MARKER));
    const [a, b] = await Promise.all([sharp(input).raw().toBuffer(), sharp(original.raw).raw().toBuffer()]);
    assert.ok(a.equals(b));
  });

  test('typ se určuje z obsahu, ne z názvu ani z hlavičky', async () => {
    const png = await pngWithAlpha({ width: 32, height: 32 });
    const disguised = await user.upload(taskId, png, { filename: 'foto.jpg', type: 'image/jpeg' });
    assert.equal(disguised.status, 201);
    assert.equal(ctx.db.prepare('SELECT source_format FROM photos WHERE id = ?').get(disguised.json.photo.id).source_format, 'png');
  });

  test('jiné soubory než JPEG, PNG a WebP se odmítnou', async () => {
    const tiny = { create: { width: 16, height: 16, channels: 3, background: '#c0392b' } };
    const rejected = {
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'),
      gif: await sharp(tiny).gif().toBuffer(),
      tiff: await sharp(tiny).tiff().toBuffer(),
      avif: await sharp(tiny).avif().toBuffer(),
      html: Buffer.from('<!doctype html><script>alert(1)</script>'),
      text: Buffer.from('obycejny text'),
      pdf: Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'),
      exe: Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'),
      animated: await sharp(Buffer.from(Array.from({ length: 16 * 32 * 3 }, (_, i) => (i * 37) % 255)), {
        raw: { width: 16, height: 32, channels: 3, pageHeight: 16 },
      })
        .webp({ loop: 0, delay: [100, 100] })
        .toBuffer(),
    };
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
    for (const [name, data] of Object.entries(rejected)) {
      const res = await user.upload(taskId, data, { filename: 'foto.jpg', type: 'image/jpeg' });
      assert.equal(res.status, 415, `${name}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.error.code, 'unsupported_type', name);
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, before);
    assert.deepEqual(fs.readdirSync(ctx.config.tmpDir), []);
  });

  test('poškozené a podvržené obrázky se odmítnou a nic po nich nezůstane', async () => {
    const jpeg = await jpegWithExif({ width: 200, height: 200, orientation: 1 });
    const broken = {
      empty: Buffer.alloc(0),
      'jen hlavička JPEG': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      'useknutý JPEG': jpeg.subarray(0, Math.floor(jpeg.length / 3)),
      'jen hlavička PNG': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      'falešný WebP': Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBP', 'latin1'), Buffer.alloc(16, 1)]),
    };
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
    const filesBefore = allStoredBytes(ctx).length;
    for (const [name, data] of Object.entries(broken)) {
      const res = await user.upload(taskId, data);
      assert.ok([400, 415, 422].includes(res.status), `${name} → ${res.status}`);
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, before);
    assert.equal(allStoredBytes(ctx).length, filesBefore);
    assert.deepEqual(fs.readdirSync(ctx.config.tmpDir), []);
  });

  test('obrázek s obřím rozlišením se odmítne dřív, než zabere paměť', async () => {
    const small = await startApp({ maxImagePixels: 1_000_000 });
    const u = await approvedUser(small, 'bombarder');
    const id = (await u.post('/api/tasks', { title: 't' })).json.task.id;
    const bomb = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#000' } }).png().toBuffer();
    assert.ok(bomb.length < 100_000, 'malý soubor, hodně pixelů');
    const res = await u.upload(id, bomb, { type: 'image/png' });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'too_many_pixels');
    await small.stop();
  });

  test('limit 20 MB: přesně na hraně projde, o bajt víc ne', async () => {
    const exact = await jpegOfSize(MAX);
    assert.equal(exact.length, MAX);
    const ok = await user.upload(taskId, exact);
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const row = ctx.db.prepare('SELECT source_bytes, archive_bytes FROM photos WHERE id = ?').get(ok.json.photo.id);
    assert.equal(row.source_bytes, MAX);
    assert.ok(row.archive_bytes < 100_000, 'výplň z komentářů se do archivu nedostala');

    const over = await user.upload(taskId, await jpegOfSize(MAX + 1));
    assert.equal(over.status, 413, JSON.stringify(over.json));
    assert.equal(over.json.error.code, 'too_large');
    assert.deepEqual(fs.readdirSync(ctx.config.tmpDir), []);
  });

  test('požadavek bez fotky, s jiným polem nebo s více soubory se odmítne', async () => {
    const jpeg = await jpegWithExif({ width: 64, height: 64, orientation: 1 });
    assert.equal((await user.upload(taskId, jpeg, { field: 'soubor' })).status, 400);
    assert.equal((await user.post(`/api/tasks/${taskId}/photos`, { photo: 'text' })).status, 400);
    assert.equal((await user.upload(999999, jpeg)).status, 404);

    const boundary = '----dva';
    const partFor = () =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        jpeg,
        Buffer.from('\r\n'),
      ]);
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
    const two = await user.request('POST', `/api/tasks/${taskId}/photos`, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([partFor(), partFor(), Buffer.from(`--${boundary}--\r\n`)]),
    });
    assert.ok(two.status === 201 || two.status === 413 || two.status === 400);
    assert.ok(ctx.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n - before <= 1, 'uloží se nejvýš jedna fotka');
  });

  test('originál si stáhne jen přihlášený člen', async () => {
    const id = ctx.db.prepare('SELECT id FROM photos LIMIT 1').get().id;
    assert.equal((await ctx.client().get(`/api/photos/${id}/original`)).status, 401);
    assert.equal((await other.get(`/api/photos/${id}/original`)).status, 200);
    assert.equal((await other.get('/api/photos/AAAAAAAAAAAAAAAAAAAAAA/original')).status, 404);
    assert.equal((await other.get('/api/photos/..%2F..%2Fukoly.db/original')).status, 400);
  });

  test('neexistující náhled vrací 404 a neukládá se do mezipaměti', async () => {
    const c = ctx.client();
    const missing = await c.get('/media/AAAAAAAAAAAAAAAAAAAAAA/thumb');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['cache-control'], 'no-store');
    assert.equal((await c.get('/media/AAAAAAAAAAAAAAAAAAAAAA/orig')).status, 400);
    assert.equal((await c.get('/media/kratke/thumb')).status, 400);
  });

  test('mazání fotky: autor a správce ano, ostatní ne; soubory zmizí', async () => {
    const jpeg = await jpegWithExif({ width: 64, height: 64, orientation: 1 });
    const first = (await user.upload(taskId, jpeg)).json.photo.id;
    const second = (await user.upload(taskId, jpeg)).json.photo.id;
    assert.equal(storedFiles(ctx, first).length, 3);

    assert.equal((await other.delete(`/api/photos/${first}`)).status, 403);
    assert.equal(storedFiles(ctx, first).length, 3);
    assert.equal((await user.delete(`/api/photos/${first}`)).status, 200);
    assert.equal(storedFiles(ctx, first).length, 0);
    assert.equal((await ctx.client().get(`/media/${first}/thumb`)).status, 404);
    assert.equal((await user.delete(`/api/photos/${first}`)).status, 404);

    assert.equal((await admin.delete(`/api/photos/${second}`)).status, 200);
    assert.equal(storedFiles(ctx, second).length, 0);
  });

  test('smazání úkolu smaže i soubory jeho fotek', async () => {
    const id = (await user.post('/api/tasks', { title: 'Dočasný' })).json.task.id;
    const jpeg = await jpegWithExif({ width: 64, height: 64, orientation: 1 });
    const photoId = (await user.upload(id, jpeg)).json.photo.id;
    assert.equal(storedFiles(ctx, photoId).length, 3);
    assert.equal((await user.delete(`/api/tasks/${id}`)).status, 200);
    assert.equal(storedFiles(ctx, photoId).length, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE task_id = ?').get(id).n, 0);
  });

  test('počet fotek u úkolu má strop', async () => {
    const capped = await startApp({ maxPhotosPerTask: 2 });
    const u = await approvedUser(capped, 'sberatel');
    const id = (await u.post('/api/tasks', { title: 't' })).json.task.id;
    const jpeg = await jpegWithExif({ width: 64, height: 64, orientation: 1 });
    assert.equal((await u.upload(id, jpeg)).status, 201);
    assert.equal((await u.upload(id, jpeg)).status, 201);
    const third = await u.upload(id, jpeg);
    assert.equal(third.status, 409);
    assert.equal(third.json.error.code, 'too_many_photos');
    await capped.stop();
  });

  test('seznam úkolů uvádí počet fotek a titulní fotku', async () => {
    const list = (await ctx.client().get('/api/tasks')).json;
    const item = list.columns.todo.tasks.find((t) => t.id === taskId);
    assert.ok(item.photoCount >= 3);
    assert.match(item.cover.id, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(item.cover.width > 0 && item.cover.height > 0);
  });
});

describe('fotky bez JPEG XL (záložní cesta)', () => {
  let ctx;
  let user;
  let taskId;
  before(async () => {
    ctx = await startApp({ jxlEnabled: false });
    user = await approvedUser(ctx, 'zalozni');
    taskId = (await user.post('/api/tasks', { title: 't' })).json.task.id;
  });
  after(() => ctx.stop());

  test('JPEG se uloží očištěný, PNG jako bezeztrátový WebP', async () => {
    assert.equal(ctx.photos.jxlAvailable, false);
    const jpeg = await jpegWithExif();
    const a = (await user.upload(taskId, jpeg)).json.photo.id;
    const rowA = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(a);
    assert.equal(rowA.archive_format, 'jpeg');
    const originalA = await user.get(`/api/photos/${a}/original`);
    assert.ok(originalA.raw.equals(stripJpegMetadata(jpeg, { orientation: 6 })));

    const png = await pngWithAlpha();
    const b = (await user.upload(taskId, png, { type: 'image/png' })).json.photo.id;
    const rowB = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(b);
    assert.equal(rowB.archive_format, 'webp');
    const originalB = await user.get(`/api/photos/${b}/original`);
    assert.equal(originalB.headers['content-type'], 'image/webp');
    const [x, y] = await Promise.all([sharp(png).raw().toBuffer(), sharp(originalB.raw).raw().toBuffer()]);
    assert.ok(x.equals(y));
    assert.ok(!allStoredBytes(ctx).includes(SECRET_MARKER));
  });
});

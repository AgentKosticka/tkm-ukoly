import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { moveFile } from '../src/media/store.js';
import { approvedUser, jpegWithExif, startApp } from './helpers.js';

function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const scratch = (base = os.tmpdir()) => fs.mkdtempSync(path.join(base, 'ukoly-uloziste-'));

/**
 * Složka na jiném souborovém systému než dočasná složka testů, pokud nějaká
 * je. Jen mezi dvěma systémy se pozná, že přesun souboru nespoléhá na
 * přejmenování.
 */
function otherFilesystem() {
  const home = fs.statSync(os.tmpdir()).dev;
  for (const base of ['/dev/shm', process.cwd(), os.homedir()]) {
    try {
      if (fs.statSync(base).dev === home) continue;
      fs.accessSync(base, fs.constants.W_OK);
      return base;
    } catch {
      // Tahle složka neexistuje nebo do ní nejde psát.
    }
  }
  return null;
}

const files = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((name) => fs.statSync(path.join(dir, name)).isFile()) : [];

describe('složka pro fotky', () => {
  test('běžně je u ostatních dat, PHOTOS_DIR ji umístí jinam', () => {
    const base = withEnv({ DATA_DIR: '/srv/data', PHOTOS_DIR: undefined, PHOTOS_HOST_DIR: undefined }, loadConfig);
    assert.equal(base.photosDir, '/srv/data/photos');
    assert.equal(base.photosHostDir, null);

    // Compose předává prázdnou hodnotu, když PHOTOS_DIR v .env chybí.
    const empty = withEnv({ DATA_DIR: '/srv/data', PHOTOS_DIR: '', PHOTOS_HOST_DIR: '' }, loadConfig);
    assert.equal(empty.photosDir, '/srv/data/photos');
    assert.equal(empty.photosHostDir, null);

    const moved = withEnv({ DATA_DIR: '/srv/data', PHOTOS_DIR: '/photos', PHOTOS_HOST_DIR: '/mnt/disk/fotky' }, loadConfig);
    assert.equal(moved.photosDir, '/photos');
    assert.equal(moved.photosHostDir, '/mnt/disk/fotky');
    // Dočasné soubory, databáze i zálohy zůstávají u dat.
    assert.equal(moved.tmpDir, '/srv/data/tmp');
    assert.equal(moved.dbFile, '/srv/data/ukoly.db');
    assert.equal(moved.backupDir, '/srv/data/backups');
  });

  test('síťový disk: PHOTOS_SUBDIR je cesta uvnitř místní složky PHOTOS_DIR', () => {
    const env = { DATA_DIR: '/srv/data', PHOTOS_DIR: '/photos', PHOTOS_HOST_DIR: '/srv/ukolnicek' };
    const nas = withEnv({ ...env, PHOTOS_SUBDIR: 'nas/fotky' }, loadConfig);
    assert.equal(nas.photosDir, '/photos/nas/fotky');
    assert.equal(nas.photosRoot, '/photos');
    assert.equal(nas.photosHostDir, '/srv/ukolnicek/nas/fotky');

    const plain = withEnv({ ...env, PHOTOS_SUBDIR: '' }, loadConfig);
    assert.equal(plain.photosDir, '/photos');
    assert.equal(plain.photosRoot, null);

    for (const value of ['/nas', '../jinam', 'nas/../..', 'nas//fotky', 'nas/', './nas']) {
      assert.throws(() => withEnv({ ...env, PHOTOS_SUBDIR: value }, loadConfig), /PHOTOS_SUBDIR v souboru \.env musí být cesta uvnitř/, value);
    }
    assert.throws(
      () => withEnv({ DATA_DIR: '/srv/data', PHOTOS_DIR: '', PHOTOS_HOST_DIR: '', PHOTOS_SUBDIR: 'nas' }, loadConfig),
      /jen spolu s PHOTOS_DIR/,
    );
  });

  test('poměrná cesta v .env se odmítne', () => {
    for (const value of ['./fotky', '../fotky', 'fotky', '~/fotky']) {
      assert.throws(
        () => withEnv({ PHOTOS_DIR: '/photos', PHOTOS_HOST_DIR: value }, loadConfig),
        /PHOTOS_DIR v souboru \.env musí být celá cesta/,
        value,
      );
    }
  });

  test('fotky se ukládají jen do zvolené složky a jdou z ní zobrazit i stáhnout', async () => {
    const photosDir = scratch(otherFilesystem() ?? os.tmpdir());
    const ctx = await startApp({ photosDir });
    try {
      const user = await approvedUser(ctx, 'jinam');
      const taskId = (await user.post('/api/tasks', { title: 't' })).json.task.id;
      const upload = await user.upload(taskId, await jpegWithExif({ width: 2000, height: 1500 }));
      assert.equal(upload.status, 201);
      const { id } = upload.json.photo;

      const stored = files(photosDir);
      assert.equal(stored.length, 3, 'archiv, zobrazovací verze a náhled');
      assert.ok(stored.every((name) => path.basename(name).startsWith(`${id}.`)));
      // Archiv v JPEG XL vzniká v dočasné složce a do složky fotek se přesouvá.
      if (ctx.photos.jxlAvailable) assert.ok(stored.some((name) => name.endsWith('.orig.jxl')), stored.join(', '));
      assert.deepEqual(files(path.join(ctx.config.dataDir, 'photos')), [], 'u ostatních dat žádná fotka není');
      assert.deepEqual(files(ctx.config.tmpDir), [], 'po zpracování nezůstal dočasný soubor');

      assert.equal((await ctx.client().get(`/media/${id}/thumb`)).status, 200);
      assert.equal((await ctx.client().get(`/media/${id}/view`)).status, 200);
      assert.equal((await user.get(`/api/photos/${id}/original`)).status, 200);

      assert.equal((await user.delete(`/api/photos/${id}`)).status, 200);
      assert.deepEqual(files(photosDir), []);
    } finally {
      await ctx.stop();
      fs.rmSync(photosDir, { recursive: true, force: true });
    }
  });

  test('složka, do které nejde zapisovat, zastaví start se srozumitelnou chybou', { skip: process.getuid?.() === 0 }, async () => {
    const photosDir = scratch();
    fs.chmodSync(photosDir, 0o500);
    try {
      await assert.rejects(
        startApp({ photosDir, photosHostDir: '/mnt/disk/fotky' }),
        (err) => {
          assert.match(err.message, /Do složky pro fotky \/mnt\/disk\/fotky nejde zapisovat/);
          assert.match(err.message, new RegExp(`chown -R ${process.getuid()}:${process.getgid()} /mnt/disk/fotky`));
          return true;
        },
      );
    } finally {
      fs.chmodSync(photosDir, 0o700);
      fs.rmSync(photosDir, { recursive: true, force: true });
    }
  });

  test('nedostupné úložiště start nezastaví; úkoly fungují a nahrání fotky ohlásí výpadek', async () => {
    // Příliš dlouhé jméno složky dá chybu, která není chybou oprávnění,
    // stejně jako síťový disk mimo provoz.
    const photosDir = path.join(scratch(), 'x'.repeat(300));
    const ctx = await startApp({ photosDir });
    try {
      assert.equal(ctx.photos.storageReady, false);
      const user = await approvedUser(ctx, 'vypadek');
      const created = await user.post('/api/tasks', { title: 'bez fotek to jde dál' });
      assert.equal(created.status, 201);
      const taskId = created.json.task.id;
      assert.equal((await ctx.client().get('/api/tasks')).status, 200);

      const upload = await user.upload(taskId, await jpegWithExif());
      assert.equal(upload.status, 503);
      assert.equal(upload.json.error.code, 'storage_unavailable');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM photos').pluck().get(), 0, 'do databáze se nic nezapsalo');
      assert.deepEqual(files(ctx.config.tmpDir), [], 'po neúspěchu nezůstal dočasný soubor');
      // Fotka, kterou databáze zná, ale úložiště ji nevydá, je pro prohlížeč 404.
      assert.equal((await ctx.client().get('/media/AAAAAAAAAAAAAAAAAAAAAA/thumb')).status, 404);
    } finally {
      await ctx.stop();
      fs.rmSync(path.dirname(photosDir), { recursive: true, force: true });
    }
  });

  test('úložiště, které neodpovídá, start jen zdrží o časový limit', async () => {
    const log = [];
    const { createPhotoStore } = await import('../src/media/store.js');
    const dir = scratch();
    const photosDir = path.join(dir, 'fotky');
    fs.mkdirSync(photosDir);
    const started = Date.now();
    const config = { ...loadConfig(), photosDir, tmpDir: path.join(dir, 'tmp'), photosProbeMs: 50, jxlEnabled: false };
    // Zápis, který nikdy neskončí, se chová jako disk, který neodpovídá.
    const original = fs.promises.writeFile;
    fs.promises.writeFile = () => new Promise(() => {});
    try {
      const store = await createPhotoStore(config, { info() {}, warn() {}, error: (message) => log.push(message) });
      assert.equal(store.storageReady, false);
      assert.ok(Date.now() - started < 5000);
      assert.equal(log.length, 1);
      assert.match(log[0], /teď není dostupná \(ETIMEDOUT\)/);
    } finally {
      fs.promises.writeFile = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Připojení disku tu zastupuje symbolický odkaz na jiný souborový systém:
  // pro aplikaci je rozhodující jen to, že složka leží na jiném zařízení.
  test(
    'síťový disk, který není připojený: aplikace běží, nic nezapíše vedle a po připojení se rozběhne sama',
    { skip: otherFilesystem() ? false : 'k dispozici je jen jeden souborový systém' },
    async () => {
      const root = scratch();
      const disk = scratch(otherFilesystem());
      const mountpoint = path.join(root, 'nas');
      // Prázdné místo pro připojení, do kterého aplikace zapisovat smí. I tak
      // do něj nic uložit nesmí.
      fs.mkdirSync(mountpoint);
      const errors = [];
      const logger = { level: 'error', stream: { write: (line) => errors.push(JSON.parse(line).msg) } };
      const ctx = await startApp({ photosRoot: root, photosDir: path.join(mountpoint, 'fotky'), photosHostDir: '/srv/ukolnicek/nas/fotky', photosRetryMs: 100, logger });
      try {
        assert.equal(ctx.photos.storageReady, false);
        assert.ok(errors.some((m) => /\/srv\/ukolnicek\/nas\/fotky teď není dostupná \(úložiště není připojené\)/.test(m)), errors.join('\n'));
        const user = await approvedUser(ctx, 'odpojeno');
        const taskId = (await user.post('/api/tasks', { title: 't' })).json.task.id;
        const jpeg = await jpegWithExif();

        const refused = await user.upload(taskId, jpeg);
        assert.equal(refused.status, 503);
        assert.equal(refused.json.error.code, 'storage_unavailable');
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal((await user.upload(taskId, jpeg)).status, 503, 'ani po zkušebním intervalu se nezapisuje mimo disk');
        assert.deepEqual(files(root), [], 'na místním disku nevznikl žádný soubor');
        assert.deepEqual(fs.readdirSync(mountpoint), []);

        // „Připojení disku“ za běhu aplikace.
        fs.rmdirSync(mountpoint);
        fs.symlinkSync(disk, mountpoint);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const stored = await user.upload(taskId, jpeg);
        assert.equal(stored.status, 201);
        assert.ok(files(disk).length > 0, 'fotka je na připojeném disku');
        assert.equal((await ctx.client().get(`/media/${stored.json.photo.id}/thumb`)).status, 200);
      } finally {
        await ctx.stop();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(disk, { recursive: true, force: true });
      }
    },
  );

  test('chybějící soubory k fotkám z databáze se spočítají', async () => {
    const ctx = await startApp();
    try {
      const user = await approvedUser(ctx, 'pocitani');
      const taskId = (await user.post('/api/tasks', { title: 't' })).json.task.id;
      const ids = [];
      for (let i = 0; i < 2; i += 1) ids.push((await user.upload(taskId, await jpegWithExif())).json.photo.id);
      assert.equal(await ctx.photos.countMissing(ids), 0);
      // Stejný stav jako po přesměrování složky bez zkopírování souborů.
      fs.rmSync(ctx.config.photosDir, { recursive: true, force: true });
      assert.equal(await ctx.photos.countMissing(ids), 2);
      assert.equal(await ctx.photos.countMissing([]), 0);
    } finally {
      await ctx.stop();
    }
  });
});

describe('přesun souboru', () => {
  test('přesune soubor a existující cíl nepřepíše', async () => {
    const dir = scratch();
    try {
      const source = path.join(dir, 'zdroj');
      const target = path.join(dir, 'cil');
      fs.writeFileSync(source, 'obsah');
      await moveFile(source, target);
      assert.equal(fs.readFileSync(target, 'utf8'), 'obsah');
      assert.equal(fs.existsSync(source), false);

      fs.writeFileSync(source, 'jiny');
      await assert.rejects(moveFile(source, target), { code: 'EEXIST' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'obsah');
      assert.equal(fs.readFileSync(source, 'utf8'), 'jiny', 'zdroj zůstal na místě');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('funguje i mezi dvěma disky', { skip: otherFilesystem() ? false : 'k dispozici je jen jeden souborový systém' }, async () => {
    const here = scratch();
    const there = scratch(otherFilesystem());
    try {
      const source = path.join(here, 'zdroj');
      const target = path.join(there, 'cil');
      fs.writeFileSync(source, 'obsah');
      // Ověří předpoklad testu: obyčejné přejmenování tu opravdu selže.
      assert.throws(() => fs.renameSync(source, target), { code: 'EXDEV' });
      await moveFile(source, target);
      assert.equal(fs.readFileSync(target, 'utf8'), 'obsah');
      assert.equal(fs.existsSync(source), false);

      fs.writeFileSync(source, 'jiny');
      await assert.rejects(moveFile(source, target), { code: 'EEXIST' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'obsah');
    } finally {
      fs.rmSync(here, { recursive: true, force: true });
      fs.rmSync(there, { recursive: true, force: true });
    }
  });
});

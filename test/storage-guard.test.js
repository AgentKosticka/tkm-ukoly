import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { createStorageGuard } from '../src/util/storage-guard.js';
import { approvedUser, jpegWithExif, startApp } from './helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const fail = (code) => () => Promise.reject(Object.assign(new Error(code), { code }));
const unavailable = { statusCode: 503, code: 'storage_unavailable' };

function guardWithClock(options = {}) {
  const clock = { now: 1_000_000 };
  const log = { errors: [], infos: [] };
  const guard = createStorageGuard({
    timeoutMs: 40,
    retryMs: 30_000,
    now: () => clock.now,
    log: { error: (m) => log.errors.push(m), info: (m) => log.infos.push(m) },
    ...options,
  });
  return { guard, clock, log };
}

describe('pojistka úložiště fotek', () => {
  test('běžná operace projde a její chyby se propouštějí beze změny', async () => {
    const { guard, log } = guardWithClock();
    assert.equal(await guard.run(async () => 'ok'), 'ok');
    await assert.rejects(guard.run(fail('ENOENT')), { code: 'ENOENT' });
    await assert.rejects(guard.run(fail('EACCES')), { code: 'EACCES' });
    assert.equal(guard.down, false, 'chybějící soubor ani chyba oprávnění nejsou výpadek');
    assert.equal(await guard.run(async () => 'pořád ok'), 'pořád ok');
    assert.deepEqual(log.errors, []);
  });

  test('operace bez odpovědi skončí po limitu a úložiště se označí za nedostupné', async () => {
    const { guard, log } = guardWithClock();
    const started = Date.now();
    await assert.rejects(guard.run(never), unavailable);
    assert.ok(Date.now() - started < 1000, 'volající nečeká déle než limit');
    assert.equal(guard.down, true);
    assert.equal(log.errors.length, 1);
    assert.match(log.errors[0], /Úložiště fotek neodpovídá/);
  });

  test('chyby síťového disku označí úložiště za nedostupné', async () => {
    for (const code of ['EHOSTDOWN', 'EIO', 'ENOTCONN', 'ESTALE', 'ECONNABORTED', 'EAGAIN']) {
      const { guard } = guardWithClock();
      await assert.rejects(guard.run(fail(code)), unavailable, code);
      assert.equal(guard.down, true, code);
    }
  });

  test('při výpadku se odmítá hned a na úložiště se nesahá', async () => {
    const { guard } = guardWithClock();
    await assert.rejects(guard.run(fail('EHOSTDOWN')), unavailable);
    let touched = 0;
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) {
      await assert.rejects(guard.run(async () => { touched += 1; }), unavailable);
    }
    assert.equal(touched, 0);
    assert.ok(Date.now() - started < 2000, 'odmítnutí je okamžité');
  });

  test('po čase projde jediný zkušební požadavek; úspěch úložiště vrátí do provozu', async () => {
    const { guard, clock, log } = guardWithClock();
    await assert.rejects(guard.run(fail('EHOSTDOWN')), unavailable);
    clock.now += 29_000;
    await assert.rejects(guard.run(async () => 'příliš brzy'), unavailable);

    clock.now += 2_000;
    let release;
    let touched = 0;
    const probe = guard.run(() => new Promise((resolve) => { touched += 1; release = resolve; }));
    await sleep(5);
    // Dokud zkouška běží, ostatní se odmítají a na úložiště nesahají.
    await assert.rejects(guard.run(async () => { touched += 1; }), unavailable);
    assert.equal(touched, 1);
    release('zpátky');
    assert.equal(await probe, 'zpátky');
    assert.equal(guard.down, false);
    assert.deepEqual(log.infos, ['Úložiště fotek je zpátky']);
    assert.equal(await guard.run(async () => 'běžný provoz'), 'běžný provoz');
  });

  test('neúspěšná zkouška prodlouží výpadek a nehlásí ho znovu', async () => {
    const { guard, clock, log } = guardWithClock();
    await assert.rejects(guard.run(fail('EHOSTDOWN')), unavailable);
    clock.now += 31_000;
    await assert.rejects(guard.run(never), unavailable);
    assert.equal(guard.down, true);
    await assert.rejects(guard.run(async () => 'hned po zkoušce'), unavailable);
    assert.equal(log.errors.length, 1, 'výpadek se do logu zapíše jednou');
    // Další zkouška přijde až po dalším intervalu.
    clock.now += 31_000;
    assert.equal(await guard.run(async () => 'ok'), 'ok');
  });

  test('uvízlé operace drží nejvýš dvě místa, i když volající dávno odešli', async () => {
    const { guard, clock } = guardWithClock();
    let started = 0;
    const releases = [];
    const hang = () => new Promise((resolve) => { started += 1; releases.push(resolve); });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => guard.run(hang)));
    assert.ok(results.every((r) => r.status === 'rejected' && r.reason.code === 'storage_unavailable'));
    assert.equal(started, 2, 'na úložiště sáhly jen dvě operace');
    assert.equal(guard.busy, 2);

    // Zkouška po intervalu čeká na volné místo a taky skončí limitem.
    clock.now += 31_000;
    await assert.rejects(guard.run(hang), unavailable);
    assert.equal(started, 2, 'dokud místa drží uvízlé operace, další se nespustí');

    // Uvízlé operace nakonec skončí; místa se uvolní a úložiště se vrátí.
    for (const release of releases) release();
    await sleep(5);
    assert.equal(guard.busy, 0);
    clock.now += 31_000;
    assert.equal(await guard.run(async () => 'ok'), 'ok');
    assert.equal(guard.down, false);
  });

  test('vlastní limit operace má přednost před výchozím', async () => {
    const { guard } = guardWithClock({ timeoutMs: 5 });
    assert.equal(await guard.run(() => sleep(30).then(() => 'pomalý zápis'), { timeout: 500 }), 'pomalý zápis');
  });
});

describe('výpadek úložiště za běhu', () => {
  test('fotky hlásí výpadek hned, zbytek aplikace běží a po návratu se fotky zase načtou', async () => {
    // Limity jsou krátké, ale s rezervou: skutečné čtení malého souboru se do
    // nich musí vejít i na vytíženém stroji.
    const ctx = await startApp({ photosTimeoutMs: 500, photosRetryMs: 300, jxlEnabled: false });
    const real = { readFile: fs.promises.readFile, stat: fs.promises.stat, writeFile: fs.promises.writeFile, mkdir: fs.promises.mkdir };
    const inPhotos = (file) => String(file).startsWith(ctx.config.photosDir);
    const hung = [];
    const breakStorage = () => {
      // Všechno ve složce pro fotky od teď visí, jako síťový disk bez odpovědi.
      const hang = () => new Promise((_, reject) => hung.push(reject));
      for (const name of Object.keys(real)) {
        fs.promises[name] = (file, ...rest) => (inPhotos(file) ? hang() : real[name](file, ...rest));
      }
    };
    const restoreStorage = () => {
      Object.assign(fs.promises, real);
      // Uvízlé operace nakonec skončí chybou, jak to dělá i skutečný disk.
      for (const reject of hung.splice(0)) reject(Object.assign(new Error('EHOSTDOWN'), { code: 'EHOSTDOWN' }));
    };
    try {
      const user = await approvedUser(ctx, 'zabeh');
      const taskId = (await user.post('/api/tasks', { title: 't' })).json.task.id;
      const jpeg = await jpegWithExif({ width: 2000, height: 1500 });
      const id = (await user.upload(taskId, jpeg)).json.photo.id;
      const ok = await ctx.client().get(`/media/${id}/thumb`);
      assert.equal(ok.status, 200);
      assert.match(ok.headers['cache-control'], /immutable/);

      breakStorage();
      let started = Date.now();
      const first = await ctx.client().get(`/media/${id}/thumb`);
      assert.equal(first.status, 503);
      assert.equal(first.json.error.code, 'storage_unavailable');
      assert.equal(first.headers['cache-control'], 'no-store', 'výpadek se nesmí uložit do mezipaměti');
      assert.ok(Date.now() - started < 5000);

      // Další požadavky na fotky se odmítají hned.
      started = Date.now();
      for (const variant of ['thumb', 'view', 'thumb', 'view']) {
        assert.equal((await ctx.client().get(`/media/${id}/${variant}`)).status, 503);
      }
      assert.equal((await user.get(`/api/photos/${id}/original`)).status, 503);
      const upload = await user.upload(taskId, jpeg);
      assert.equal(upload.status, 503);
      assert.equal(upload.json.error.code, 'storage_unavailable');
      assert.ok(Date.now() - started < 5000, 'při výpadku nic nečeká na limit');

      // Úkoly, stránka i statické soubory fungují dál.
      assert.equal((await ctx.client().get('/api/tasks')).status, 200);
      assert.equal((await user.post('/api/tasks', { title: 'i při výpadku' })).status, 201);
      assert.equal((await ctx.client().get('/css/base.css')).status, 200);
      assert.equal((await ctx.client().get('/api/health')).status, 200);

      // Smazání fotky při výpadku projde; soubory zůstanou na disku.
      assert.equal((await user.delete(`/api/photos/${id}`)).status, 200);

      // Po návratu úložiště a uplynutí zkušebního intervalu se vše rozběhne samo.
      restoreStorage();
      await sleep(450);
      const back = await user.upload(taskId, jpeg);
      assert.equal(back.status, 201);
      assert.equal((await ctx.client().get(`/media/${back.json.photo.id}/view`)).status, 200);
    } finally {
      restoreStorage();
      await ctx.stop();
    }
  });
});

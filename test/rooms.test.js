import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { migrations, openDatabase } from '../src/db.js';
import { PASSWORD, adminClient, approvedUser, startApp } from './helpers.js';

describe('místnosti', () => {
  let ctx;
  let admin;
  let member;
  const rooms = {};

  before(async () => {
    ctx = await startApp();
    admin = await adminClient(ctx);
    member = await approvedUser(ctx, 'clenka');
  });
  after(() => ctx.stop());

  test('zakládat, přejmenovat a mazat místnosti smí jen správce', async () => {
    const anonymous = ctx.client();
    const attempts = (client) => [
      client.post('/api/admin/rooms', { name: 'Tajná' }),
      client.patch('/api/admin/rooms/1', { name: 'Jiná' }),
      client.delete('/api/admin/rooms/1'),
      client.get('/api/admin/rooms'),
    ];
    for (const res of await Promise.all(attempts(anonymous))) assert.equal(res.status, 401);
    for (const res of await Promise.all(attempts(member))) assert.equal(res.status, 403);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 0);
  });

  test('správce založí místnosti; seznam je veřejný a seřazený podle názvu', async () => {
    for (const name of ['Robotika', '  3D   tisk ', 'Šicí dílna', 'Dílna']) {
      const res = await admin.post('/api/admin/rooms', { name });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      rooms[res.json.room.name] = res.json.room.id;
    }
    assert.deepEqual(Object.keys(rooms).sort(), ['3D tisk', 'Dílna', 'Robotika', 'Šicí dílna'], 'mezery v názvu se srovnají');

    const visitor = await ctx.client().get('/api/rooms');
    assert.equal(visitor.status, 200);
    assert.deepEqual(visitor.json.rooms.map((r) => r.name), ['3D tisk', 'Dílna', 'Robotika', 'Šicí dílna']);
    assert.deepEqual(Object.keys(visitor.json.rooms[0]).sort(), ['id', 'name']);
  });

  test('název musí být vyplněný, rozumně dlouhý a jedinečný bez ohledu na velikost písmen', async () => {
    const cases = [
      ['', 'invalid_room_name'],
      ['   ', 'invalid_room_name'],
      ['x'.repeat(41), 'invalid_room_name'],
      ['Obecné', 'invalid_room_name'],
      ['VŠE', 'invalid_room_name'],
      ['robotika', 'room_exists'],
      ['ŠICÍ DÍLNA', 'room_exists'],
      ['šicí  dílna', 'room_exists'],
    ];
    for (const [name, code] of cases) {
      const res = await admin.post('/api/admin/rooms', { name });
      assert.ok(res.status === 400 || res.status === 409, `${name} → ${res.status}`);
      assert.equal(res.json.error.code, code, name);
    }
    assert.equal((await admin.post('/api/admin/rooms', {})).status, 400);
    assert.equal((await admin.post('/api/admin/rooms', { name: 'Sklad', id: 99 })).status, 400);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 4);
  });

  test('název se ukládá doslova, bez interpretace HTML', async () => {
    const res = await admin.post('/api/admin/rooms', { name: '<b>Sklad</b>' });
    assert.equal(res.status, 201);
    assert.equal(res.json.room.name, '<b>Sklad</b>');
    assert.equal((await admin.delete(`/api/admin/rooms/${res.json.room.id}`)).status, 200);
  });

  test('přejmenování hlídá kolize, vlastní název se změnou velikosti písmen projde', async () => {
    const id = rooms.Robotika;
    assert.equal((await admin.patch(`/api/admin/rooms/${id}`, { name: 'Dílna' })).json.error.code, 'room_exists');
    const same = await admin.patch(`/api/admin/rooms/${id}`, { name: 'ROBOTIKA' });
    assert.equal(same.status, 200);
    const renamed = await admin.patch(`/api/admin/rooms/${id}`, { name: 'Robotika a elektronika' });
    assert.equal(renamed.json.room.name, 'Robotika a elektronika');
    assert.equal((await admin.patch('/api/admin/rooms/99999', { name: 'Nic' })).status, 404);
    await admin.patch(`/api/admin/rooms/${id}`, { name: 'Robotika' });
  });

  test('úkol jde založit v místnosti a přesunout; přesun je v historii', async () => {
    const created = await member.post('/api/tasks', { title: 'Nabít roboty', roomId: rooms.Robotika });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.task.roomId, rooms.Robotika);

    const plain = await member.post('/api/tasks', { title: 'Zamést chodbu' });
    assert.equal(plain.json.task.roomId, null, 'bez místnosti patří do Obecné');

    const moved = await member.patch(`/api/tasks/${plain.json.task.id}`, { roomId: rooms['Dílna'] });
    assert.equal(moved.json.task.roomId, rooms['Dílna']);
    assert.deepEqual(
      moved.json.task.events.map((e) => [e.type, e.note]),
      [['room', 'Dílna'], ['created', undefined]],
    );

    const back = await member.patch(`/api/tasks/${plain.json.task.id}`, { roomId: null });
    assert.equal(back.json.task.roomId, null);
    assert.deepEqual(back.json.task.events[0], { id: back.json.task.events[0].id, type: 'room', note: null, at: back.json.task.events[0].at, user: 'clenka' });

    const same = await member.patch(`/api/tasks/${plain.json.task.id}`, { roomId: null });
    assert.equal(same.json.task.events.length, back.json.task.events.length, 'stejná místnost nic nezapíše');
  });

  test('neexistující nebo nesmyslná místnost se odmítne', async () => {
    const id = (await member.post('/api/tasks', { title: 'Vzor' })).json.task.id;
    for (const roomId of [99999, 0, -1, 1.5, 'abc', [1], {}]) {
      const res = await member.patch(`/api/tasks/${id}`, { roomId });
      assert.equal(res.status, 400, JSON.stringify(roomId));
      const create = await member.post('/api/tasks', { title: 'x', roomId });
      assert.equal(create.status, 400, JSON.stringify(roomId));
    }
    assert.equal((await member.patch(`/api/tasks/${id}`, { roomId: 99999 })).json.error.code, 'invalid_room');
    assert.equal(ctx.db.prepare('SELECT room_id FROM tasks WHERE id = ?').get(id).room_id, null);
    assert.equal((await ctx.client().patch(`/api/tasks/${id}`, { roomId: rooms.Robotika })).status, 401);
  });

  test('nástěnku jde omezit na vybrané místnosti včetně Obecné', async () => {
    const fresh = await startApp();
    const a = await adminClient(fresh);
    const u = await approvedUser(fresh, 'tridic');
    const r = {};
    for (const name of ['Robotika', 'Dílna', 'Prázdná']) r[name] = (await a.post('/api/admin/rooms', { name })).json.room.id;
    const make = async (title, roomId, status) => {
      const id = (await u.post('/api/tasks', { title, roomId })).json.task.id;
      if (status) await u.patch(`/api/tasks/${id}`, { status });
    };
    await make('robot 1', r.Robotika);
    await make('robot 2', r.Robotika, 'done');
    await make('dílna 1', r['Dílna'], 'doing');
    await make('obecný 1', null);
    await make('obecný 2', null, 'done');

    const visitor = fresh.client();
    const titles = (board) => Object.values(board.columns).flatMap((c) => c.tasks.map((t) => t.title)).sort();
    const load = async (rooms) => (await visitor.get(`/api/tasks${rooms === undefined ? '' : `?rooms=${rooms}`}`)).json;

    const all = await load();
    assert.equal(titles(all).length, 5);
    assert.deepEqual(all.counts, { todo: 2, doing: 1, done: 2 });
    assert.deepEqual(all.rooms.map((x) => x.name), ['Dílna', 'Prázdná', 'Robotika']);

    const robots = await load(r.Robotika);
    assert.deepEqual(titles(robots), ['robot 1', 'robot 2']);
    assert.deepEqual(robots.counts, { todo: 1, doing: 0, done: 1 }, 'počty odpovídají výběru');

    const general = await load(0);
    assert.deepEqual(titles(general), ['obecný 1', 'obecný 2']);

    const mixed = await load(`0,${r['Dílna']}`);
    assert.deepEqual(titles(mixed), ['dílna 1', 'obecný 1', 'obecný 2']);
    assert.deepEqual(mixed.counts, { todo: 1, doing: 1, done: 1 });

    assert.deepEqual(titles(await load(r['Prázdná'])), []);
    assert.deepEqual(titles(await load(99999)), [], 'neznámá místnost nic nevrátí, ale neselže');
    assert.deepEqual(titles(await load(`${r.Robotika},${r.Robotika}`)), ['robot 1', 'robot 2']);

    for (const bad of ['abc', '1;DROP', '-1', '1,,2', '1.5', "1' OR '1'='1", '01']) {
      assert.equal((await visitor.get(`/api/tasks?rooms=${encodeURIComponent(bad)}`)).status, 400, bad);
    }
    assert.equal(fresh.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 5);
    await fresh.stop();
  });

  test('stránkování hotových úkolů respektuje výběr místností', async () => {
    const fresh = await startApp();
    const a = await adminClient(fresh);
    const u = await approvedUser(fresh, 'strankar');
    const roomId = (await a.post('/api/admin/rooms', { name: 'Archiv' })).json.room.id;
    const insert = fresh.db.prepare(
      "INSERT INTO tasks (title, status, room_id, created_by, created_at, updated_at, status_changed_at) VALUES (?, 'done', ?, ?, ?, ?, ?)",
    );
    fresh.db.transaction(() => {
      for (let i = 0; i < 90; i += 1) insert.run(`Hotovo ${i}`, i % 2 === 0 ? roomId : null, u.id, 1000 + i, 1000 + i, 1000 + i);
    })();
    const first = (await u.get(`/api/tasks?rooms=${roomId}`)).json;
    assert.equal(first.counts.done, 45);
    assert.equal(first.columns.done.tasks.length, 40);
    const next = (await u.get(`/api/tasks?status=done&rooms=${roomId}&cursor=${first.columns.done.nextCursor}`)).json;
    assert.equal(next.tasks.length, 5);
    assert.equal(next.nextCursor, null);
    const everything = [...first.columns.done.tasks, ...next.tasks];
    assert.ok(everything.every((t) => t.roomId === roomId));
    assert.equal(new Set(everything.map((t) => t.id)).size, 45);
    await fresh.stop();
  });

  test('správce vidí počty úkolů; smazáním místnosti úkoly přejdou do Obecné', async () => {
    const overview = (await admin.get('/api/admin/rooms')).json;
    const robotika = overview.rooms.find((r) => r.name === 'Robotika');
    assert.equal(robotika.taskCount, 1);
    assert.equal(robotika.openCount, 1);
    assert.ok(overview.unassigned.taskCount >= 2);

    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE room_id = ?').get(rooms.Robotika).id;
    assert.equal((await admin.delete(`/api/admin/rooms/${rooms.Robotika}`)).status, 200);
    assert.equal((await admin.delete(`/api/admin/rooms/${rooms.Robotika}`)).status, 404);

    const task = (await member.get(`/api/tasks/${taskId}`)).json.task;
    assert.equal(task.title, 'Nabít roboty', 'úkol zůstal');
    assert.equal(task.roomId, null);
    assert.ok(!(await ctx.client().get('/api/rooms')).json.rooms.some((r) => r.name === 'Robotika'));
    assert.equal((await admin.post('/api/admin/rooms', { name: 'Robotika' })).status, 201, 'název je znovu volný');
  });

  test('počet místností má strop', async () => {
    const small = await startApp({ maxRooms: 2 });
    const a = await adminClient(small);
    assert.equal((await a.post('/api/admin/rooms', { name: 'A1' })).status, 201);
    assert.equal((await a.post('/api/admin/rooms', { name: 'A2' })).status, 201);
    const third = await a.post('/api/admin/rooms', { name: 'A3' });
    assert.equal(third.status, 409);
    assert.equal(third.json.error.code, 'too_many_rooms');
    await small.stop();
  });
});

describe('přechod databáze na verzi s místnostmi', () => {
  test('starší databáze se převede beze ztráty dat a předtím se zazálohuje', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukoly-migrace-'));
    const config = { dbFile: path.join(dir, 'ukoly.db'), backupDir: path.join(dir, 'backups') };

    // Databáze ve stavu před místnostmi, s daty.
    const old = new Database(config.dbFile);
    old.exec(migrations[0]);
    old.pragma('user_version = 1');
    old.prepare("INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (1, 'pamatnik', 'x', 'user', 'approved', 1)").run();
    old.prepare("INSERT INTO tasks (id, title, description, status, created_by, created_at, updated_at, status_changed_at) VALUES (7, 'Starý úkol', 'popis', 'doing', 1, 10, 20, 30)").run();
    old.prepare("INSERT INTO task_events (id, task_id, user_id, type, from_status, to_status, created_at) VALUES (3, 7, 1, 'created', NULL, 'todo', 10), (4, 7, 1, 'status', 'todo', 'doing', 30)").run();
    old.close();

    const logged = [];
    const db = openDatabase(config, { info: (line) => logged.push(line) });
    try {
      assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
      const task = db.prepare('SELECT * FROM tasks WHERE id = 7').get();
      assert.equal(task.title, 'Starý úkol');
      assert.equal(task.room_id, null, 'staré úkoly jsou v Obecné');
      assert.deepEqual(
        db.prepare('SELECT id, type, from_status, to_status, note, created_at FROM task_events ORDER BY id').all(),
        [
          { id: 3, type: 'created', from_status: null, to_status: 'todo', note: null, created_at: 10 },
          { id: 4, type: 'status', from_status: 'todo', to_status: 'doing', note: null, created_at: 30 },
        ],
      );
      // Nový typ záznamu jde zapsat a cizí klíče drží.
      db.prepare("INSERT INTO task_events (task_id, user_id, type, note, created_at) VALUES (7, 1, 'room', 'Dílna', 40)").run();
      assert.throws(() => db.prepare("INSERT INTO task_events (task_id, type, created_at) VALUES (7, 'neznamy', 1)").run());
      assert.throws(() => db.prepare('UPDATE tasks SET room_id = 123 WHERE id = 7').run(), /FOREIGN KEY/);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      db.prepare('DELETE FROM tasks WHERE id = 7').run();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, 0, 'historie se maže s úkolem');
    } finally {
      db.close();
    }

    const backups = fs.readdirSync(config.backupDir);
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^pred-migraci-v1-\d+\.db$/);
    const backup = new Database(path.join(config.backupDir, backups[0]), { readonly: true });
    assert.equal(backup.pragma('user_version', { simple: true }), 1);
    assert.equal(backup.prepare('SELECT title FROM tasks WHERE id = 7').get().title, 'Starý úkol');
    backup.close();
    assert.ok(logged.some((line) => line.includes('Záloha databáze před migrací')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('aplikace nad převedenou databází běží a starý úkol jde zařadit do místnosti', async () => {
    const ctx = await startApp();
    try {
      const admin = await adminClient(ctx);
      const user = await approvedUser(ctx, 'novacek', PASSWORD);
      const roomId = (await admin.post('/api/admin/rooms', { name: 'Modelářství' })).json.room.id;
      const id = (await user.post('/api/tasks', { title: 'Slepit model' })).json.task.id;
      const moved = await user.patch(`/api/tasks/${id}`, { roomId, status: 'doing' });
      assert.equal(moved.json.task.roomId, roomId);
      assert.deepEqual(moved.json.task.events.map((e) => e.type), ['status', 'room', 'created']);
      const visitor = (await ctx.client().get(`/api/tasks/${id}`)).json.task;
      assert.equal(visitor.roomId, roomId);
      assert.equal(visitor.events[1].note, 'Modelářství');
      assert.equal(visitor.events[1].user, undefined);
    } finally {
      await ctx.stop();
    }
  });
});

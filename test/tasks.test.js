import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { adminClient, approvedUser, startApp } from './helpers.js';

describe('úkoly', () => {
  let ctx;
  let admin;
  let anna;
  let bob;

  before(async () => {
    ctx = await startApp();
    admin = await adminClient(ctx);
    anna = await approvedUser(ctx, 'anna');
    bob = await approvedUser(ctx, 'bob');
  });
  after(() => ctx.stop());

  test('založení, změna stavu a historie', async () => {
    const created = await anna.post('/api/tasks', { title: '  Vyměnit   filament  ', description: 'Řádek 1\r\nŘádek 2\u0000' });
    assert.equal(created.status, 201);
    const task = created.json.task;
    assert.equal(task.title, 'Vyměnit filament');
    assert.equal(task.description, 'Řádek 1\nŘádek 2');
    assert.equal(task.status, 'todo');
    assert.equal(task.author, 'anna');

    const doing = await bob.patch(`/api/tasks/${task.id}`, { status: 'doing' });
    assert.equal(doing.json.task.status, 'doing');
    const done = await bob.patch(`/api/tasks/${task.id}`, { status: 'done' });
    assert.equal(done.json.task.status, 'done');
    assert.ok(done.json.task.statusChangedAt >= task.statusChangedAt);

    const events = done.json.task.events;
    assert.deepEqual(
      events.map((e) => [e.type, e.from, e.to, e.user]),
      [
        ['status', 'doing', 'done', 'bob'],
        ['status', 'todo', 'doing', 'bob'],
        ['created', undefined, 'todo', 'anna'],
      ],
    );
  });

  test('stejná hodnota nic nezmění a nepřidá záznam do historie', async () => {
    const id = (await anna.post('/api/tasks', { title: 'Beze změny' })).json.task.id;
    const before = (await anna.get(`/api/tasks/${id}`)).json.task;
    const same = await anna.patch(`/api/tasks/${id}`, { status: 'todo', title: 'Beze změny' });
    assert.equal(same.json.task.events.length, before.events.length);
    assert.equal(same.json.task.updatedAt, before.updatedAt);
  });

  test('několik úprav textu po sobě je v historii jednou', async () => {
    const id = (await anna.post('/api/tasks', { title: 'Původní' })).json.task.id;
    await anna.patch(`/api/tasks/${id}`, { title: 'Druhý' });
    await anna.patch(`/api/tasks/${id}`, { description: 'Popis' });
    const task = (await anna.patch(`/api/tasks/${id}`, { title: 'Třetí' })).json.task;
    assert.equal(task.events.filter((e) => e.type === 'edited').length, 1);
    assert.equal(task.title, 'Třetí');
    assert.equal(task.description, 'Popis');
  });

  test('neplatné vstupy se odmítnou', async () => {
    const id = (await anna.post('/api/tasks', { title: 'Vzor' })).json.task.id;
    const bad = [
      ['POST', '/api/tasks', {}],
      ['POST', '/api/tasks', { title: '   ' }],
      ['POST', '/api/tasks', { title: 'x'.repeat(121) }],
      ['POST', '/api/tasks', { title: 'ok', description: 'x'.repeat(5001) }],
      ['POST', '/api/tasks', { title: 'ok', status: 'done' }],
      ['POST', '/api/tasks', { title: ['pole'] }],
      ['PATCH', `/api/tasks/${id}`, {}],
      ['PATCH', `/api/tasks/${id}`, { status: 'hotovo' }],
      ['PATCH', `/api/tasks/${id}`, { created_by: 1 }],
      ['PATCH', `/api/tasks/${id}`, { title: '' }],
      ['PATCH', '/api/tasks/abc', { status: 'done' }],
      ['PATCH', '/api/tasks/0', { status: 'done' }],
      ['PATCH', '/api/tasks/1%20OR%201=1', { status: 'done' }],
    ];
    for (const [method, url, body] of bad) {
      const res = await anna.request(method, url, { body });
      assert.equal(res.status, 400, `${method} ${url} ${JSON.stringify(body).slice(0, 40)}`);
    }
    assert.equal((await anna.patch('/api/tasks/999999', { status: 'done' })).status, 404);
    assert.equal((await anna.get('/api/tasks/999999')).status, 404);
    const untouched = (await anna.get(`/api/tasks/${id}`)).json.task;
    assert.equal(untouched.title, 'Vzor');
    assert.equal(untouched.status, 'todo');
  });

  test('příliš velké tělo požadavku se odmítne', async () => {
    const res = await anna.post('/api/tasks', { title: 'ok', description: 'x'.repeat(100_000) });
    assert.equal(res.status, 413);
  });

  test('text se ukládá doslova, bez interpretace HTML nebo SQL', async () => {
    const title = `<img src=x onerror=alert(1)> '); DROP TABLE tasks;--`;
    const created = await anna.post('/api/tasks', { title, description: '<script>alert(1)</script>' });
    assert.equal(created.json.task.title, title);
    assert.equal(created.json.task.description, '<script>alert(1)</script>');
    assert.ok(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n > 0);
    assert.match(created.headers['content-type'], /application\/json/);
  });

  test('veřejnost vidí úkoly, ale ne jména členů', async () => {
    const id = (await anna.post('/api/tasks', { title: 'Veřejný úkol', description: 'Popis pro všechny' })).json.task.id;
    await bob.patch(`/api/tasks/${id}`, { status: 'doing' });
    const anonymous = ctx.client();

    const list = await anonymous.get('/api/tasks');
    assert.equal(list.status, 200);
    const item = list.json.columns.doing.tasks.find((t) => t.id === id);
    assert.equal(item.title, 'Veřejný úkol');
    assert.equal(item.author, undefined);

    const detail = (await anonymous.get(`/api/tasks/${id}`)).json.task;
    assert.equal(detail.description, 'Popis pro všechny');
    assert.equal(detail.author, undefined);
    assert.equal(detail.canEdit, false);
    assert.equal(detail.canDelete, false);
    assert.ok(detail.events.length >= 2);
    assert.ok(detail.events.every((e) => e.user === undefined));
    const raw = JSON.stringify(list.json) + JSON.stringify(detail);
    assert.ok(!raw.includes('anna') && !raw.includes('bob'), 'jména nesmí uniknout ani jinou cestou');

    const member = (await bob.get(`/api/tasks/${id}`)).json.task;
    assert.equal(member.author, 'anna');
  });

  test('mazání: autor a správce ano, ostatní ne', async () => {
    const mine = (await anna.post('/api/tasks', { title: 'Annin' })).json.task.id;
    assert.equal((await bob.delete(`/api/tasks/${mine}`)).status, 403);
    assert.equal((await anna.delete(`/api/tasks/${mine}`)).status, 200);
    assert.equal((await anna.get(`/api/tasks/${mine}`)).status, 404);
    assert.equal((await anna.delete(`/api/tasks/${mine}`)).status, 404);

    const second = (await anna.post('/api/tasks', { title: 'Druhý Annin' })).json.task.id;
    assert.equal((await admin.delete(`/api/tasks/${second}`)).status, 200);
  });

  test('počty podle stavu a stránkování hotových úkolů', async () => {
    const fresh = await startApp();
    const user = await approvedUser(fresh, 'pilny');
    const insert = fresh.db.prepare(
      "INSERT INTO tasks (title, status, created_by, created_at, updated_at, status_changed_at) VALUES (?, 'done', ?, ?, ?, ?)",
    );
    fresh.db.transaction(() => {
      for (let i = 0; i < 95; i += 1) insert.run(`Hotovo ${i}`, user.id, 1000 + i, 1000 + i, 1000 + Math.floor(i / 3));
    })();
    await user.post('/api/tasks', { title: 'Čeká' });

    const first = (await user.get('/api/tasks')).json;
    assert.deepEqual(first.counts, { todo: 1, doing: 0, done: 95 });
    assert.equal(first.columns.done.tasks.length, 40);
    assert.ok(first.columns.done.nextCursor);

    const seen = new Set(first.columns.done.tasks.map((t) => t.id));
    let cursor = first.columns.done.nextCursor;
    let pages = 0;
    while (cursor) {
      const next = (await user.get(`/api/tasks?status=done&cursor=${cursor}`)).json;
      for (const t of next.tasks) {
        assert.ok(!seen.has(t.id), 'žádný úkol se nesmí opakovat');
        seen.add(t.id);
      }
      cursor = next.nextCursor;
      pages += 1;
      assert.ok(pages < 10);
    }
    assert.equal(seen.size, 95);
    assert.equal((await user.get('/api/tasks?status=done&cursor=abc')).status, 400);
    assert.equal((await user.get('/api/tasks?status=vse')).status, 400);
    await fresh.stop();
  });
});

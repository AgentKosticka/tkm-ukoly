import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ADMIN, PASSWORD, adminClient, approvedUser, jpegWithExif, startApp } from './helpers.js';

describe('oprávnění', () => {
  let ctx;
  let admin;
  let owner;
  let other;
  let taskId;
  let photoId;

  before(async () => {
    ctx = await startApp();
    admin = await adminClient(ctx);
    owner = await approvedUser(ctx, 'majitel');
    other = await approvedUser(ctx, 'kolega');
    taskId = (await owner.post('/api/tasks', { title: 'Opravit 3D tiskárnu', description: 'Tryska je ucpaná' })).json.task.id;
    photoId = (await owner.upload(taskId, await jpegWithExif())).json.photo.id;
  });
  after(() => ctx.stop());

  // Každá cesta, která něco mění. Pro každou se ověří, kdo všechno neprojde.
  const mutations = () => [
    ['POST', '/api/tasks', { title: 'Nový úkol' }],
    ['PATCH', `/api/tasks/${taskId}`, { status: 'doing' }],
    ['PATCH', `/api/tasks/${taskId}`, { title: 'Přepsáno' }],
    ['DELETE', `/api/tasks/${taskId}`],
    ['POST', `/api/tasks/${taskId}/photos`, 'upload'],
    ['DELETE', `/api/photos/${photoId}`],
    ['GET', `/api/photos/${photoId}/original`],
    ['GET', '/api/admin/users'],
    ['POST', `/api/admin/users/${owner.id}/approve`, {}],
    ['POST', `/api/admin/users/${owner.id}/reject`, {}],
    ['PATCH', `/api/admin/users/${owner.id}`, { role: 'admin' }],
    ['POST', `/api/admin/users/${owner.id}/reset-password`, {}],
    ['DELETE', `/api/admin/users/${owner.id}`],
  ];

  async function attempt(client, [method, url, body]) {
    if (body === 'upload') return client.upload(taskId, await jpegWithExif());
    return client.request(method, url, { body });
  }

  async function assertUnchanged() {
    const task = ctx.db.prepare('SELECT title, status FROM tasks WHERE id = ?').get(taskId);
    assert.deepEqual(task, { title: 'Opravit 3D tiskárnu', status: 'todo' });
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE task_id = ?').get(taskId).n, 1);
    assert.equal(ctx.db.prepare("SELECT role FROM users WHERE username = 'majitel'").get().role, 'user');
  }

  test('nepřihlášený návštěvník úkoly vidí, ale nic nezmění', async () => {
    const anonymous = ctx.client();
    assert.equal((await anonymous.get('/api/tasks')).status, 200);
    assert.equal((await anonymous.get(`/api/tasks/${taskId}`)).status, 200);
    for (const mutation of mutations()) {
      const res = await attempt(anonymous, mutation);
      assert.equal(res.status, 401, `${mutation[0]} ${mutation[1]}`);
    }
    await assertUnchanged();
  });

  test('neschválený účet nic nezmění ani s platným heslem', async () => {
    const pending = ctx.client();
    await pending.post('/api/auth/register', { username: 'cekajici', password: PASSWORD });
    assert.equal((await pending.login('cekajici', PASSWORD)).status, 403);
    for (const mutation of mutations()) {
      assert.equal((await attempt(pending, mutation)).status, 401, `${mutation[0]} ${mutation[1]}`);
    }
    await assertUnchanged();
  });

  test('podvržená nebo cizí cookie nikoho nepřihlásí', async () => {
    const forged = ctx.client();
    for (const value of ['', 'x', 'A'.repeat(43), '../../etc/passwd', "' OR 1=1 --"]) {
      forged.cookies.set('sid', value);
      assert.equal((await forged.get('/api/me')).json.user, null);
      assert.equal((await forged.post('/api/tasks', { title: 'x' })).status, 401);
    }
  });

  test('zablokovaný uživatel přijde o přístup okamžitě, i s rozdělanou session', async () => {
    const victim = await approvedUser(ctx, 'blokovany');
    assert.equal((await victim.get('/api/me')).json.user.username, 'blokovany');
    const disabled = await admin.patch(`/api/admin/users/${victim.id}`, { status: 'disabled' });
    assert.equal(disabled.json.user.status, 'disabled');

    assert.equal((await victim.get('/api/me')).json.user, null);
    for (const mutation of mutations()) {
      assert.equal((await attempt(victim, mutation)).status, 401, `${mutation[0]} ${mutation[1]}`);
    }
    const relogin = await ctx.client().login('blokovany', PASSWORD);
    assert.equal(relogin.status, 403);
    assert.equal(relogin.json.error.code, 'account_disabled');
    await assertUnchanged();
  });

  test('i když session v databázi zůstane, rozhoduje aktuální stav účtu', async () => {
    const victim = await approvedUser(ctx, 'tichy');
    // Stav se změní přímo v databázi, bez smazání session.
    ctx.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(victim.id);
    assert.equal((await victim.post('/api/tasks', { title: 'x' })).status, 401);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(victim.id).n, 0);
  });

  test('běžný uživatel se nedostane do správy uživatelů', async () => {
    for (const mutation of mutations().filter(([, url]) => url.startsWith('/api/admin/'))) {
      const res = await attempt(other, mutation);
      assert.equal(res.status, 403, `${mutation[0]} ${mutation[1]}`);
    }
    await assertUnchanged();
  });

  test('po odebrání role správce přestane správa fungovat hned', async () => {
    const second = await approvedUser(ctx, 'druhyspravce');
    await admin.patch(`/api/admin/users/${second.id}`, { role: 'admin' });
    assert.equal((await second.get('/api/admin/users')).status, 200);
    await admin.patch(`/api/admin/users/${second.id}`, { role: 'user' });
    assert.equal((await second.get('/api/admin/users')).status, 403);
  });

  test('cizí úkol a cizí fotku smazat nejde, upravit a doplnit ano', async () => {
    assert.equal((await other.delete(`/api/tasks/${taskId}`)).status, 403);
    assert.equal((await other.delete(`/api/photos/${photoId}`)).status, 403);
    await assertUnchanged();

    const detail = (await other.get(`/api/tasks/${taskId}`)).json.task;
    assert.equal(detail.canEdit, true);
    assert.equal(detail.canDelete, false);
    assert.equal(detail.photos[0].canDelete, false);
    const ownerDetail = (await owner.get(`/api/tasks/${taskId}`)).json.task;
    assert.equal(ownerDetail.canDelete, true);
    assert.equal(ownerDetail.photos[0].canDelete, true);
  });

  test('správce nesmí odstavit sám sebe ani posledního správce', async () => {
    const me = (await admin.get('/api/me')).json.user;
    assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { role: 'user' })).status, 403);
    assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { status: 'disabled' })).status, 403);
    assert.equal((await admin.delete(`/api/admin/users/${me.id}`)).status, 403);
    assert.equal((await admin.post(`/api/admin/users/${me.id}/reset-password`)).status, 403);
    const row = ctx.db.prepare('SELECT role, status FROM users WHERE id = ?').get(me.id);
    assert.deepEqual(row, { role: 'admin', status: 'approved' });
  });

  test('reset hesla správcem odhlásí uživatele a vynutí změnu hesla', async () => {
    const user = await approvedUser(ctx, 'zapomnetlivy');
    const reset = await admin.post(`/api/admin/users/${user.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.match(reset.json.password, /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    assert.equal((await user.get('/api/me')).json.user, null, 'stará session je pryč');
    assert.equal((await ctx.client().login('zapomnetlivy', PASSWORD)).status, 401);

    const fresh = ctx.client();
    const login = await fresh.login('zapomnetlivy', reset.json.password);
    assert.equal(login.json.user.mustChangePassword, true);
    assert.equal((await fresh.post('/api/tasks', { title: 'x' })).json.error.code, 'password_change_required');
  });

  test('smazání uživatele zachová jeho úkoly', async () => {
    const leaving = await approvedUser(ctx, 'odchazejici');
    const id = (await leaving.post('/api/tasks', { title: 'Zůstane tu' })).json.task.id;
    assert.equal((await admin.delete(`/api/admin/users/${leaving.id}`)).status, 200);
    assert.equal((await leaving.get('/api/me')).json.user, null);
    const task = (await admin.get(`/api/tasks/${id}`)).json.task;
    assert.equal(task.title, 'Zůstane tu');
    assert.equal(task.author, null);
  });
});

describe('ochrana proti požadavkům z cizích stránek', () => {
  let ctx;
  let user;
  before(async () => {
    ctx = await startApp();
    user = await approvedUser(ctx, 'clen');
  });
  after(() => ctx.stop());

  test('bez vlastní hlavičky se nic nezmění', async () => {
    const res = await user.post('/api/tasks', { title: 'x' }, { headers: { 'x-requested-with': '' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'bad_origin');
  });

  test('požadavek s cizím Origin je odmítnut', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:81', 'http://localhost.evil.example']) {
      const res = await user.post('/api/tasks', { title: 'x' }, { headers: { origin } });
      assert.equal(res.status, 403, origin);
    }
  });

  test('požadavek označený prohlížečem jako cross-site je odmítnut', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await user.post('/api/tasks', { title: 'x' }, { headers: { 'sec-fetch-site': site } });
      assert.equal(res.status, 403, site);
    }
  });

  test('požadavek ze stejného původu projde', async () => {
    const res = await user.post('/api/tasks', { title: 'x' }, { headers: { origin: 'http://localhost:80', 'sec-fetch-site': 'same-origin' } });
    assert.equal(res.status, 201);
  });

  test('odhlášení ani přihlášení nejde vyvolat z cizí stránky', async () => {
    assert.equal((await user.post('/api/auth/logout', {}, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await user.get('/api/me')).json.user.username, 'clen');
    const login = await ctx.client().post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password }, { headers: { origin: 'https://evil.example' } });
    assert.equal(login.status, 403);
  });

  test('s pevně nastavenou veřejnou adresou platí jen ta', async () => {
    const strict = await startApp({ publicOrigin: 'https://ukoly.example.cz', cookieSecure: 'never' });
    const c = strict.client();
    const bad = await c.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password }, { headers: { origin: 'http://localhost:80' } });
    assert.equal(bad.status, 403);
    const good = await c.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password }, { headers: { origin: 'https://ukoly.example.cz' } });
    assert.equal(good.status, 200);
    await strict.stop();
  });
});

describe('hlavičky a statické soubory', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  test('každá odpověď nese bezpečnostní hlavičky', async () => {
    const c = ctx.client();
    for (const url of ['/', '/api/me', '/api/neexistuje', '/ukol/1']) {
      const res = await c.get(url, { headers: { accept: 'text/html' } });
      assert.match(res.headers['content-security-policy'], /default-src 'none'/, url);
      assert.match(res.headers['content-security-policy'], /script-src 'self'(;|$)/, url);
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/, url);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(res.headers['x-frame-options'], 'DENY', url);
      assert.equal(res.headers['strict-transport-security'], undefined, 'HSTS jen přes HTTPS');
    }
  });

  test('odpovědi API se neukládají do mezipaměti', async () => {
    assert.equal((await ctx.client().get('/api/tasks')).headers['cache-control'], 'no-store');
  });

  test('adresy aplikace vrací stránku, neznámé soubory a API 404', async () => {
    const c = ctx.client();
    const page = await c.get('/ukol/123', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal((await c.get('/neco.js', { headers: { accept: '*/*' } })).status, 404);
    assert.equal((await c.get('/api/neexistuje')).status, 404);
  });

  test('ze složky s aplikací nejde utéct', async () => {
    const c = ctx.client();
    for (const url of ['/../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/.env', '/media/..%2f..%2fukoly.db/thumb']) {
      const res = await c.get(url, { headers: { accept: '*/*' } });
      assert.ok(res.status === 404 || res.status === 400 || res.status === 403, `${url} → ${res.status}`);
      assert.ok(!res.raw.toString().includes('better-sqlite3'), url);
    }
  });
});

describe('omezení počtu požadavků', () => {
  test('po vyčerpání limitu přijde 429 se srozumitelnou odpovědí', async () => {
    const ctx = await startApp({ rateLimits: true });
    try {
      const c = ctx.client();
      const statuses = [];
      for (let i = 0; i < 10; i += 1) {
        const res = await c.post('/api/auth/register', { username: `zajemce${i}`, password: PASSWORD });
        statuses.push(res.status);
        if (res.status === 429) {
          assert.equal(res.json.error.code, 'rate_limited');
          assert.match(res.json.error.message, /Příliš mnoho požadavků/);
          assert.ok(Number(res.headers['retry-after']) > 0);
        }
      }
      assert.deepEqual(statuses.slice(0, 8), Array(8).fill(201), 'prvních osm registrací projde');
      assert.deepEqual(statuses.slice(8), [429, 429], 'další už ne');
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").get().n, 8);

      // Limit se počítá na adresu; čtení úkolů jím není dotčeno.
      assert.equal((await c.get('/api/tasks')).status, 200);
    } finally {
      await ctx.stop();
    }
  });

  test('počet čekajících registrací má strop', async () => {
    const ctx = await startApp({ maxPendingUsers: 2 });
    try {
      const c = ctx.client();
      assert.equal((await c.post('/api/auth/register', { username: 'prvni', password: PASSWORD })).status, 201);
      assert.equal((await c.post('/api/auth/register', { username: 'druhy', password: PASSWORD })).status, 201);
      const third = await c.post('/api/auth/register', { username: 'treti', password: PASSWORD });
      assert.equal(third.status, 503);
      assert.equal(third.json.error.code, 'registrations_paused');
    } finally {
      await ctx.stop();
    }
  });
});

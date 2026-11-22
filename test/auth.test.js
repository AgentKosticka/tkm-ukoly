import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ADMIN, PASSWORD, adminClient, approvedUser, startApp } from './helpers.js';

describe('registrace a přihlášení', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  test('nová registrace čeká na schválení a do té doby se nepřihlásí', async () => {
    const user = ctx.client();
    const registered = await user.post('/api/auth/register', { username: 'novacek', password: PASSWORD });
    assert.equal(registered.status, 201);
    assert.deepEqual(registered.json, { status: 'pending' });
    assert.equal(user.cookies.size, 0, 'registrace nesmí přihlásit');

    const login = await user.login('novacek', PASSWORD);
    assert.equal(login.status, 403);
    assert.equal(login.json.error.code, 'account_pending');
    assert.equal(user.cookies.size, 0);

    const created = await user.post('/api/tasks', { title: 'Zkouška' });
    assert.equal(created.status, 401);
  });

  test('stav čekajícího účtu se neprozradí bez správného hesla', async () => {
    const user = ctx.client();
    const login = await user.login('novacek', 'spatne-heslo-123');
    assert.equal(login.status, 401);
    assert.equal(login.json.error.code, 'bad_credentials');
  });

  test('po schválení správcem se uživatel přihlásí a může pracovat', async () => {
    const admin = await adminClient(ctx);
    const me = await admin.get('/api/me');
    assert.equal(me.json.pendingUsers, 1);

    const { json } = await admin.get('/api/admin/users');
    const pending = json.users.find((u) => u.username === 'novacek');
    assert.equal(pending.status, 'pending');
    const approved = await admin.post(`/api/admin/users/${pending.id}/approve`);
    assert.equal(approved.json.user.status, 'approved');

    const user = ctx.client();
    const login = await user.login('NOVACEK', PASSWORD);
    assert.equal(login.status, 200, 'jméno se porovnává bez ohledu na velikost písmen');
    assert.equal(login.json.user.username, 'novacek');
    assert.equal(login.json.user.role, 'user');
    assert.equal(login.json.pendingUsers, undefined);

    const created = await user.post('/api/tasks', { title: 'Zkouška' });
    assert.equal(created.status, 201);
  });

  test('zamítnutá registrace zmizí a jméno je znovu volné', async () => {
    const user = ctx.client();
    await user.post('/api/auth/register', { username: 'zamitnuty', password: PASSWORD });
    const admin = await adminClient(ctx);
    const { json } = await admin.get('/api/admin/users');
    const row = json.users.find((u) => u.username === 'zamitnuty');
    assert.equal((await admin.post(`/api/admin/users/${row.id}/reject`)).status, 200);
    assert.equal((await user.login('zamitnuty', PASSWORD)).status, 401);
    assert.equal((await user.post('/api/auth/register', { username: 'zamitnuty', password: PASSWORD })).status, 201);
  });

  test('registrace odmítne špatné jméno, slabé heslo a obsazené jméno', async () => {
    const c = ctx.client();
    const cases = [
      [{ username: 'ab', password: PASSWORD }, 'invalid_username'],
      [{ username: 'jméno', password: PASSWORD }, 'invalid_username'],
      [{ username: 'a b c', password: PASSWORD }, 'invalid_username'],
      [{ username: '<script>', password: PASSWORD }, 'invalid_username'],
      [{ username: 'kratke', password: 'kratke1' }, 'invalid_password'],
      [{ username: 'bezne', password: 'heslo12345'.slice(0, 9) }, 'invalid_password'],
      [{ username: 'bezne', password: 'password123' }, 'invalid_password'],
      [{ username: 'pepazdepa', password: 'pepazdepa2026' }, 'invalid_password'],
      [{ username: 'Novacek', password: PASSWORD }, 'username_taken'],
      [{ username: ADMIN.username.toUpperCase(), password: PASSWORD }, 'username_taken'],
    ];
    for (const [body, code] of cases) {
      const res = await c.post('/api/auth/register', body);
      assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(body));
      assert.equal(res.json.error.code, code, JSON.stringify(body));
    }
    const extra = await c.post('/api/auth/register', { username: 'navic', password: PASSWORD, role: 'admin' });
    assert.equal(extra.status, 400, 'neznámá pole se odmítají');
  });

  test('registrací nejde získat práva správce ani schválený účet', async () => {
    const row = ctx.db.prepare("SELECT role, status FROM users WHERE username = 'zamitnuty'").get();
    assert.deepEqual(row, { role: 'user', status: 'pending' });
  });

  test('hesla se ukládají jen jako otisk scrypt', async () => {
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('novacek');
    assert.match(row.password_hash, /^scrypt\$10\$8\$2\$[\w-]+\$[\w-]+$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
  });

  test('cookie je HttpOnly a SameSite=Strict; v databázi je jen otisk tokenu', async () => {
    const user = ctx.client();
    const login = await user.login('novacek', PASSWORD);
    const cookie = login.cookies.find((c) => c.name === 'sid');
    assert.ok(cookie, 'bez HTTPS se používá cookie sid');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    assert.equal(cookie.path, '/');
    assert.equal(cookie.secure, undefined);
    const stored = ctx.db.prepare('SELECT token_hash FROM sessions').all();
    assert.ok(stored.length > 0);
    assert.ok(stored.every((s) => s.token_hash !== cookie.value && /^[0-9a-f]{64}$/.test(s.token_hash)));
  });

  test('odhlášení zruší session na serveru', async () => {
    const user = ctx.client();
    await user.login('novacek', PASSWORD);
    const token = user.cookies.get('sid');
    assert.equal((await user.post('/api/auth/logout')).status, 200);
    assert.equal(user.cookies.size, 0);

    const replay = ctx.client();
    replay.cookies.set('sid', token);
    assert.equal((await replay.get('/api/me')).json.user, null);
    assert.equal((await replay.post('/api/tasks', { title: 'x' })).status, 401);
  });

  test('změna hesla odhlásí ostatní zařízení a staré heslo přestane platit', async () => {
    const a = await approvedUser(ctx, 'menic');
    const b = ctx.client();
    await b.login('menic', PASSWORD);
    assert.equal((await b.get('/api/me')).json.user.username, 'menic');

    const wrong = await a.post('/api/auth/password', { currentPassword: 'neni-to-ono-1', newPassword: 'uplne-nove-heslo-9' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.code, 'bad_current_password');
    const weak = await a.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'kratke' });
    assert.equal(weak.json.error.code, 'invalid_password');
    const same = await a.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    assert.equal(same.json.error.code, 'same_password');

    const ok = await a.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'uplne-nove-heslo-9' });
    assert.equal(ok.status, 200);
    assert.equal((await a.get('/api/me')).json.user.username, 'menic', 'aktuální zařízení zůstává přihlášené');
    assert.equal((await b.get('/api/me')).json.user, null, 'druhé zařízení je odhlášené');
    assert.equal((await ctx.client().login('menic', PASSWORD)).status, 401);
    assert.equal((await ctx.client().login('menic', 'uplne-nove-heslo-9')).status, 200);
  });

  test('po pěti špatných heslech se přihlášení z téže adresy dočasně zablokuje', async () => {
    await approvedUser(ctx, 'obet');
    const attacker = ctx.client();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await attacker.login('obet', `spatne-heslo-${i}`)).status, 401);
    }
    const blocked = await attacker.login('obet', PASSWORD);
    assert.equal(blocked.status, 429, 'ani správné heslo teď neprojde');
    assert.equal(blocked.json.error.code, 'too_many_attempts');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
  });
});

describe('přihlášení přes HTTPS za proxy', () => {
  let ctx;
  before(async () => {
    ctx = await startApp({ trustProxy: ['loopback'] });
  });
  after(() => ctx.stop());

  test('cookie má prefix __Host- a příznak Secure a posílá se HSTS', async () => {
    const admin = ctx.client();
    admin.headers['x-forwarded-proto'] = 'https';
    admin.headers.host = 'ukoly.example.cz';
    const login = await admin.login(ADMIN.username, ADMIN.password);
    assert.equal(login.status, 200);
    const cookie = login.cookies.find((c) => c.name === '__Host-sid');
    assert.ok(cookie);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    assert.equal(cookie.domain, undefined);
    assert.match(login.headers['strict-transport-security'], /max-age=31536000/);
    assert.equal((await admin.get('/api/me')).json.user.username, ADMIN.username);
  });

  test('přes HTTPS se čte jen cookie s prefixem __Host-, podstrčenou „sid“ server ignoruje', async () => {
    const admin = ctx.client();
    admin.headers['x-forwarded-proto'] = 'https';
    await admin.login(ADMIN.username, ADMIN.password);
    const token = admin.cookies.get('__Host-sid');

    const injected = ctx.client();
    injected.headers['x-forwarded-proto'] = 'https';
    injected.cookies.set('sid', token);
    assert.equal((await injected.get('/api/me')).json.user, null);
  });

  test('adresu klienta určuje jen důvěryhodná proxy, ne hlavička od klienta', async () => {
    const attempt = (forwarded, password) =>
      ctx.client().post('/api/auth/login', { username: ADMIN.username, password }, { headers: { 'x-forwarded-for': forwarded } });
    // Proxy připisuje skutečnou adresu na konec; cokoliv před ní poslal klient sám.
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await attempt(`10.0.0.${i}, 203.0.113.7`, 'spatne-heslo-123')).status, 401);
    }
    assert.equal((await attempt('1.2.3.4, 203.0.113.7', ADMIN.password)).status, 429, 'podvržený začátek řetězu nepomůže');
    assert.equal((await attempt('203.0.113.8', ADMIN.password)).status, 200, 'jiná adresa blokovaná není');
  });
});

describe('první správce', () => {
  test('bez ADMIN_PASSWORD se vygeneruje heslo, které je nutné změnit', async () => {
    const lines = [];
    const ctx = await startApp({ adminUsername: 'jiny', adminPassword: null });
    // startApp už správce založil; ověří se, že druhé volání nic nezmění.
    const { ensureAdmin } = await import('../src/bootstrap.js');
    const again = await ensureAdmin(ctx.db, ctx.config, { info: (m) => lines.push(m), warn: (m) => lines.push(m) });
    assert.equal(again, null);
    const row = ctx.db.prepare("SELECT role, status, must_change_password FROM users WHERE username = 'jiny'").get();
    assert.deepEqual(row, { role: 'admin', status: 'approved', must_change_password: 1 });
    await ctx.stop();
  });

  test('vygenerované heslo funguje, ale dokud se nezmění, nejde nic dělat', async () => {
    const { ensureAdmin } = await import('../src/bootstrap.js');
    const ctx = await startApp({ adminUsername: 'docasny', adminPassword: null });
    ctx.db.prepare('DELETE FROM users').run();
    const lines = [];
    await ensureAdmin(ctx.db, ctx.config, { info: (m) => lines.push(m), warn: (m) => lines.push(m) });
    const password = /Heslo: (\S+)/.exec(lines.join('\n'))[1];

    const admin = ctx.client();
    const login = await admin.login('docasny', password);
    assert.equal(login.status, 200);
    assert.equal(login.json.user.mustChangePassword, true);

    const blocked = await admin.post('/api/tasks', { title: 'x' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'password_change_required');
    assert.equal((await admin.get('/api/admin/users')).status, 403);

    const changed = await admin.post('/api/auth/password', { currentPassword: password, newPassword: 'moje-nove-heslo-77' });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.user.mustChangePassword, false);
    assert.equal((await admin.get('/api/admin/users')).status, 200);
    await ctx.stop();
  });
});

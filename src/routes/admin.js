import { conflict, forbidden, notFound } from '../http/errors.js';
import { generatePassword, hashPassword } from '../auth/passwords.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
};

export default async function adminRoutes(app, { ctx }) {
  const { db, config, sessions, requireAdmin } = ctx;
  app.addHook('preHandler', requireAdmin);

  const listUsers = db.prepare(`
    SELECT id, username, role, status, must_change_password, created_at, approved_at, last_login_at
    FROM users
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
  `);
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const approve = db.prepare(
    "UPDATE users SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ? AND status = 'pending'",
  );
  const setStatus = db.prepare('UPDATE users SET status = ? WHERE id = ?');
  const setRole = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  const setPassword = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?');
  const removeUser = db.prepare('DELETE FROM users WHERE id = ?');
  const activeAdmins = db
    .prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'approved'")
    .pluck();

  const present = (u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    mustChangePassword: u.must_change_password === 1,
    createdAt: u.created_at,
    approvedAt: u.approved_at,
    lastLoginAt: u.last_login_at,
  });

  function target(request) {
    const user = getUser.get(request.params.id);
    if (!user) throw notFound('Uživatel neexistuje');
    return user;
  }

  // Správce nesmí omylem odstavit sám sebe ani posledního správce.
  function assertNotSelf(request, user) {
    if (user.id === request.user.id) throw forbidden('Vlastní účet takhle upravit nejde');
  }
  function assertNotLastAdmin(user) {
    if (user.role === 'admin' && user.status === 'approved' && activeAdmins.get() <= 1) {
      throw conflict('last_admin', 'Musí zůstat aspoň jeden aktivní správce');
    }
  }

  app.get('/admin/users', async () => ({ users: listUsers.all().map(present) }));

  app.post('/admin/users/:id/approve', { schema: { params: idParams } }, async (request) => {
    const user = target(request);
    if (user.status !== 'pending') throw conflict('not_pending', 'Tento účet už na schválení nečeká');
    approve.run(Date.now(), request.user.id, user.id);
    request.log.info({ username: user.username, by: request.user.username }, 'registrace schválena');
    return { user: present(getUser.get(user.id)) };
  });

  app.post('/admin/users/:id/reject', { schema: { params: idParams } }, async (request) => {
    const user = target(request);
    if (user.status !== 'pending') throw conflict('not_pending', 'Tento účet už na schválení nečeká');
    removeUser.run(user.id);
    request.log.info({ username: user.username, by: request.user.username }, 'registrace zamítnuta');
    return { ok: true };
  });

  app.patch(
    '/admin/users/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            role: { type: 'string', enum: ['user', 'admin'] },
            status: { type: 'string', enum: ['approved', 'disabled'] },
          },
        },
      },
    },
    async (request) => {
      const { role, status } = request.body;
      db.transaction(() => {
        const user = target(request);
        assertNotSelf(request, user);
        if (user.status === 'pending') throw conflict('pending', 'Účet nejdřív schvalte nebo zamítněte');
        const losesAdmin = (role === 'user' && user.role === 'admin') || (status === 'disabled' && user.status === 'approved');
        if (losesAdmin) assertNotLastAdmin(user);
        if (role && role !== user.role) setRole.run(role, user.id);
        if (status && status !== user.status) {
          setStatus.run(status, user.id);
          if (status === 'disabled') sessions.destroyAllForUser(user.id);
        }
      })();
      return { user: present(getUser.get(request.params.id)) };
    },
  );

  app.post(
    '/admin/users/:id/reset-password',
    { schema: { params: idParams }, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request) => {
      const user = target(request);
      assertNotSelf(request, user);
      // Dočasné heslo se zobrazí správci jen jednou; uživatel si ho po přihlášení musí změnit.
      const password = generatePassword();
      setPassword.run(await hashPassword(password, config.scryptCost), user.id);
      sessions.destroyAllForUser(user.id);
      request.log.info({ username: user.username, by: request.user.username }, 'heslo resetováno správcem');
      return { password };
    },
  );

  app.delete('/admin/users/:id', { schema: { params: idParams } }, async (request) => {
    db.transaction(() => {
      const user = target(request);
      assertNotSelf(request, user);
      assertNotLastAdmin(user);
      // Úkoly a fotky smazaného uživatele zůstávají, jen bez autora.
      removeUser.run(user.id);
    })();
    return { ok: true };
  });
}

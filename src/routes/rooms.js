import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';

const NAME_MAX = 40;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
};
const nameBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', maxLength: 400 } },
};

function parseName(raw) {
  // eslint-disable-next-line no-control-regex
  const name = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length === 0) throw badRequest('invalid_room_name', 'Zadejte název místnosti', { field: 'name' });
  if ([...name].length > NAME_MAX) {
    throw badRequest('invalid_room_name', `Název může mít nejvýš ${NAME_MAX} znaků`, { field: 'name' });
  }
  return name;
}

const keyOf = (name) => name.toLocaleLowerCase('cs');
// Úkoly bez místnosti se v rozhraní jmenují takhle; vlastní místnost se
// stejným názvem by mátla.
const RESERVED = new Set(['obecné', 'obecne', 'vše', 'vse']);

/**
 * Místnosti dělí úkoly podle toho, kam patří. Číst je smí kdokoliv, zakládat,
 * přejmenovat a mazat jen správce. Úkol bez místnosti patří do „Obecné“.
 */
export default async function roomRoutes(app, { ctx }) {
  const { db, config, requireAdmin } = ctx;

  const list = db.prepare('SELECT id, name FROM rooms ORDER BY name_key, id');
  const listWithCounts = db.prepare(`
    SELECT r.id, r.name, r.created_at,
           (SELECT COUNT(*) FROM tasks t WHERE t.room_id = r.id) AS task_count,
           (SELECT COUNT(*) FROM tasks t WHERE t.room_id = r.id AND t.status <> 'done') AS open_count
    FROM rooms r ORDER BY r.name_key, r.id
  `);
  const unassigned = db.prepare(`
    SELECT COUNT(*) AS task_count, COALESCE(SUM(status <> 'done'), 0) AS open_count FROM tasks WHERE room_id IS NULL
  `);
  const get = db.prepare('SELECT id, name FROM rooms WHERE id = ?');
  const byKey = db.prepare('SELECT id FROM rooms WHERE name_key = ?');
  const count = db.prepare('SELECT COUNT(*) FROM rooms').pluck();
  const insert = db.prepare('INSERT INTO rooms (name, name_key, created_at) VALUES (?, ?, ?)');
  const rename = db.prepare('UPDATE rooms SET name = ?, name_key = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM rooms WHERE id = ?');

  ctx.listRooms = () => list.all();

  const taken = () => new HttpError(409, 'room_exists', 'Místnost s tímto názvem už existuje', { field: 'name' });
  function assertFree(name, exceptId = null) {
    if (RESERVED.has(keyOf(name))) {
      throw badRequest('invalid_room_name', 'Tenhle název je vyhrazený, zvolte jiný', { field: 'name' });
    }
    const existing = byKey.get(keyOf(name));
    if (existing && existing.id !== exceptId) throw taken();
  }

  app.get('/rooms', async () => ({ rooms: list.all() }));

  app.get('/admin/rooms', { preHandler: requireAdmin }, async () => ({
    rooms: listWithCounts.all().map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      taskCount: r.task_count,
      openCount: r.open_count,
    })),
    unassigned: (({ task_count: taskCount, open_count: openCount }) => ({ taskCount, openCount }))(unassigned.get()),
  }));

  app.post('/admin/rooms', { preHandler: requireAdmin, schema: { body: nameBody } }, async (request, reply) => {
    const name = parseName(request.body.name);
    assertFree(name);
    if (count.get() >= config.maxRooms) {
      throw conflict('too_many_rooms', `Místností může být nejvýš ${config.maxRooms}`);
    }
    let id;
    try {
      id = Number(insert.run(name, keyOf(name), Date.now()).lastInsertRowid);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw taken();
      throw err;
    }
    request.log.info({ room: name, by: request.user.username }, 'místnost založena');
    reply.code(201);
    return { room: get.get(id) };
  });

  app.patch(
    '/admin/rooms/:id',
    { preHandler: requireAdmin, schema: { params: idParams, body: nameBody } },
    async (request) => {
      const room = get.get(request.params.id);
      if (!room) throw notFound('Místnost neexistuje');
      const name = parseName(request.body.name);
      assertFree(name, room.id);
      try {
        rename.run(name, keyOf(name), room.id);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw taken();
        throw err;
      }
      return { room: get.get(room.id) };
    },
  );

  // Smazáním místnosti úkoly nezmizí; přesunou se do „Obecné“.
  app.delete('/admin/rooms/:id', { preHandler: requireAdmin, schema: { params: idParams } }, async (request) => {
    const room = get.get(request.params.id);
    if (!room) throw notFound('Místnost neexistuje');
    remove.run(room.id);
    request.log.info({ room: room.name, by: request.user.username }, 'místnost smazána');
    return { ok: true };
  });
}

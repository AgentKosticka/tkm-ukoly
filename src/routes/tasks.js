import { badRequest, forbidden, notFound } from '../http/errors.js';

export const STATUSES = ['todo', 'doing', 'done'];
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 5000;
const DONE_PAGE = 40;
const OPEN_LIMIT = 500;
const EDIT_COALESCE_MS = 10 * 60 * 1000;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
};

// Odstraní řídicí znaky a sjednotí konce řádků; text se jinak nemění.
function cleanText(value, { multiline }) {
  let text = value.normalize('NFC').replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  text = multiline ? text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return text.trim();
}

function parseTitle(raw) {
  const title = cleanText(raw, { multiline: false }).replace(/\s+/g, ' ');
  if (title.length === 0) throw badRequest('invalid_title', 'Zadejte název úkolu', { field: 'title' });
  if ([...title].length > TITLE_MAX) {
    throw badRequest('invalid_title', `Název může mít nejvýš ${TITLE_MAX} znaků`, { field: 'title' });
  }
  return title;
}

function parseDescription(raw) {
  const description = cleanText(raw, { multiline: true });
  if ([...description].length > DESCRIPTION_MAX) {
    throw badRequest('invalid_description', `Popis může mít nejvýš ${DESCRIPTION_MAX} znaků`, {
      field: 'description',
    });
  }
  return description;
}

export default async function taskRoutes(app, { ctx }) {
  const { db, photos, requireUser } = ctx;

  const listByStatus = db.prepare(`
    SELECT t.*, u.username AS author,
           (SELECT COUNT(*) FROM photos p WHERE p.task_id = t.id) AS photo_count
    FROM tasks t LEFT JOIN users u ON u.id = t.created_by
    WHERE t.status = @status
      AND (@cursorTime IS NULL OR t.status_changed_at < @cursorTime
           OR (t.status_changed_at = @cursorTime AND t.id < @cursorId))
    ORDER BY t.status_changed_at DESC, t.id DESC
    LIMIT @limit
  `);
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status');
  const coverFor = db.prepare(
    'SELECT id, width, height, color FROM photos WHERE task_id = ? ORDER BY created_at, id LIMIT 1',
  );
  const getTask = db.prepare(`
    SELECT t.*, u.username AS author,
           (SELECT COUNT(*) FROM photos p WHERE p.task_id = t.id) AS photo_count
    FROM tasks t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?
  `);
  const photosFor = db.prepare(`
    SELECT p.id, p.width, p.height, p.color, p.created_at, p.uploaded_by, u.username AS uploader
    FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by
    WHERE p.task_id = ? ORDER BY p.created_at, p.id
  `);
  const eventsFor = db.prepare(`
    SELECT e.id, e.type, e.from_status, e.to_status, e.created_at, u.username
    FROM task_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.task_id = ? ORDER BY e.id DESC LIMIT 100
  `);
  const insertTask = db.prepare(`
    INSERT INTO tasks (title, description, status, created_by, created_at, updated_at, status_changed_at)
    VALUES (?, ?, 'todo', ?, ?, ?, ?)
  `);
  const updateTask = db.prepare(`
    UPDATE tasks SET title = ?, description = ?, status = ?, updated_at = ?, status_changed_at = ? WHERE id = ?
  `);
  const deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
  const photoIdsFor = db.prepare('SELECT id FROM photos WHERE task_id = ?').pluck();
  const lastEvent = db.prepare('SELECT type, user_id, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1');

  function summary(row, viewer) {
    const cover = coverFor.get(row.id);
    return {
      id: row.id,
      title: row.title,
      excerpt: row.description.length > 180 ? `${row.description.slice(0, 180).trimEnd()}…` : row.description,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      statusChangedAt: row.status_changed_at,
      photoCount: row.photo_count,
      cover: cover ?? null,
      // Jména členů vidí jen přihlášení; veřejnost vidí úkoly bez autorů.
      author: viewer ? row.author : undefined,
    };
  }

  function detail(row, viewer) {
    const isAdmin = viewer?.role === 'admin';
    return {
      ...summary(row, viewer),
      description: row.description,
      photos: photosFor.all(row.id).map((p) => ({
        id: p.id,
        width: p.width,
        height: p.height,
        color: p.color,
        createdAt: p.created_at,
        uploader: viewer ? p.uploader : undefined,
        canDelete: Boolean(viewer) && (isAdmin || p.uploaded_by === viewer.id),
      })),
      events: eventsFor.all(row.id).map((e) => ({
        id: e.id,
        type: e.type,
        from: e.from_status ?? undefined,
        to: e.to_status ?? undefined,
        at: e.created_at,
        user: viewer ? e.username : undefined,
      })),
      canEdit: Boolean(viewer),
      canDelete: Boolean(viewer) && (isAdmin || row.created_by === viewer.id),
    };
  }

  function page(status, viewer, limit, cursor = null) {
    const rows = listByStatus.all({
      status,
      limit: limit + 1,
      cursorTime: cursor ? cursor.time : null,
      cursorId: cursor ? cursor.id : null,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      tasks: items.map((row) => summary(row, viewer)),
      nextCursor: hasMore ? `${last.status_changed_at}.${last.id}` : null,
    };
  }

  app.get(
    '/tasks',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: STATUSES },
            cursor: { type: 'string', pattern: '^[0-9]{1,16}\\.[0-9]{1,16}$' },
          },
        },
      },
    },
    async (request) => {
      const viewer = request.viewer;
      const { status, cursor } = request.query;
      if (status) {
        const [time, id] = cursor ? cursor.split('.').map(Number) : [];
        return page(status, viewer, DONE_PAGE, cursor ? { time, id } : null);
      }
      const total = { todo: 0, doing: 0, done: 0 };
      for (const row of counts.all()) total[row.status] = row.n;
      const columns = {
        todo: page('todo', viewer, OPEN_LIMIT),
        doing: page('doing', viewer, OPEN_LIMIT),
        done: page('done', viewer, DONE_PAGE),
      };
      return { counts: total, columns };
    },
  );

  app.get('/tasks/:id', { schema: { params: idParams } }, async (request) => {
    const row = getTask.get(request.params.id);
    if (!row) throw notFound('Úkol neexistuje. Možná ho někdo smazal');
    return { task: detail(row, request.viewer) };
  });

  app.post(
    '/tasks',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: 1000 },
            description: { type: 'string', maxLength: 20000 },
          },
        },
      },
    },
    async (request, reply) => {
      const title = parseTitle(request.body.title);
      const description = parseDescription(request.body.description ?? '');
      const now = Date.now();
      const id = db.transaction(() => {
        const taskId = insertTask.run(title, description, request.user.id, now, now, now).lastInsertRowid;
        ctx.addEvent(taskId, request.user.id, 'created', null, 'todo', now);
        return Number(taskId);
      })();
      reply.code(201);
      return { task: detail(getTask.get(id), request.viewer) };
    },
  );

  app.patch(
    '/tasks/:id',
    {
      preHandler: requireUser,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: 'string', maxLength: 1000 },
            description: { type: 'string', maxLength: 20000 },
            status: { type: 'string', enum: STATUSES },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      const body = request.body;
      const title = body.title === undefined ? undefined : parseTitle(body.title);
      const description = body.description === undefined ? undefined : parseDescription(body.description);

      const updated = db.transaction(() => {
        const row = getTask.get(id);
        if (!row) return null;
        const now = Date.now();
        const next = {
          title: title ?? row.title,
          description: description ?? row.description,
          status: body.status ?? row.status,
        };
        const textChanged = next.title !== row.title || next.description !== row.description;
        const statusChanged = next.status !== row.status;
        if (!textChanged && !statusChanged) return row;

        updateTask.run(
          next.title,
          next.description,
          next.status,
          now,
          statusChanged ? now : row.status_changed_at,
          id,
        );
        if (textChanged) {
          // Několik úprav textu krátce po sobě se v historii slije do jedné.
          const last = lastEvent.get(id);
          const repeat =
            last && last.type === 'edited' && last.user_id === request.user.id && now - last.created_at < EDIT_COALESCE_MS;
          if (!repeat) ctx.addEvent(id, request.user.id, 'edited', null, null, now);
        }
        if (statusChanged) ctx.addEvent(id, request.user.id, 'status', row.status, next.status, now);
        return getTask.get(id);
      })();

      if (!updated) throw notFound('Úkol neexistuje. Možná ho někdo smazal');
      return { task: detail(updated, request.viewer) };
    },
  );

  app.delete('/tasks/:id', { preHandler: requireUser, schema: { params: idParams } }, async (request) => {
    const { id } = request.params;
    const row = getTask.get(id);
    if (!row) throw notFound('Úkol neexistuje. Možná ho už někdo smazal');
    if (request.user.role !== 'admin' && row.created_by !== request.user.id) {
      throw forbidden('Úkol může smazat jen ten, kdo ho založil, nebo správce');
    }
    const photoIds = photoIdsFor.all(id);
    deleteTask.run(id);
    await Promise.all(photoIds.map((photoId) => photos.remove(photoId)));
    return { ok: true };
  });
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { isPhotoId } from '../media/store.js';

const EVENT_COALESCE_MS = 10 * 60 * 1000;
const tooLarge = () => new HttpError(413, 'too_large', 'Fotka je větší než 20 MB');

export default async function photoRoutes(app, { ctx }) {
  const { db, config, photos, requireUser } = ctx;

  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?').pluck();
  const photoCount = db.prepare('SELECT COUNT(*) FROM photos WHERE task_id = ?').pluck();
  const insertPhoto = db.prepare(`
    INSERT INTO photos (id, task_id, uploaded_by, created_at, width, height, color,
                        source_format, source_bytes, archive_format, archive_restores_to, archive_bytes)
    VALUES (@id, @taskId, @uploadedBy, @createdAt, @width, @height, @color,
            @sourceFormat, @sourceBytes, @archiveFormat, @archiveRestoresTo, @archiveBytes)
  `);
  const getPhoto = db.prepare('SELECT * FROM photos WHERE id = ?');
  const deletePhoto = db.prepare('DELETE FROM photos WHERE id = ?');
  const touchTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
  const lastEvent = db.prepare('SELECT type, user_id, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1');

  function addCoalescedEvent(taskId, userId, type, now) {
    const last = lastEvent.get(taskId);
    if (last && last.type === type && last.user_id === userId && now - last.created_at < EVENT_COALESCE_MS) return;
    ctx.addEvent(taskId, userId, type, null, null, now);
  }

  const tooManyPhotos = () =>
    conflict('too_many_photos', `K jednomu úkolu lze přidat nejvýš ${config.maxPhotosPerTask} fotek`);

  app.post(
    '/tasks/:id/photos',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 120, timeWindow: '10 minutes' } },
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
        },
      },
    },
    async (request, reply) => {
      const taskId = request.params.id;
      if (!request.isMultipart()) throw badRequest('no_file', 'Požadavek neobsahuje fotku');

      // Hrubá kontrola předem, ať se zbytečně nepřijímá zjevně příliš velké tělo.
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > config.maxUploadBytes + 64 * 1024) throw tooLarge();

      if (!taskExists.get(taskId)) throw notFound('Úkol neexistuje. Možná ho někdo smazal');
      if (photoCount.get(taskId) >= config.maxPhotosPerTask) throw tooManyPhotos();

      const part = await request.file({
        limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 1, headerPairs: 32 },
      });
      if (!part || part.fieldname !== 'photo') throw badRequest('no_file', 'Požadavek neobsahuje fotku');

      // Dočasný soubor má náhodné jméno; název od klienta se nikde nepoužívá.
      const uploadPath = path.join(config.tmpDir, `${crypto.randomBytes(12).toString('base64url')}.upload`);
      let record;
      try {
        try {
          await pipeline(part.file, fs.createWriteStream(uploadPath, { flags: 'wx', mode: 0o600 }));
        } catch (err) {
          if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
          throw err;
        }
        if (part.file.truncated) throw tooLarge();
        record = await photos.ingest(uploadPath);
      } finally {
        await fsp.rm(uploadPath, { force: true });
      }

      const now = Date.now();
      try {
        db.transaction(() => {
          // Mezitím mohl úkol zmizet nebo se zaplnit; ověřuje se znovu uvnitř transakce.
          if (!taskExists.get(taskId)) throw notFound('Úkol neexistuje. Možná ho někdo smazal');
          if (photoCount.get(taskId) >= config.maxPhotosPerTask) throw tooManyPhotos();
          insertPhoto.run({ ...record, taskId, uploadedBy: request.user.id, createdAt: now });
          touchTask.run(now, taskId);
          addCoalescedEvent(taskId, request.user.id, 'photo_added', now);
        })();
      } catch (err) {
        await photos.remove(record.id);
        throw err;
      }

      reply.code(201);
      return {
        photo: {
          id: record.id,
          width: record.width,
          height: record.height,
          color: record.color,
          createdAt: now,
          uploader: request.user.username,
          canDelete: true,
        },
      };
    },
  );

  const photoParams = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } },
  };

  app.delete('/photos/:id', { preHandler: requireUser, schema: { params: photoParams } }, async (request) => {
    const photo = getPhoto.get(request.params.id);
    if (!photo) throw notFound('Fotka neexistuje. Možná ji už někdo smazal');
    if (request.user.role !== 'admin' && photo.uploaded_by !== request.user.id) {
      throw forbidden('Fotku může smazat jen ten, kdo ji nahrál, nebo správce');
    }
    const now = Date.now();
    db.transaction(() => {
      deletePhoto.run(photo.id);
      touchTask.run(now, photo.task_id);
      addCoalescedEvent(photo.task_id, request.user.id, 'photo_removed', now);
    })();
    await photos.remove(photo.id);
    return { ok: true };
  });

  // Originál v plné kvalitě. Rozbalení archivu stojí výpočetní čas, proto jen
  // pro přihlášené a s limitem.
  app.get(
    '/photos/:id/original',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
      schema: { params: photoParams },
    },
    async (request, reply) => {
      const photo = getPhoto.get(request.params.id);
      if (!photo || !isPhotoId(photo.id)) throw notFound('Fotka neexistuje');
      const original = await photos.original(photo);
      let stat;
      try {
        stat = await fsp.stat(original.file);
      } catch {
        await original.cleanup();
        throw notFound('Soubor s fotkou na serveru chybí');
      }
      const stream = fs.createReadStream(original.file);
      const done = () => original.cleanup().catch(() => {});
      stream.once('close', done);
      stream.once('error', done);
      reply
        .header('Content-Type', original.contentType)
        .header('Content-Length', stat.size)
        .header('Content-Disposition', `attachment; filename="ukol-${photo.task_id}-${photo.id.slice(0, 6)}.${original.extension}"`)
        .header('Cache-Control', 'private, no-store');
      return reply.send(stream);
    },
  );
}

/** Veřejné náhledy a zobrazovací verze; registruje se mimo /api. */
export async function mediaRoutes(app, { ctx }) {
  const { db, photos } = ctx;
  const getPhoto = db.prepare('SELECT id, archive_format FROM photos WHERE id = ?');

  app.get(
    '/media/:id/:variant',
    {
      config: { rateLimit: { max: 1500, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['id', 'variant'],
          properties: {
            id: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' },
            variant: { type: 'string', enum: ['thumb', 'view'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, variant } = request.params;
      const photo = getPhoto.get(id);
      const display = photo ? await photos.displayFile(photo, variant) : null;
      if (!display) {
        reply.header('Cache-Control', 'no-store');
        throw notFound('Fotka neexistuje');
      }
      reply
        .header('Content-Type', display.contentType)
        .header('Content-Length', display.size)
        // Soubor pod daným identifikátorem se nikdy nemění.
        .header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.send(fs.createReadStream(display.file));
    },
  );
}

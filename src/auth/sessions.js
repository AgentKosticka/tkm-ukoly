import crypto from 'node:crypto';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Session žijí v databázi. V cookie je náhodný token, v databázi jen jeho
 * otisk, takže únik databáze nikoho nepřihlásí.
 */
export function createSessionStore(db, config) {
  const insert = db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  const find = db.prepare(`
    SELECT s.token_hash, s.created_at AS session_created_at, s.last_seen_at, s.expires_at,
           u.id, u.username, u.role, u.status, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `);
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const removeOthers = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  return {
    create(userId, now = Date.now()) {
      const token = crypto.randomBytes(32).toString('base64url');
      insert.run(hashToken(token), userId, now, now, now + config.sessionIdleMs);
      return token;
    },

    /** Vrátí uživatele k tokenu, nebo null. Neplatné session rovnou maže. */
    resolve(token, now = Date.now()) {
      if (typeof token !== 'string' || token.length !== 43) return null;
      const tokenHash = hashToken(token);
      const row = find.get(tokenHash);
      if (!row) return null;
      const tooOld = now - row.session_created_at > config.sessionMaxMs;
      if (row.expires_at < now || tooOld || row.status !== 'approved') {
        remove.run(tokenHash);
        return null;
      }
      if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
        touch.run(now, now + config.sessionIdleMs, tokenHash);
      }
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        mustChangePassword: row.must_change_password === 1,
        tokenHash,
      };
    },

    destroy(token) {
      if (typeof token === 'string') remove.run(hashToken(token));
    },
    destroyAllForUser(userId) {
      removeForUser.run(userId);
    },
    destroyOthers(userId, tokenHash) {
      removeOthers.run(userId, tokenHash);
    },
    purgeExpired(now = Date.now()) {
      return removeExpired.run(now).changes;
    },
  };
}

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Každá migrace běží v transakci a zvyšuje PRAGMA user_version o jedna.
// Existující migrace se nemění; nové se přidávají na konec.
const migrations = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'disabled')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    approved_at INTEGER,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_login_at INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status_changed_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_status ON tasks(status, status_changed_at DESC, id DESC);

  CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    color TEXT NOT NULL,
    source_format TEXT NOT NULL CHECK (source_format IN ('jpeg', 'png', 'webp')),
    source_bytes INTEGER NOT NULL,
    archive_format TEXT NOT NULL CHECK (archive_format IN ('jxl', 'jpeg', 'png', 'webp')),
    archive_restores_to TEXT NOT NULL CHECK (archive_restores_to IN ('jpeg', 'png', 'webp')),
    archive_bytes INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX photos_task ON photos(task_id, created_at, id);

  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('created', 'status', 'edited', 'photo_added', 'photo_removed')),
    from_status TEXT,
    to_status TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX task_events_task ON task_events(task_id, id);
  `,
];

export function openDatabase(config, log = console) {
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(config.dbFile);
  const db = new Database(config.dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('trusted_schema = OFF');
  if (!existed) fs.chmodSync(config.dbFile, 0o600);

  const current = db.pragma('user_version', { simple: true });
  if (current > migrations.length) {
    db.close();
    throw new Error(
      `Databáze má novější schéma (${current}), než jaké tato verze aplikace zná (${migrations.length}).`,
    );
  }
  if (existed && current > 0 && current < migrations.length) {
    fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
    const target = path.join(config.backupDir, `pred-migraci-v${current}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    log.info?.(`Záloha databáze před migrací: ${target}`);
  }
  for (let version = current; version < migrations.length; version += 1) {
    db.transaction(() => {
      db.exec(migrations[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
  return db;
}

/** Denní záloha databáze; ponechává posledních `keep` souborů. */
export async function backupDatabase(db, config, keep = 7) {
  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(config.backupDir, `ukoly-${day}.db`);
  await db.backup(target);
  const old = fs
    .readdirSync(config.backupDir)
    .filter((name) => /^ukoly-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .slice(0, -keep);
  for (const name of old) fs.rmSync(path.join(config.backupDir, name), { force: true });
  return target;
}

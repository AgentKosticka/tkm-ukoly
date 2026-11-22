import { buildApp } from './app.js';
import { ensureAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { backupDatabase } from './db.js';

const HOUR = 60 * 60 * 1000;

const config = loadConfig();
const app = await buildApp(config);
const { db, sessions, photos } = app.ctx;

await ensureAdmin(db, config, app.log);

if (!photos.jxlAvailable) {
  app.log.warn('Bez JPEG XL: originály fotek se ukládají jako očištěný JPEG nebo bezeztrátový WebP');
}

const housekeeping = setInterval(() => {
  try {
    sessions.purgeExpired();
  } catch (err) {
    app.log.error({ err }, 'úklid session selhal');
  }
}, HOUR);
housekeeping.unref();

async function backup() {
  try {
    const file = await backupDatabase(db, config);
    app.log.info(`Záloha databáze: ${file}`);
  } catch (err) {
    app.log.error({ err }, 'záloha databáze selhala');
  }
}
const backups = setInterval(backup, 24 * HOUR);
backups.unref();
setTimeout(backup, 60 * 1000).unref();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info(`Přijat ${signal}, ukončuji`);
  // Pojistka pro případ, že by některé spojení nešlo zavřít.
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });

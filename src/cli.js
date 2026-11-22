// Nouzová správa účtů z příkazové řádky, např. když se správce nemůže přihlásit:
//   docker compose exec app node src/cli.js uzivatele
//   docker compose exec app node src/cli.js reset-hesla <jméno>
//   docker compose exec app node src/cli.js spravce <jméno>
import { generatePassword, hashPassword } from './auth/passwords.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

const [command, username] = process.argv.slice(2);
const config = loadConfig();
const db = openDatabase(config);

function findUser() {
  if (!username) {
    console.error('Chybí uživatelské jméno');
    process.exit(2);
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`Uživatel „${username}“ neexistuje`);
    process.exit(1);
  }
  return user;
}

try {
  if (command === 'uzivatele') {
    const rows = db.prepare('SELECT username, role, status, created_at FROM users ORDER BY id').all();
    for (const row of rows) {
      const created = new Date(row.created_at).toISOString().slice(0, 10);
      console.log(`${row.username.padEnd(34)}${row.role.padEnd(7)}${row.status.padEnd(10)}${created}`);
    }
    if (rows.length === 0) console.log('Žádní uživatelé');
  } else if (command === 'reset-hesla') {
    const user = findUser();
    const password = generatePassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
      await hashPassword(password, config.scryptCost),
      user.id,
    );
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    console.log(`Dočasné heslo pro „${user.username}“: ${password}`);
    console.log('Po přihlášení bude nutné heslo změnit.');
  } else if (command === 'spravce') {
    const user = findUser();
    db.prepare("UPDATE users SET role = 'admin', status = 'approved', approved_at = COALESCE(approved_at, ?) WHERE id = ?").run(
      Date.now(),
      user.id,
    );
    console.log(`„${user.username}“ je teď schválený správce.`);
  } else {
    console.log('Použití: node src/cli.js <uzivatele | reset-hesla <jméno> | spravce <jméno>>');
    process.exitCode = command ? 2 : 0;
  }
} finally {
  db.close();
}

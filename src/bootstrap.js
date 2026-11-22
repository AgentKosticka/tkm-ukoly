import { generatePassword, hashPassword, passwordProblem, usernameProblem } from './auth/passwords.js';

/**
 * Zajistí, že existuje aspoň jeden aktivní správce. Volá se při každém startu;
 * pokud správce už je, nic nedělá.
 *
 * Heslo se bere z ADMIN_PASSWORD. Když chybí, vygeneruje se náhodné, vypíše se
 * jednou do logu a správce si ho při prvním přihlášení musí změnit.
 */
export async function ensureAdmin(db, config, log) {
  const admins = db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'approved'").pluck().get();
  if (admins > 0) return null;

  const username = config.adminUsername;
  const nameIssue = usernameProblem(username);
  if (nameIssue) throw new Error(`ADMIN_USERNAME: ${nameIssue}`);

  let password = config.adminPassword;
  const generated = !password;
  if (generated) {
    password = generatePassword();
  } else {
    const issue = passwordProblem(password, username);
    if (issue) throw new Error(`ADMIN_PASSWORD: ${issue}`);
  }

  const hash = await hashPassword(password, config.scryptCost);
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare(
      "UPDATE users SET password_hash = ?, role = 'admin', status = 'approved', must_change_password = ?, approved_at = ? WHERE id = ?",
    ).run(hash, generated ? 1 : 0, now, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO users (username, password_hash, role, status, must_change_password, created_at, approved_at) VALUES (?, ?, 'admin', 'approved', ?, ?, ?)",
    ).run(username, hash, generated ? 1 : 0, now, now);
  }

  if (generated) {
    const line = '='.repeat(64);
    log.warn(
      `\n${line}\n  Vytvořen účet správce\n  Jméno: ${username}\n  Heslo: ${password}\n  Heslo si po prvním přihlášení změňte. Znovu se už nezobrazí.\n${line}`,
    );
  } else {
    log.info(`Vytvořen účet správce „${username}“ s heslem z ADMIN_PASSWORD`);
  }
  return { username, generated };
}

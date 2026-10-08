// Sets an account's password from the command line (for admins with database access):
//   npm --prefix server run set-password -- <username> <new password>
// Unlocks the account, clears "must change password" and signs it out everywhere.

import { hashPassword } from "./auth.js";
import { pool } from "./db.js";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("Usage: npm --prefix server run set-password -- <username> <new password>");
  process.exit(1);
}
const { rows } = await pool.query(
  `update user_accounts set password_hash = $2, must_change_password = false, failed_attempts = 0, locked_until = null
    where lower(username) = lower($1) returning id, username`,
  [username, await hashPassword(password)],
);
if (!rows[0]) {
  console.error(`No account with username "${username}".`);
  process.exitCode = 1;
} else {
  await pool.query(`delete from user_sessions where account_id = $1`, [rows[0].id]);
  await pool.query(`insert into audit_log (actor_name, module, action, target, detail) values ('Command line', 'Administration', 'Reset password', $1, 'set-password script')`, [rows[0].username]);
  console.log(`Password set for ${rows[0].username}.`);
}
await pool.end();

// Creates a host login (or resets its password) and prints the password ONCE.
//
//   node scripts/make-user.mjs lychhayly 1            create user "lychhayly" for customer 1
//   node scripts/make-user.mjs lychhayly --reset      new password for an existing user
//   add --local to do it on your own computer's test database instead of the live one
//
// The password is made here, on your computer. It is never written to a file or to GitHub.

import { pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const plain = args.filter((a) => !a.startsWith('--'));
const reset = flags.includes('--reset');
const local = flags.includes('--local');
const [username, customerId] = plain;

if (!username || !/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username) || (!reset && !/^\d+$/.test(customerId || ''))) {
  console.log('Usage:\n  node scripts/make-user.mjs <username> <customer-number> [--local]\n  node scripts/make-user.mjs <username> --reset [--local]');
  console.log('The username is 3 to 30 characters: a-z, 0-9, dot, dash or underscore.');
  process.exit(1);
}

// Easy to read out loud: no 0/o, 1/l/i.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const password = [group(), group(), group(), group()].join('-');

const ITER = 100000; // the most Cloudflare Workers allows; must match src/host.js
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITER, 32, 'sha256');
const stored = `pbkdf2$${ITER}$${salt.toString('base64')}$${hash.toString('base64')}`;

const sql = reset
  ? `UPDATE users SET pw_hash = '${stored}', pw_changed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), disabled_at = NULL WHERE username = '${username}';\n` +
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = '${username}');\n` +
    `DELETE FROM login_attempts WHERE username = '${username}';\n`
  : `INSERT INTO users (customer_id, username, pw_hash) VALUES (${customerId}, '${username}', '${stored}');\n`;

const file = '.tmp-make-user.sql';
writeFileSync(file, sql);
let status = 1;
try {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'mongkulcard', local ? '--local' : '--remote', `--file=${file}`], { stdio: 'inherit', shell: true });
  status = r.status ?? 1;
} finally {
  rmSync(file, { force: true });
}

if (status !== 0) {
  console.log('\nSomething went wrong, so NO password was set. Read the message above.');
  process.exit(1);
}
console.log('\n==============================================');
console.log(reset ? ' Password changed for: ' + username : ' Login created');
console.log('   Address :  /login/' + username);
console.log('   Username:  ' + username);
console.log('   Password:  ' + password);
console.log(' Copy it now. It is shown only this once.');
console.log(' Send it to the customer privately (not in a group chat).');
console.log('==============================================');

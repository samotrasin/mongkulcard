// MongkulCard: host login and the guest-link manager.
//
//   /login, /login/<username>   sign-in page (the username is only pre-filled)
//   /manage                     the manage page (needs a sign-in)
//   /app/<file>                 the page's script and style
//   /api/...                    what the manage page talks to

const enc = new TextEncoder();

const PBKDF2_ITERATIONS = 100000;   // 100,000 is the most Cloudflare Workers allows
const SESSION_DAYS = 30;
const COOKIE = 'mc_session';
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // same 31 symbols as the database rule
const MAX_NAMES_PER_REQUEST = 500;
const MAX_GUESTS_PER_EVENT = 5000;  // safety rail only
const APP_FILES = { 'login.js': 'text/javascript', 'manage.js': 'text/javascript', 'app.css': 'text/css' };

const FAIL_WINDOW = "-15 minutes";
const MAX_FAILS_USER = 5;
const MAX_FAILS_IP = 30;

// ---------------------------------------------------------------- entry points

export async function hostPage(request, env, url, parts) {
  const session = await getSession(request, env);

  if (parts[0] === 'login') {
    if (parts.length > 2 || (parts[1] && !USER_RE.test(parts[1]))) return null;
    if (session) return redirect('/manage');
    return staticPage(env, url, '/app/login.html');
  }
  // /manage
  if (!session) return redirect('/login');
  return staticPage(env, url, '/app/manage.html');
}

export async function appFile(request, env, url, file) {
  const type = APP_FILES[file];
  if (!type) return null;
  const res = await env.ASSETS.fetch(new URL(`/app/${file}`, url));
  if (!res.ok) return null;
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
  });
}

export async function api(request, env, ctx, url, parts) {
  const method = request.method;
  const route = parts.slice(1).join('/');

  // Anything that changes data must come from our own pages.
  if (method !== 'GET') {
    if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
    if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      return json({ error: 'Not allowed.' }, 415);
    }
  }

  if (route === 'login' && method === 'POST') return login(request, env, url);

  const session = await getSession(request, env);
  if (!session) return json({ error: 'Please sign in again.' }, 401);

  if (route === 'me' && method === 'GET') return me(env, session);
  if (route === 'logout' && method === 'POST') return logout(env, url, session);
  if (route === 'password' && method === 'POST') return changePassword(request, env, session);
  if (route === 'guests' && method === 'GET') return listGuests(env, session, url);
  if (route === 'guests' && method === 'POST') return addGuests(request, env, session);

  const m = /^guests\/(\d{1,12})$/.exec(route);
  if (m && method === 'PATCH') return renameGuest(request, env, session, Number(m[1]));
  if (m && method === 'DELETE') return deleteGuest(env, session, Number(m[1]));

  return json({ error: 'Not found.' }, 404);
}

// ---------------------------------------------------------------- sign in / out

async function login(request, env, url) {
  const body = await readJson(request);
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const GENERIC = { error: 'Wrong username or password.' };

  if (!username || !password || username.length > 60 || password.length > 200) return json(GENERIC, 401);

  const locked = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM login_attempts WHERE username = ?1 AND at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?3)) AS u,
       (SELECT COUNT(*) FROM login_attempts WHERE ip = ?2       AND at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?3)) AS i`
  ).bind(username, ip, FAIL_WINDOW).first();
  if (locked.u >= MAX_FAILS_USER || locked.i >= MAX_FAILS_IP) {
    return json({ error: 'Too many wrong attempts. Please wait 15 minutes and try again.' }, 429);
  }

  const user = USER_RE.test(username)
    ? await env.DB.prepare(`SELECT id, customer_id, pw_hash, disabled_at FROM users WHERE username = ?1`).bind(username).first()
    : null;

  // Always do the same amount of work, so the answer time does not reveal whether the username exists.
  const passwordOk = await verifyPassword(password, user ? user.pw_hash : DUMMY_HASH);
  if (!user || user.disabled_at || !passwordOk) {
    await env.DB.prepare(`INSERT INTO login_attempts (username, ip) VALUES (?1, ?2)`).bind(username.slice(0, 60), ip).run();
    return json(GENERIC, 401);
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (user_id, token_hash, expires_at, last_seen_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now','+${SESSION_DAYS} days'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
    ).bind(user.id, tokenHash),
    env.DB.prepare(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1`).bind(user.id),
    env.DB.prepare(`DELETE FROM login_attempts WHERE username = ?1`).bind(username),
    env.DB.prepare(`DELETE FROM login_attempts WHERE at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')`),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')`),
    audit(env, null, username, 'host.login', 'user', user.id, null),
  ]);

  return json({ ok: true }, 200, { 'set-cookie': cookie(token, url, SESSION_DAYS * 86400) });
}

async function logout(env, url, session) {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(session.session_id).run();
  return json({ ok: true }, 200, { 'set-cookie': cookie('', url, 0) });
}

async function changePassword(request, env, session) {
  const body = await readJson(request);
  const current = typeof body?.current === 'string' ? body.current : '';
  const next = typeof body?.next === 'string' ? body.next : '';
  const ip = request.headers.get('cf-connecting-ip') || 'local';

  if (next.length < 10) return json({ error: 'The new password must be at least 10 characters.' }, 400);
  if (next.length > 200) return json({ error: 'The new password is too long.' }, 400);

  const fails = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE username = ?1 AND at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?2)`
  ).bind(session.username, FAIL_WINDOW).first();
  if (fails.n >= MAX_FAILS_USER) return json({ error: 'Too many wrong attempts. Please wait 15 minutes.' }, 429);

  const row = await env.DB.prepare(`SELECT pw_hash FROM users WHERE id = ?1`).bind(session.user_id).first();
  if (!(await verifyPassword(current, row.pw_hash))) {
    await env.DB.prepare(`INSERT INTO login_attempts (username, ip) VALUES (?1, ?2)`).bind(session.username, ip).run();
    return json({ error: 'Your current password is not correct.' }, 400);
  }

  const newHash = await hashPassword(next);
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET pw_hash = ?1, pw_changed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?2`).bind(newHash, session.user_id),
    // every other device is signed out
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND id != ?2`).bind(session.user_id, session.session_id),
    audit(env, null, session.username, 'host.password_changed', 'user', session.user_id, null),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- the manage page's data

async function me(env, session) {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title_en, event_date, status, links_expire_at
       FROM events
      WHERE customer_id = ?1 AND status != 'archived'
      ORDER BY event_date, id`
  ).bind(session.customer_id).all();
  return json({ username: session.username, customer: session.customer_name, events: results });
}

async function ownedEvent(env, session, eventId) {
  if (!Number.isInteger(eventId) || eventId < 1) return null;
  return env.DB.prepare(
    `SELECT id, slug, title_en FROM events WHERE id = ?1 AND customer_id = ?2 AND status != 'archived'`
  ).bind(eventId, session.customer_id).first();
}

async function listGuests(env, session, url) {
  const ev = await ownedEvent(env, session, Number(url.searchParams.get('event')));
  if (!ev) return json({ error: 'Not found.' }, 404);
  const { results } = await env.DB.prepare(
    `SELECT id, code, display_name AS name, open_count AS opens, first_opened_at AS first_opened, last_opened_at AS last_opened
       FROM guests WHERE event_id = ?1 AND deleted_at IS NULL AND is_disabled = 0
      ORDER BY id`
  ).bind(ev.id).all();
  return json({ slug: ev.slug, guests: results });
}

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function addGuests(request, env, session) {
  const body = await readJson(request);
  const ev = await ownedEvent(env, session, Number(body?.event));
  if (!ev) return json({ error: 'Not found.' }, 404);
  if (!Array.isArray(body.names)) return json({ error: 'No names received.' }, 400);
  if (body.names.length > MAX_NAMES_PER_REQUEST) {
    return json({ error: `Please add at most ${MAX_NAMES_PER_REQUEST} names at a time.` }, 400);
  }

  const names = [];
  let skipped = 0;
  for (const raw of body.names) {
    const n = cleanName(raw);
    if (!n) { skipped++; continue; }
    if (n.length > 120) return json({ error: 'A name is too long (120 characters at most): ' + n.slice(0, 30) + '…' }, 400);
    names.push(n);
  }
  if (names.length === 0) return json({ error: 'Please type a name.' }, 400);

  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM guests WHERE event_id = ?1 AND deleted_at IS NULL`).bind(ev.id).first();
  if (count.n + names.length > MAX_GUESTS_PER_EVENT) return json({ error: 'That is more guests than we can handle for one invitation. Please contact us.' }, 400);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const statements = names.map((n) =>
        env.DB.prepare(
          `INSERT INTO guests (event_id, code, display_name, source) VALUES (?1, ?2, ?3, ?4)
           RETURNING id, code, display_name AS name, open_count AS opens, first_opened_at AS first_opened, last_opened_at AS last_opened`
        ).bind(ev.id, newCode(), n, names.length > 1 ? 'import' : 'manual')
      );
      statements.push(audit(env, ev.id, session.username, 'guests.added', 'guest', null, { count: names.length }));
      const out = await env.DB.batch(statements);
      const guests = out.slice(0, names.length).map((r) => r.results[0]);
      return json({ guests, skipped });
    } catch (e) {
      // Only a repeated random code can cause this, so try again with new codes.
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    }
  }
  return json({ error: 'Something went wrong. Please try again.' }, 500);
}

async function renameGuest(request, env, session, id) {
  const body = await readJson(request);
  const name = cleanName(body?.name);
  if (!name) return json({ error: 'Please type a name.' }, 400);
  if (name.length > 120) return json({ error: 'The name is too long (120 characters at most).' }, 400);

  const g = await findGuest(env, session, id);
  if (!g) return json({ error: 'Not found.' }, 404);
  await env.DB.batch([
    env.DB.prepare(`UPDATE guests SET display_name = ?1 WHERE id = ?2`).bind(name, id),
    audit(env, g.event_id, session.username, 'guest.renamed', 'guest', id, null),
  ]);
  return json({ ok: true, name });
}

async function deleteGuest(env, session, id) {
  const g = await findGuest(env, session, id);
  if (!g) return json({ error: 'Not found.' }, 404);
  // Soft delete: the link stops working at once, the row stays for our records.
  await env.DB.batch([
    env.DB.prepare(`UPDATE guests SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1`).bind(id),
    audit(env, g.event_id, session.username, 'guest.deleted', 'guest', id, null),
  ]);
  return json({ ok: true });
}

// A guest, but only if it belongs to one of this customer's events.
function findGuest(env, session, id) {
  return env.DB.prepare(
    `SELECT g.id, g.event_id FROM guests g JOIN events e ON e.id = g.event_id
      WHERE g.id = ?1 AND e.customer_id = ?2 AND e.status != 'archived' AND g.deleted_at IS NULL`
  ).bind(id, session.customer_id).first();
}

// ---------------------------------------------------------------- sessions

async function getSession(request, env) {
  const raw = request.headers.get('cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(raw);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, u.id AS user_id, u.username, u.customer_id, c.name AS customer_name
       FROM sessions s
       JOIN users u     ON u.id = s.user_id
       JOIN customers c ON c.id = u.customer_id
      WHERE s.token_hash = ?1 AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now') AND u.disabled_at IS NULL`
  ).bind(await sha256Hex(m[1])).first();
  return row || null;
}

function cookie(value, url, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------- passwords and randomness

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // 43 characters
}
async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(h)}`;
}
async function verifyPassword(password, stored) {
  const p = String(stored).split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const iterations = Number(p[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100000) return false;
  const want = unb64(p[3]);
  const got = await pbkdf2(password, unb64(p[2]), iterations);
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
// Used when the username does not exist, so the work done is the same.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$${b64(new Uint8Array(32))}`;

// A guest code: 7 characters, picked without bias.
function newCode() {
  let out = '';
  while (out.length < 7) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < 7) out += CODE_CHARS[b % 31]; // 248 = 31 * 8, so every symbol is equally likely
    }
  }
  return out;
}

// ---------------------------------------------------------------- small helpers

function audit(env, eventId, who, action, entityType, entityId, detail) {
  return env.DB.prepare(
    `INSERT INTO audit_log (event_id, actor_type, actor_ref, action, entity_type, entity_id, detail)
     VALUES (?1, 'host', ?2, ?3, ?4, ?5, ?6)`
  ).bind(eventId, who, action, entityType, entityId, detail ? JSON.stringify(detail) : null);
}

async function readJson(request) {
  try {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > 200000) return null;
    const text = await request.text();
    if (text.length > 200000) return null;
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const SECURITY_HEADERS = {
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cache-control': 'private, no-store',
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}

function redirect(to) {
  return new Response(null, { status: 302, headers: { location: to, ...SECURITY_HEADERS } });
}

async function staticPage(env, url, path) {
  const res = await env.ASSETS.fetch(new URL(path, url));
  if (!res.ok) return new Response('Page missing', { status: 500 });
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...SECURITY_HEADERS,
      'content-security-policy':
        "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

// MongkulCard: customer accounts for the self-service website.
//
//   /signin                 sign-in page ("Log in with Telegram" button)
//   /auth/telegram          Telegram sends the customer back here after they confirm
//   /account                the signed-in customer's page
//   /site/<file>            the pages' script and style
//   /api/account/me         who is signed in (JSON)
//   /api/account/logout     sign out (POST)
//   /tg/webhook             messages to the MongkulCard bot (phone number sharing)
//
// Settings (Cloudflare > Workers > mongkulcard > Settings > Variables and Secrets):
//   TELEGRAM_BOT_TOKEN       secret, from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  secret, any long random text; also given to Telegram's setWebhook
//   TELEGRAM_BOT_USERNAME    the bot's @name without the @ (in wrangler.jsonc "vars")
//
// This is separate from the host login in host.js (/login, /manage), which keeps working as before.

import { paymentCallback } from './payments.js';

const enc = new TextEncoder();
const COOKIE = 'mc_acct';          // different from host.js's mc_session
const NEXT_COOKIE = 'mc_next';     // where to go after Telegram sends the customer back
const SESSION_DAYS = 60;
const AUTH_MAX_AGE = 24 * 3600;    // a Telegram confirmation older than a day is refused
const SITE_FILES = { 'site.js': 'text/javascript', 'site.css': 'text/css' };

// ---------------------------------------------------------------- pages

export async function siteRoute(request, env, ctx, url, parts) {
  const p = parts[0];

  if (p === 'site' && parts.length === 2) {
    const type = SITE_FILES[parts[1]];
    if (!type) return null;
    const res = await env.ASSETS.fetch(new URL(`/site/${parts[1]}`, url));
    if (!res.ok) return null;
    return new Response(res.body, { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
  }

  if (p === 'signin' && parts.length === 1) {
    const next = safeNext(url.searchParams.get('next'));
    if (await getAccount(request, env)) return redirect(next);
    const bot = (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
    const html = (await pageText(env, url, '/site/signin.html'))
      .replace('__BOT__', /^[A-Za-z0-9_]{5,32}$/.test(bot) ? bot : '')
      .replace('__AUTH_URL__', `${url.origin}/auth/telegram`);
    return htmlPage(html, { 'set-cookie': `${NEXT_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax${secure(url)}` });
  }

  if (p === 'auth' && parts[1] === 'telegram' && parts.length === 2) return telegramCallback(request, env, url);

  if (p === 'account' && parts.length === 1) {
    if (!(await getAccount(request, env))) return redirect('/signin?next=/account');
    const bot = (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
    return htmlPage((await pageText(env, url, '/site/account.html')).replace(/__BOT__/g, /^[A-Za-z0-9_]{5,32}$/.test(bot) ? bot : ''));
  }

  if (p === 'tg' && parts[1] === 'webhook' && parts.length === 2 && request.method === 'POST') return telegramWebhook(request, env, ctx);

  return null;
}

// /api/account/...
export async function accountApi(request, env, url, parts) {
  const route = parts.slice(2).join('/');
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);

  if (route === 'me' && request.method === 'GET') {
    const a = await getAccount(request, env);
    if (!a) return json({ signedIn: false });
    return json({
      signedIn: true,
      name: a.name,
      username: a.telegram_username || null,
      photo: a.photo_url || null,
      phoneShared: !!a.phone_verified_at,
      phoneEnding: a.phone ? a.phone.slice(-3) : null,
      since: a.created_at,
    });
  }
  if (route === 'logout' && request.method === 'POST') {
    const token = readCookie(request, COOKIE);
    if (token) await env.DB.prepare(`DELETE FROM account_sessions WHERE token_hash = ?1`).bind(await sha256Hex(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', url, 0) });
  }
  return json({ error: 'Not found.' }, 404);
}

// ---------------------------------------------------------------- Telegram login
// Telegram's "Log in with Telegram" button sends the customer to /auth/telegram?id=..&first_name=..&auth_date=..&hash=..
// We check the hash with the bot token (https://core.telegram.org/widgets/login#checking-authorization).

async function telegramCallback(request, env, url) {
  if (!env.TELEGRAM_BOT_TOKEN) return htmlPage(shellMessage('Telegram sign-in is not set up yet.', 'ការចូលតាម Telegram មិនទាន់ដំណើរការនៅឡើយទេ។'), {}, 503);

  const q = url.searchParams;
  const hash = q.get('hash') || '';
  const fields = {};
  for (const [k, v] of q) if (k !== 'hash') fields[k] = v;

  const ok = /^[0-9a-f]{64}$/.test(hash) && fields.id && /^\d{1,20}$/.test(fields.id) && /^\d{1,12}$/.test(fields.auth_date || '')
    && (await telegramHash(fields, env.TELEGRAM_BOT_TOKEN)) === hash
    && Date.now() / 1000 - Number(fields.auth_date) < AUTH_MAX_AGE;
  if (!ok) return htmlPage(shellMessage('That sign-in link is not valid or has expired. Please try again.', 'តំណចូលនេះមិនត្រឹមត្រូវ ឬផុតកំណត់ហើយ។ សូមព្យាយាមម្ដងទៀត។', '/signin'), {}, 400);

  const name = [fields.first_name, fields.last_name].filter(Boolean).join(' ').trim().slice(0, 120) || 'Telegram user';
  const photo = /^https:\/\/[a-z0-9.-]*(telegram\.org|t\.me)\//i.test(fields.photo_url || '') ? fields.photo_url.slice(0, 500) : null;
  const username = /^[A-Za-z0-9_]{3,32}$/.test(fields.username || '') ? fields.username : null;

  await env.DB.prepare(
    `INSERT INTO accounts (telegram_id, telegram_username, name, photo_url, last_login_at)
     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(telegram_id) DO UPDATE SET
       telegram_username = excluded.telegram_username, name = excluded.name,
       photo_url = excluded.photo_url, last_login_at = excluded.last_login_at`
  ).bind(Number(fields.id), username, name, photo).run();

  const acct = await env.DB.prepare(`SELECT id, disabled_at FROM accounts WHERE telegram_id = ?1`).bind(Number(fields.id)).first();
  if (!acct || acct.disabled_at) return htmlPage(shellMessage('This account is switched off. Please contact MongkulCard on Telegram.', 'គណនីនេះត្រូវបានបិទ។ សូមទាក់ទង MongkulCard តាម Telegram។'), {}, 403);

  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO account_sessions (account_id, token_hash, expires_at, last_seen_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now','+${SESSION_DAYS} days'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
    ).bind(acct.id, await sha256Hex(token)),
    env.DB.prepare(`DELETE FROM account_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')`),
  ]);

  let next = '/account';
  try { next = safeNext(decodeURIComponent(readCookie(request, NEXT_COOKIE) || '')); } catch { /* keep /account */ }
  const headers = new Headers({ location: next, ...SECURITY_HEADERS });
  headers.append('set-cookie', sessionCookie(token, url, SESSION_DAYS * 86400));
  headers.append('set-cookie', `${NEXT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(url)}`);
  return new Response(null, { status: 302, headers });
}

async function telegramHash(fields, botToken) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secretKey = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
  const key = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(check)));
}

// ---------------------------------------------------------------- Telegram bot (phone number)
// The customer opens t.me/<bot>?start=phone, taps "Share my phone number", and Telegram sends us their own number.
// Only a contact whose user_id is the sender's own id is accepted, so nobody can attach someone else's number.

async function telegramWebhook(request, env, ctx) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response('ok'); }
  if (update && update.callback_query) {           // Samotra's Unlock / Not received buttons
    await paymentCallback(update.callback_query, env, ctx);
    return new Response('ok');
  }
  const msg = update && update.message;
  if (!msg || !msg.from || msg.chat?.type !== 'private') return new Response('ok');
  const from = msg.from;

  if (msg.contact) {
    if (msg.contact.user_id !== from.id) {
      ctx.waitUntil(botSend(env, msg.chat.id, 'សូមចែករំលែកលេខទូរស័ព្ទរបស់អ្នកផ្ទាល់ ដោយចុចប៊ូតុងខាងក្រោម។\nPlease share your own number with the button below.', phoneKeyboard()));
      return new Response('ok');
    }
    const phone = '+' + String(msg.contact.phone_number || '').replace(/[^0-9]/g, '');
    if (phone.length < 7 || phone.length > 20) return new Response('ok');
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim().slice(0, 120) || 'Telegram user';
    await env.DB.prepare(
      `INSERT INTO accounts (telegram_id, telegram_username, name, phone, phone_verified_at, bot_can_message)
       VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 1)
       ON CONFLICT(telegram_id) DO UPDATE SET phone = excluded.phone, phone_verified_at = excluded.phone_verified_at, bot_can_message = 1`
    ).bind(from.id, /^[A-Za-z0-9_]{3,32}$/.test(from.username || '') ? from.username : null, name, phone).run();
    ctx.waitUntil(botSend(env, msg.chat.id,
      'អរគុណ! យើងបានរក្សាទុកលេខទូរស័ព្ទរបស់អ្នក ✓\nThank you! Your phone number is saved ✓\n\nhttps://mongkulcard.com/account',
      { remove_keyboard: true }));
    return new Response('ok');
  }

  if (typeof msg.text === 'string' && msg.text.startsWith('/start')) {
    await env.DB.prepare(`UPDATE accounts SET bot_can_message = 1 WHERE telegram_id = ?1`).bind(from.id).run();
    ctx.waitUntil(botSend(env, msg.chat.id,
      'សូមស្វាគមន៍មកកាន់ MongkulCard ✦\nសូមចុចប៊ូតុងខាងក្រោម ដើម្បីចែករំលែកលេខទូរស័ព្ទ។ យើងប្រើវាតែសម្រាប់ជួយអ្នក ពេលមានបញ្ហាជាមួយធៀប។\n\n' +
      'Welcome to MongkulCard ✦\nTap the button below to share your phone number. We only use it to help you with your invitation.',
      phoneKeyboard()));
  }
  return new Response('ok');
}

function phoneKeyboard() {
  return { keyboard: [[{ text: '📱 ចែករំលែកលេខទូរស័ព្ទ · Share my phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
}

export async function botSend(env, chatId, text, replyMarkup) {
  return botCall(env, 'sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup, disable_web_page_preview: true });
}

export async function botCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await fetch(`${env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {   // TELEGRAM_API_BASE only for local tests
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return await r.json().catch(() => null);
  } catch { return null; }   // a failed message never breaks the request
}

// ---------------------------------------------------------------- sessions

export async function getAccount(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT a.id, a.telegram_id, a.name, a.telegram_username, a.photo_url, a.phone, a.phone_verified_at, a.created_at, s.id AS session_id
       FROM account_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ?1 AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now') AND a.disabled_at IS NULL`
  ).bind(await sha256Hex(token)).first();
  return row || null;
}

function sessionCookie(value, url, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure(url)}`;
}
function secure(url) { return url.protocol === 'https:' ? '; Secure' : ''; }

function readCookie(request, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(request.headers.get('cookie') || '');
  return m ? m[1] : null;
}

// Only our own pages, never another site.
function safeNext(v) {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\') || v.length > 200) return '/account';
  return v;
}

// ---------------------------------------------------------------- helpers

const SECURITY_HEADERS = {
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cache-control': 'private, no-store',
};
const PAGE_CSP =
  "default-src 'none'; script-src 'self' https://telegram.org; frame-src https://oauth.telegram.org; " +
  "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; " +
  "img-src 'self' data: https://t.me https://*.telegram.org https://*.telesco.pe; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function pageText(env, url, path) {
  const res = await env.ASSETS.fetch(new URL(path, url));
  if (!res.ok) throw new Error('Page missing: ' + path);
  return res.text();
}
function htmlPage(html, extra = {}, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, 'content-security-policy': PAGE_CSP, ...extra } });
}
function shellMessage(en, km, back) {
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MongkulCard</title><link rel="stylesheet" href="/site/site.css"></head>
<body class="center-page"><main class="card-box"><div class="brand">MONGKULCARD</div><p class="km">${km}</p><p>${en}</p>
<a class="btn gold" href="${back || '/'}">${back ? 'ព្យាយាមម្ដងទៀត · Try again' : 'ទំព័រដើម · Home'}</a></main></body></html>`;
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra } });
}
function redirect(to) {
  return new Response(null, { status: 302, headers: { location: to, ...SECURITY_HEADERS } });
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

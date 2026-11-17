// MongkulCard: customer accounts for the self-service website.
//
//   /signin                 sign-in page ("Log in with Telegram" button)
//   /auth/telegram          Telegram sends the customer back here after they confirm
//   /account                the signed-in customer's page
//   /site/<file>            the pages' script and style
//   /api/account/me         who is signed in (JSON)
//   /api/account/logout     sign out (POST)
//   /api/account/botlogin   sign in through the MongkulCard bot (POST starts, GET checks); works inside Facebook/Messenger
//   /tg/webhook             messages to the MongkulCard bot: phone sharing, bot sign-in, customer chat ("MongkulCard Service")
//
// Settings (Cloudflare > Workers > mongkulcard > Settings > Variables and Secrets):
//   TELEGRAM_BOT_TOKEN       secret, from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  secret, any long random text; also given to Telegram's setWebhook
//   TELEGRAM_BOT_USERNAME    the bot's @name without the @ (in wrangler.jsonc "vars")
//
// This is separate from the host login in host.js (/login, /manage), which keeps working as before.

import { paymentCallback, normalizePhone, adminTelegramId } from './payments.js';

const enc = new TextEncoder();
const COOKIE = 'mc_acct';          // different from host.js's mc_session
const NEXT_COOKIE = 'mc_next';     // where to go after Telegram sends the customer back
const LOGIN_COOKIE = 'mc_login';   // the browser's half of a bot sign-in
const LOGIN_MINUTES = 10;
const HOME_NEXT = '/preview/#dashboard';
const WELCOME =
  'សួស្ដី 👋 នេះជា MongkulCard Service ✦\nសរសេរសំណួររបស់អ្នកនៅទីនេះ (អាចផ្ញើរូបថតបាន) យើងនឹងឆ្លើយក្នុង chat នេះ។\n\n' +
      'Hello 👋 This is MongkulCard Service ✦\nWrite your question here (photos are fine too) and we will answer in this chat.\n\nhttps://mongkulcard.com/preview/';
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

  if ((p === 'terms' || p === 'privacy') && parts.length === 1) {
    return htmlPage(await pageText(env, url, `/site/${p}.html`), { 'cache-control': 'public, max-age=600', 'x-robots-tag': 'all' });
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
      admin: !!(env.ADMIN_PHONE && a.phone_verified_at && a.phone === normalizePhone(env.ADMIN_PHONE)),
      since: a.created_at,
    });
  }
  if (route === 'botlogin' && request.method === 'POST') return botLoginStart(request, env, url);
  if (route === 'botlogin' && request.method === 'GET') return botLoginCheck(request, env, url);
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

  const token = await newSession(env, acct.id);
  let next = HOME_NEXT;
  try { next = safeNext(decodeURIComponent(readCookie(request, NEXT_COOKIE) || '')); } catch { /* keep the default */ }
  const headers = new Headers({ location: next, ...SECURITY_HEADERS });
  headers.append('set-cookie', sessionCookie(token, url, SESSION_DAYS * 86400));
  headers.append('set-cookie', `${NEXT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(url)}`);
  return new Response(null, { status: 302, headers });
}

async function newSession(env, accountId) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO account_sessions (account_id, token_hash, expires_at, last_seen_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now','+${SESSION_DAYS} days'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
    ).bind(accountId, await sha256Hex(token)),
    env.DB.prepare(`DELETE FROM account_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')`),
  ]);
  return token;
}

// ---------------------------------------------------------------- sign in through the bot
// Telegram's login button often fails inside Facebook / Messenger's built-in browser. Instead:
//   1. the page asks for a code (POST /api/account/botlogin); this browser gets a private cookie for it
//   2. it opens t.me/<bot>?start=login_<code>; the customer taps Start
//   3. the bot asks "Sign in to mongkulcard.com?"; the customer taps "Yes, it's me"
//   4. the page keeps asking (GET /api/account/botlogin) and is signed in once confirmed
// Only the browser holding the cookie can finish, and the Telegram user must tap Yes themselves,
// so a link someone else sends cannot sign them in somewhere unexpected without a clear warning.

async function botLoginStart(request, env, url) {
  const bot = (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  if (!env.TELEGRAM_BOT_TOKEN || !/^[A-Za-z0-9_]{5,32}$/.test(bot)) return json({ error: 'Telegram sign-in is not set up yet.', code: 'not_ready' }, 503);
  const ipHash = await sha256Hex('login:' + (request.headers.get('cf-connecting-ip') || 'local'));
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_requests WHERE ip_hash = ?1 AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes')`
  ).bind(ipHash).first();
  if (recent && recent.n >= 20) return json({ error: 'Too many tries. Please wait a few minutes.', code: 'slow_down' }, 429);
  const code = randomToken().slice(0, 24);
  const nonce = randomToken();
  const check = 10 + (crypto.getRandomValues(new Uint8Array(1))[0] % 90);   // 10..99, shown on the website, tapped in Telegram
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_requests WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')`),
    env.DB.prepare(
      `INSERT INTO login_requests (code_hash, nonce_hash, check_num, ip_hash, expires_at)
       VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ','now','+${LOGIN_MINUTES} minutes'))`
    ).bind(await sha256Hex(code), await sha256Hex(nonce), check, ipHash),
  ]);
  return json({
    link: `https://t.me/${bot}?start=login_${code}`,
    app: `tg://resolve?domain=${bot}&start=login_${code}`,
    check,
    expiresIn: LOGIN_MINUTES * 60,
  }, 200, { 'set-cookie': `${LOGIN_COOKIE}=${nonce}; Path=/api/account/botlogin; Max-Age=${LOGIN_MINUTES * 60}; HttpOnly; SameSite=Lax${secure(url)}` });
}

async function botLoginCheck(request, env, url) {
  const nonce = readCookie(request, LOGIN_COOKIE);
  if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return json({ status: 'none' });
  const row = await env.DB.prepare(
    `SELECT id, status, account_id, expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now') AS expired
       FROM login_requests WHERE nonce_hash = ?1 ORDER BY id DESC LIMIT 1`
  ).bind(await sha256Hex(nonce)).first();
  if (!row) return json({ status: 'none' });
  if (row.status === 'refused') return json({ status: 'refused' });
  if (row.status !== 'confirmed') return json({ status: row.expired ? 'expired' : row.status });   // pending / asked / used

  const used = await env.DB.prepare(`UPDATE login_requests SET status = 'used' WHERE id = ?1 AND status = 'confirmed'`).bind(row.id).run();
  if (!used.meta.changes) return json({ status: 'used' });
  const acct = await env.DB.prepare(`SELECT id, disabled_at FROM accounts WHERE id = ?1`).bind(row.account_id).first();
  if (!acct || acct.disabled_at) return json({ status: 'refused' });
  const token = await newSession(env, acct.id);
  let next = null;
  try { const n = readCookie(request, NEXT_COOKIE); if (n) next = safeNext(decodeURIComponent(n)); } catch { /* none */ }
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  headers.append('set-cookie', sessionCookie(token, url, SESSION_DAYS * 86400));
  headers.append('set-cookie', `${LOGIN_COOKIE}=; Path=/api/account/botlogin; Max-Age=0; HttpOnly; SameSite=Lax${secure(url)}`);
  if (next) headers.append('set-cookie', `${NEXT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(url)}`);
  return new Response(JSON.stringify({ status: 'done', next: next || HOME_NEXT }), { status: 200, headers });
}

// "/start login_<code>" in the bot
async function botLoginAsk(env, msg, code) {
  const row = await env.DB.prepare(
    `SELECT id, status, check_num FROM login_requests WHERE code_hash = ?1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).bind(await sha256Hex(code)).first();
  if (!row || (row.status !== 'pending' && row.status !== 'asked')) {
    await botSend(env, msg.chat.id, 'តំណចូលនេះផុតកំណត់ហើយ។ សូមចុច «ចូល» នៅលើគេហទំព័រម្ដងទៀត។\nThis sign-in link has expired. Please tap "Sign in" on the website again.');
    return;
  }
  await env.DB.prepare(`UPDATE login_requests SET status = 'asked', telegram_id = ?2 WHERE id = ?1`).bind(row.id, msg.from.id).run();
  // Three numbers; only the one shown on the customer's own screen signs in.
  const nums = [row.check_num];
  while (nums.length < 3) { const n = 10 + (crypto.getRandomValues(new Uint8Array(1))[0] % 90); if (!nums.includes(n)) nums.push(n); }
  nums.sort(() => crypto.getRandomValues(new Uint8Array(1))[0] - 128);
  await botSend(env, msg.chat.id,
    'ចូលគណនី mongkulcard.com?\nចុចលេខដែលបង្ហាញនៅលើគេហទំព័រ MongkulCard ក្នុងទូរស័ព្ទ ឬកុំព្យូទ័ររបស់អ្នក។\nប្រសិនបើអ្នកមិនបានចុច «ចូល» ខ្លួនឯងទេ ឬមាននរណាម្នាក់ប្រាប់លេខឲ្យអ្នក សូមចុច «មិនមែនខ្ញុំ»។\n\n' +
    'Sign in to mongkulcard.com?\nTap the number shown on the MongkulCard website on YOUR screen.\nIf you did not press "Sign in" yourself, or someone told you a number, tap "Not me".',
    { inline_keyboard: [nums.map((n) => ({ text: String(n), callback_data: `login_ok:${row.id}:${n}` })), [{ text: '✕ មិនមែនខ្ញុំ · Not me', callback_data: `login_no:${row.id}:0` }]] });
}

async function botLoginCallback(cb, env) {
  const answer = (text) => botCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text });
  const m = /^login_(ok|no):(\d{1,12}):(\d{1,2})$/.exec(cb.data || '');
  const row = m && await env.DB.prepare(
    `SELECT id, status, telegram_id, check_num, expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now') AS live FROM login_requests WHERE id = ?1`
  ).bind(Number(m[2])).first();
  const edit = (text) => cb.message && botCall(env, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text });
  if (!row || row.telegram_id !== cb.from?.id || row.status !== 'asked' || !row.live) {
    await answer('Expired');
    await edit('តំណចូលនេះផុតកំណត់ហើយ។ សូមចុច «ចូល» នៅលើគេហទំព័រម្ដងទៀត។\nThis sign-in has expired. Please tap "Sign in" on the website again.');
    return;
  }
  if (m[1] === 'no') {
    await env.DB.prepare(`UPDATE login_requests SET status = 'refused' WHERE id = ?1`).bind(row.id).run();
    await answer('OK');
    await edit('មិនបានចូលទេ។ ✕\nNot signed in. ✕');
    return;
  }
  if (Number(m[3]) !== row.check_num) {   // wrong number: this sign-in is cancelled, the website must start again
    await env.DB.prepare(`UPDATE login_requests SET status = 'refused' WHERE id = ?1`).bind(row.id).run();
    await answer('✕');
    await edit('លេខមិនត្រូវគ្នាទេ ដូច្នេះមិនបានចូលទេ។ សូមចុច «ចូល» នៅលើគេហទំព័រម្ដងទៀត។\nThe number did not match, so you were not signed in. Please tap "Sign in" on the website again.');
    return;
  }
  const from = cb.from;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim().slice(0, 120) || 'Telegram user';
  await env.DB.prepare(
    `INSERT INTO accounts (telegram_id, telegram_username, name, bot_can_message, last_login_at)
     VALUES (?1, ?2, ?3, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(telegram_id) DO UPDATE SET telegram_username = excluded.telegram_username, name = excluded.name,
       bot_can_message = 1, last_login_at = excluded.last_login_at`
  ).bind(from.id, /^[A-Za-z0-9_]{3,32}$/.test(from.username || '') ? from.username : null, name).run();
  const acct = await env.DB.prepare(`SELECT id, disabled_at FROM accounts WHERE telegram_id = ?1`).bind(from.id).first();
  if (!acct || acct.disabled_at) {
    await env.DB.prepare(`UPDATE login_requests SET status = 'refused' WHERE id = ?1`).bind(row.id).run();
    await answer('Account switched off');
    await edit('គណនីនេះត្រូវបានបិទ។ សូមសរសេរមកយើងនៅទីនេះ។\nThis account is switched off. Please write to us here.');
    return;
  }
  await env.DB.prepare(`UPDATE login_requests SET status = 'confirmed', account_id = ?2 WHERE id = ?1 AND status = 'asked'`).bind(row.id, acct.id).run();
  await answer('✅');
  await edit('✅ បានចូលហើយ!\nសូមត្រឡប់ទៅកម្មវិធីដែលអ្នកបានបើក MongkulCard (Facebook, Messenger, Chrome…)។ វានឹងបន្តដោយខ្លួនឯង។\n\n' +
    '✅ Signed in!\nGo back to the app where you opened MongkulCard (Facebook, Messenger, Chrome…). It continues by itself.\n\n' +
    'មានសំណួរ? សរសេរមកយើងនៅទីនេះ។ · Questions? Write to us right here.');
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
  if (update && update.callback_query) {
    if (/^login_/.test(update.callback_query.data || '')) await botLoginCallback(update.callback_query, env);   // "Yes, it's me"
    else await paymentCallback(update.callback_query, env, ctx);                                           // Samotra's Unlock / Not received buttons
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
      { remove_keyboard: true }).then(() => deliverWaiting(env)));
    return new Response('ok');
  }

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text.startsWith('/start')) {
    const arg = text.slice(6).trim();
    await env.DB.prepare(`UPDATE accounts SET bot_can_message = 1 WHERE telegram_id = ?1`).bind(from.id).run();
    const lm = /^login_([A-Za-z0-9_-]{24})$/.exec(arg);
    if (lm) { await botLoginAsk(env, msg, lm[1]); return new Response('ok'); }
    if (arg === 'phone') {
      ctx.waitUntil(botSend(env, msg.chat.id,
        'សូមស្វាគមន៍មកកាន់ MongkulCard ✦\nសូមចុចប៊ូតុងខាងក្រោម ដើម្បីចែករំលែកលេខទូរស័ព្ទ។ យើងប្រើវាតែសម្រាប់ជួយអ្នក ពេលមានបញ្ហាជាមួយធៀប។\n\n' +
        'Welcome to MongkulCard ✦\nTap the button below to share your phone number. We only use it to help you with your invitation.',
        phoneKeyboard()));
      return new Response('ok');
    }
    ctx.waitUntil(botSend(env, msg.chat.id, WELCOME));
    return new Response('ok');
  }
  if (text.startsWith('/')) {   // /help or anything else: say hello and how to ask
    ctx.waitUntil(botSend(env, msg.chat.id, WELCOME));
    return new Response('ok');
  }

  await supportMessage(env, ctx, msg);
  return new Response('ok');
}

// ---------------------------------------------------------------- customer chat ("MongkulCard Service")
// A customer writes to the bot -> Samotra gets it in his own Telegram (with who sent it).
// Samotra replies to that message (swipe left, Reply) -> the bot sends his reply to the customer.
// Samotra's own Telegram account stays private.

async function supportMessage(env, ctx, msg) {
  const adminId = await adminTelegramId(env);
  const from = msg.from;

  if (adminId && from.id === adminId) {
    const replyTo = msg.reply_to_message && msg.reply_to_message.message_id;
    const row = replyTo && await env.DB.prepare(
      `SELECT customer_chat_id FROM support_messages WHERE admin_message_id = ?1 AND direction = 'in' ORDER BY id DESC LIMIT 1`
    ).bind(replyTo).first();
    if (!row) {
      await botSend(env, msg.chat.id, 'To answer a customer, reply to their message (swipe left on it, then type).');
      return;
    }
    const sent = await botCall(env, 'copyMessage', { chat_id: row.customer_chat_id, from_chat_id: msg.chat.id, message_id: msg.message_id });
    await env.DB.prepare(`INSERT INTO support_messages (customer_chat_id, admin_message_id, direction, text) VALUES (?1, ?2, 'out', ?3)`)
      .bind(row.customer_chat_id, msg.message_id, (msg.text || msg.caption || '').slice(0, 2000)).run();
    await botCall(env, 'sendMessage', {
      chat_id: msg.chat.id, reply_to_message_id: msg.message_id, disable_notification: true,
      text: sent && sent.ok ? '✓ Sent' : '⚠️ Not delivered (the customer may have blocked the bot).',
    });
    return;
  }

  if (adminId) ctx.waitUntil(deliverWaiting(env, adminId));   // anything that arrived before Samotra was connected

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM support_messages WHERE customer_chat_id = ?1 AND direction = 'in' AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-6 hours')`
  ).bind(msg.chat.id).first();
  if (recent && recent.n >= 60) return;   // flood guard

  const who = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || 'Customer';
  const acct = await env.DB.prepare(`SELECT id FROM accounts WHERE telegram_id = ?1`).bind(from.id).first();
  const header = `💬 ${who}${from.username ? ' (@' + from.username + ')' : ''}${acct ? ' · account #' + acct.id : ''}`;
  const body = (msg.text || msg.caption || '').slice(0, 2000);
  const ids = [];
  if (adminId) {
    if (msg.text) {
      const r = await botCall(env, 'sendMessage', { chat_id: adminId, text: `${header}\n\n${msg.text}`.slice(0, 4000), disable_web_page_preview: true });
      if (r && r.ok) ids.push(r.result.message_id);
    } else {
      const h = await botCall(env, 'sendMessage', { chat_id: adminId, text: header });
      if (h && h.ok) ids.push(h.result.message_id);
      const c = await botCall(env, 'copyMessage', { chat_id: adminId, from_chat_id: msg.chat.id, message_id: msg.message_id });
      if (c && c.ok) ids.push(c.result.message_id);
    }
  }
  const stmts = (ids.length ? ids : [null]).map((id) => env.DB.prepare(
    `INSERT INTO support_messages (customer_chat_id, admin_message_id, customer_message_id, customer_name, direction, text) VALUES (?1, ?2, ?3, ?4, 'in', ?5)`
  ).bind(msg.chat.id, id, msg.message_id, (who + (from.username ? ' (@' + from.username + ')' : '')).slice(0, 160), body || '[' + mediaKind(msg) + ']'));
  await env.DB.batch(stmts);

  if (!recent || recent.n === 0) {
    ctx.waitUntil(botSend(env, msg.chat.id,
      '✓ យើងបានទទួលសាររបស់អ្នកហើយ។ យើងនឹងឆ្លើយឆាប់ៗ (ម៉ោង ៨ ព្រឹក – ៩ យប់)។\n✓ We got your message and will reply soon (8 AM – 9 PM).'));
  }
}

// Messages saved while Samotra was not connected yet (no ADMIN_PHONE, or his phone not shared): pass them on now.
export async function deliverWaiting(env, adminId) {
  adminId = adminId || await adminTelegramId(env);
  if (!adminId) return 0;
  const rows = await env.DB.prepare(
    `SELECT id, customer_chat_id, customer_message_id, customer_name, text, created_at FROM support_messages
      WHERE direction = 'in' AND admin_message_id IS NULL AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')
      ORDER BY id LIMIT 25`
  ).all();
  let n = 0;
  for (const r of rows.results) {
    const who = await env.DB.prepare(`SELECT name, telegram_username, id FROM accounts WHERE telegram_id = ?1`).bind(r.customer_chat_id).first();
    const header = `💬 ${r.customer_name || (who ? who.name : 'Customer')}${who ? ' · account #' + who.id : ''} · waiting since ${r.created_at.slice(0, 16).replace('T', ' ')} UTC`;
    let sent = null;
    if (r.text && !/^\[[a-z_]+\]$/.test(r.text)) {
      sent = await botCall(env, 'sendMessage', { chat_id: adminId, text: `${header}\n\n${r.text}`.slice(0, 4000), disable_web_page_preview: true });
    } else if (r.customer_message_id) {
      await botCall(env, 'sendMessage', { chat_id: adminId, text: header });
      sent = await botCall(env, 'copyMessage', { chat_id: adminId, from_chat_id: r.customer_chat_id, message_id: r.customer_message_id });
    } else {
      sent = await botCall(env, 'sendMessage', { chat_id: adminId, text: `${header}\n\n${r.text || ''}` });
    }
    // mark it handled even if Telegram refused it, so one broken message never blocks the rest
    await env.DB.prepare(`UPDATE support_messages SET admin_message_id = ?2 WHERE id = ?1`).bind(r.id, sent && sent.ok ? sent.result.message_id : 0).run();
    n++;
  }
  return n;
}

function mediaKind(msg) {
  for (const k of ['photo', 'video', 'document', 'voice', 'audio', 'sticker', 'video_note', 'animation', 'location']) if (msg[k]) return k;
  return 'message';
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
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\') || v.length > 200) return HOME_NEXT;
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

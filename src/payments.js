// MongkulCard: packages, orders and KHQR payments.
//
//   GET  /api/packages                 what the customer can buy (and whether payment is switched on)
//   POST /api/orders                   make a one-time KHQR  { invitation, package }
//   GET  /api/orders/<id>              order status; while waiting, also asks Bakong (at most every 3 s)
//   POST /api/orders/<id>/claim        "I paid with ABA": sends Samotra a Telegram message with Unlock / Not received
//
// Bakong: POST https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5 with the MD5 of the QR text.
// Paid only when Bakong has the transaction AND it went to our account AND the amount is exact.
// ABA → ABA payments never reach Bakong, so those are approved by Samotra from Telegram.
//
// Settings: BAKONG_TOKEN (secret), ADMIN_PHONE (secret, Samotra's number, e.g. 078912999),
//           BAKONG_ACCOUNT_ID, KHQR_MERCHANT_NAME, KHQR_CITY (vars in wrangler.jsonc).

import { getAccount, botSend, botCall } from './account.js';
import { makeKhqr, md5Hex } from './khqr.js';

const QR_MINUTES = 15;
const CHECK_EVERY_MS = 3000;
const BAKONG_URL = 'https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5';
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_ORDERS_PER_HOUR = 12;

export async function paymentsApi(request, env, ctx, url, parts) {
  const method = request.method;
  if (method !== 'GET') {
    if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
    if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'Not allowed.' }, 415);
  }
  const me = await getAccount(request, env);
  if (!me) return json({ error: 'Please sign in again.' }, 401);
  const admin = isAdmin(me, env);

  if (parts[1] === 'packages' && parts.length === 2 && method === 'GET') return listPackages(env, admin);
  if (parts[1] === 'orders' && parts.length === 2 && method === 'POST') return createOrder(request, env, me, admin);
  if (parts[1] === 'orders' && /^[a-z0-9]{10}$/.test(parts[2] || '')) {
    const order = await env.DB.prepare(
      `SELECT o.*, i.public_id AS invitation_public_id, i.title AS invitation_title, p.name_en AS package_name
         FROM orders o JOIN invitations i ON i.id = o.invitation_id JOIN packages p ON p.code = o.package_code
        WHERE o.public_id = ?1 AND o.account_id = ?2`
    ).bind(parts[2], me.id).first();
    if (!order) return json({ error: 'Not found.' }, 404);
    if (parts.length === 3 && method === 'GET') return orderStatus(env, ctx, me, order);
    if (parts.length === 4 && parts[3] === 'claim' && method === 'POST') return claim(env, ctx, me, order);
  }
  return json({ error: 'Not found.' }, 404);
}

// ---------------------------------------------------------------- packages

function ready(env) {
  return !!(env.BAKONG_TOKEN && env.BAKONG_ACCOUNT_ID && env.KHQR_MERCHANT_NAME);
}

async function listPackages(env, admin) {
  const { results } = await env.DB.prepare(
    `SELECT code, name_en, name_km, price_cents, named_guests, photos, features, admin_only
       FROM packages WHERE active = 1 AND (admin_only = 0 OR ?1 = 1) ORDER BY sort`
  ).bind(admin ? 1 : 0).all();
  return json({
    ready: ready(env),
    packages: results.map((p) => ({ ...p, features: safeJson(p.features, []), forSale: p.price_cents != null, admin_only: !!p.admin_only })),
  });
}

// ---------------------------------------------------------------- orders

async function createOrder(request, env, me, admin) {
  if (!ready(env)) return json({ error: 'Payment is being set up. Please try again soon.', code: 'not_ready' }, 503);
  const body = await readJson(request);
  const invId = typeof body?.invitation === 'string' ? body.invitation : '';
  const pkgCode = typeof body?.package === 'string' ? body.package : '';

  const inv = /^[a-z0-9]{10}$/.test(invId) && await env.DB.prepare(
    `SELECT id, public_id, title, status FROM invitations WHERE public_id = ?1 AND account_id = ?2`
  ).bind(invId, me.id).first();
  if (!inv) return json({ error: 'Invitation not found.' }, 404);
  if (inv.status !== 'draft') return json({ error: 'This invitation is already paid.', code: 'already_paid' }, 409);

  const pkg = await env.DB.prepare(
    `SELECT code, name_en, price_cents, admin_only FROM packages WHERE code = ?1 AND active = 1`
  ).bind(pkgCode).first();
  if (!pkg || pkg.price_cents == null || (pkg.admin_only && !admin)) return json({ error: 'This package is not available.' }, 400);

  // Same invitation + package with a QR that is still fresh: show that one again.
  const existing = await env.DB.prepare(
    `SELECT public_id FROM orders WHERE invitation_id = ?1 AND package_code = ?2 AND status IN ('pending','claimed')
       AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','+90 seconds') ORDER BY id DESC LIMIT 1`
  ).bind(inv.id, pkg.code).first();
  if (existing) return orderView(env, existing.public_id, me.id);

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE account_id = ?1 AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour')`
  ).bind(me.id).first();
  if (recent.n >= MAX_ORDERS_PER_HOUR) return json({ error: 'Too many payment QRs. Please wait a little and try again.' }, 429);

  await env.DB.prepare(`UPDATE orders SET status = 'cancelled' WHERE invitation_id = ?1 AND status = 'pending'`).bind(inv.id).run();

  const now = Date.now();
  const expires = now + QR_MINUTES * 60 * 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const publicId = randomId(10);
    const billNo = ('MC' + now.toString(36) + randomId(3)).toUpperCase();
    const qr = makeKhqr({
      accountId: env.BAKONG_ACCOUNT_ID, merchantName: env.KHQR_MERCHANT_NAME, city: env.KHQR_CITY || 'Phnom Penh',
      currency: 'USD', amountCents: pkg.price_cents, billNumber: billNo, storeLabel: env.KHQR_MERCHANT_NAME,
      terminal: 'web', createdMs: now, expiresMs: expires,
    });
    try {
      await env.DB.prepare(
        `INSERT INTO orders (public_id, account_id, invitation_id, package_code, amount_cents, currency, bill_no, to_account, qr, md5, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'USD', ?6, ?7, ?8, ?9, ?10)`
      ).bind(publicId, me.id, inv.id, pkg.code, pkg.price_cents, billNo, env.BAKONG_ACCOUNT_ID, qr, await md5Hex(qr), iso(expires)).run();
      return orderView(env, publicId, me.id, 201);
    } catch (e) {
      if (!String(e && e.message).includes('UNIQUE')) throw e;
    }
  }
  return json({ error: 'Please try again.' }, 500);
}

async function orderStatus(env, ctx, me, order) {
  const waiting = order.status === 'pending' || order.status === 'claimed';
  const fresh = Date.now() - Date.parse(order.created_at) < 24 * 3600 * 1000;
  const lastCheck = order.last_checked_at ? Date.parse(order.last_checked_at) : 0;

  if (waiting && fresh && Date.now() - lastCheck >= CHECK_EVERY_MS) {
    // Claim this check slot first, so two open tabs do not both ask Bakong.
    const slot = await env.DB.prepare(
      `UPDATE orders SET last_checked_at = ?2, check_count = check_count + 1
        WHERE id = ?1 AND (last_checked_at IS NULL OR last_checked_at = ?3)`
    ).bind(order.id, iso(Date.now()), order.last_checked_at).run();
    if (slot.meta.changes === 1) {
      const result = await checkBakong(env, order);
      if (result.paid) await markPaid(env, ctx, order, 'bakong', result);
    }
  }
  if (order.status === 'pending' && Date.parse(order.expires_at) < Date.now()) {
    await env.DB.prepare(`UPDATE orders SET status = 'expired' WHERE id = ?1 AND status = 'pending'`).bind(order.id).run();
  }
  return orderView(env, order.public_id, me.id);
}

async function claim(env, ctx, me, order) {
  if (order.status === 'paid') return orderView(env, order.public_id, me.id);
  if (!['pending', 'expired', 'rejected'].includes(order.status)) return orderView(env, order.public_id, me.id);
  const r = await env.DB.prepare(
    `UPDATE orders SET status = 'claimed', claimed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?1 AND status IN ('pending','expired','rejected')`
  ).bind(order.id).run();
  if (r.meta.changes === 1) {
    const adminId = await adminTelegramId(env);
    const cust = await env.DB.prepare(`SELECT name, telegram_username, phone FROM accounts WHERE id = ?1`).bind(me.id).first();
    if (adminId) {
      ctx.waitUntil(botSend(env, adminId,
        `🧾 Payment to check\n${money(order.amount_cents)} · ${order.package_name} · order ${order.bill_no}\n` +
        `Invitation: ${order.invitation_title}\nCustomer: ${cust.name}${cust.telegram_username ? ' (@' + cust.telegram_username + ')' : ''}${cust.phone ? ' · ' + cust.phone : ''}\n\n` +
        `They say they paid with ABA. Check your bank app, then tap:`,
        { inline_keyboard: [[{ text: '✅ Received, unlock', callback_data: `pay_ok:${order.public_id}` }, { text: '❌ Not received', callback_data: `pay_no:${order.public_id}` }]] }));
    }
  }
  return orderView(env, order.public_id, me.id);
}

async function orderView(env, publicId, accountId, status = 200) {
  const o = await env.DB.prepare(
    `SELECT o.public_id, o.status, o.amount_cents, o.currency, o.qr, o.expires_at, o.created_at, o.paid_at, o.bill_no, o.package_code,
            i.public_id AS invitation, p.name_en AS package_name
       FROM orders o JOIN invitations i ON i.id = o.invitation_id JOIN packages p ON p.code = o.package_code
      WHERE o.public_id = ?1 AND o.account_id = ?2`
  ).bind(publicId, accountId).first();
  const showQr = o.status === 'pending' || o.status === 'claimed';
  return json({
    order: {
      id: o.public_id, status: o.status, amount: o.amount_cents / 100, currency: o.currency, bill: o.bill_no,
      package: o.package_code, packageName: o.package_name, invitation: o.invitation,
      qr: showQr ? o.qr : null, expiresAt: o.expires_at, paidAt: o.paid_at,
    },
  }, status);
}

// ---------------------------------------------------------------- Bakong

async function checkBakong(env, order) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(env.BAKONG_API_URL || BAKONG_URL, {   // BAKONG_API_URL only for local tests
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.BAKONG_TOKEN}` },
      body: JSON.stringify({ md5: order.md5 }),
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { console.log('bakong: not JSON', res.status, text.slice(0, 200)); return { paid: false }; }
    if (j.responseCode === 0 && j.data) {
      const d = j.data;
      const sameAccount = String(d.toAccountId || '').toLowerCase() === order.to_account.toLowerCase();
      const sameAmount = Math.round(Number(d.amount) * 100) === order.amount_cents;
      const sameCurrency = (d.currency || 'USD') === order.currency;
      if (sameAccount && sameAmount && sameCurrency) return { paid: true, hash: d.hash || null, from: d.fromAccountId || null };
      console.log('bakong: transaction found but does not match', order.public_id, JSON.stringify(d).slice(0, 300));
      return { paid: false };
    }
    if (j.responseCode !== 1) console.log('bakong: unexpected answer', res.status, text.slice(0, 200));
    return { paid: false };
  } catch (e) {
    console.log('bakong: request failed', String(e && e.message));
    return { paid: false };
  } finally {
    clearTimeout(t);
  }
}

async function markPaid(env, ctx, order, by, info = {}) {
  const r = await env.DB.prepare(
    `UPDATE orders SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), paid_by = ?2, bakong_hash = ?3, from_account = ?4
      WHERE id = ?1 AND status IN ('pending','claimed','expired','rejected')`
  ).bind(order.id, by, info.hash || null, info.from || null).run();
  if (r.meta.changes !== 1) return false;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE invitations SET status = 'paid', package_code = ?2, paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1 AND status = 'draft'`
    ).bind(order.invitation_id, order.package_code),
    env.DB.prepare(`UPDATE orders SET status = 'cancelled' WHERE invitation_id = ?1 AND id <> ?2 AND status IN ('pending','claimed')`).bind(order.invitation_id, order.id),
  ]);

  const cust = await env.DB.prepare(`SELECT telegram_id, name, telegram_username FROM accounts WHERE id = ?1`).bind(order.account_id).first();
  const amount = money(order.amount_cents);
  if (cust && cust.telegram_id) {
    ctx.waitUntil(botSend(env, cust.telegram_id,
      `✅ បានទទួលការបង់ប្រាក់ ${amount} ហើយ។ សូមអរគុណ!\nPayment of ${amount} received. Thank you!\n\n` +
      `${order.invitation_title} · ${order.package_name}\nhttps://mongkulcard.com/preview/#dashboard`));
  }
  const adminId = await adminTelegramId(env);
  if (adminId && by === 'bakong') {
    ctx.waitUntil(botSend(env, adminId,
      `💰 Paid automatically (Bakong): ${amount}\n${order.package_name} · order ${order.bill_no}\nInvitation: ${order.invitation_title}\n` +
      `Customer: ${cust ? cust.name + (cust.telegram_username ? ' (@' + cust.telegram_username + ')' : '') : '?'}${info.from ? '\nFrom: ' + info.from : ''}`));
  }
  return true;
}

// ---------------------------------------------------------------- Telegram buttons (from account.js's webhook)

export async function paymentCallback(cb, env, ctx) {
  const answer = (text) => botCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: false });
  const adminId = await adminTelegramId(env);
  if (!adminId || cb.from?.id !== adminId) { await answer('Not allowed.'); return; }

  const m = /^(pay_ok|pay_no):([a-z0-9]{10})$/.exec(cb.data || '');
  if (!m) { await answer('Unknown button.'); return; }
  const order = await env.DB.prepare(
    `SELECT o.*, i.title AS invitation_title, p.name_en AS package_name
       FROM orders o JOIN invitations i ON i.id = o.invitation_id JOIN packages p ON p.code = o.package_code WHERE o.public_id = ?1`
  ).bind(m[2]).first();
  if (!order) { await answer('Order not found.'); return; }

  let result;
  if (m[1] === 'pay_ok') {
    const done = await markPaid(env, ctx, order, 'admin');
    result = done ? '✅ Unlocked. The customer has been told.' : `Already ${order.status}.`;
  } else {
    const r = await env.DB.prepare(`UPDATE orders SET status = 'rejected' WHERE id = ?1 AND status = 'claimed'`).bind(order.id).run();
    result = r.meta.changes ? '❌ Marked as not received. The customer has been told.' : `Already ${order.status}.`;
    if (r.meta.changes) {
      const cust = await env.DB.prepare(`SELECT telegram_id FROM accounts WHERE id = ?1`).bind(order.account_id).first();
      if (cust && cust.telegram_id) ctx.waitUntil(botSend(env, cust.telegram_id,
        `យើងមិនទាន់ឃើញការបង់ប្រាក់ ${money(order.amount_cents)} របស់អ្នកនៅឡើយទេ។ សូមផ្ញើរូបថតវិក្កយបត្រមកកាន់យើង នៅទីនេះ។\n` +
        `We couldn't find your payment of ${money(order.amount_cents)} yet. Please reply here with a screenshot of your receipt.`));
    }
  }
  await answer(result);
  if (cb.message) {
    await botCall(env, 'editMessageText', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      text: `${cb.message.text || ''}\n\n${result}`,
    });
  }
}

// ---------------------------------------------------------------- daily jobs (cron in wrangler.jsonc)

export async function dailyJobs(env) {
  await env.DB.prepare(
    `UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour')`
  ).run();

  // Remind Samotra on Telegram when the Bakong token is close to expiring (it lasts about 90 days).
  if (!env.BAKONG_TOKEN) return;
  const exp = jwtExpiry(env.BAKONG_TOKEN);
  if (!exp) return;
  const daysLeft = Math.floor((exp - Date.now()) / 86400000);
  if (daysLeft > 14) return;
  const today = new Date().toISOString().slice(0, 10);
  const last = await env.DB.prepare(`SELECT value FROM kv WHERE key = 'bakong_token_reminder'`).first();
  if (last && last.value === today) return;
  const adminId = await adminTelegramId(env);
  if (!adminId) return;
  await botSend(env, adminId, daysLeft >= 0
    ? `⏰ The Bakong token for MongkulCard expires in ${daysLeft} day(s) (${new Date(exp).toISOString().slice(0, 10)}). Renew it at api-bakong.nbc.gov.kh and update BAKONG_TOKEN in Cloudflare.`
    : `⚠️ The Bakong token for MongkulCard has EXPIRED. Automatic payment checks are not working. Renew it at api-bakong.nbc.gov.kh and update BAKONG_TOKEN in Cloudflare.`);
  await env.DB.prepare(`INSERT INTO kv (key, value) VALUES ('bakong_token_reminder', ?1)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).bind(today).run();
}

function jwtExpiry(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- admin = the account whose verified phone is ADMIN_PHONE

export function normalizePhone(p) {
  let d = String(p || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.startsWith('0')) d = '855' + d.slice(1);
  return '+' + d;
}
function isAdmin(me, env) {
  return !!(env.ADMIN_PHONE && me.phone_verified_at && me.phone === normalizePhone(env.ADMIN_PHONE));
}
async function adminTelegramId(env) {
  if (!env.ADMIN_PHONE) return null;
  const row = await env.DB.prepare(
    `SELECT telegram_id FROM accounts WHERE phone = ?1 AND phone_verified_at IS NOT NULL AND disabled_at IS NULL LIMIT 1`
  ).bind(normalizePhone(env.ADMIN_PHONE)).first();
  return row ? row.telegram_id : null;
}

// ---------------------------------------------------------------- helpers

function money(cents) { return '$' + (cents / 100).toFixed(2); }
function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function safeJson(t, d) { try { return JSON.parse(t); } catch { return d; } }
function randomId(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += ID_CHARS[x % ID_CHARS.length];
  return s;
}
async function readJson(request) {
  try {
    const t = await request.text();
    if (t.length > 5000) return null;
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' },
  });
}

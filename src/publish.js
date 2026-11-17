// MongkulCard: publishing a customer's invitation, its guest links, the guest page and RSVP.
//
// Owner (signed in):
//   POST   /api/invitations/<id>/publish          give it its address and switch it on (needs payment; Samotra can test without)
//   GET    /api/invitations/<id>/guests           guest list with links, opens and replies, plus totals
//   POST   /api/invitations/<id>/guests           add names  { names: ["..."], lang: "km"|"en"|"zh" }
//   DELETE /api/invitations/<id>/guests/<code>    remove a guest (their link stops working)
// Guests:
//   GET    /<slug>                                the shared invitation ("Dear guest")
//   GET    /<slug>/<code>                         one guest's own invitation
//   POST   /api/reply/<slug>/<code|shared>        RSVP  { attending, party, message, name (shared link only) }
//
// Links work until one week after the event date. Separate from the Ly Chhayly system in index.js (events/guests).

import { getAccount } from './account.js';
import { normalizePhone } from './payments.js';
import { mediaFor } from './media.js';

const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const ADMIN_GUEST_LIMIT = 1000;
const PREPAY_GUEST_LIMIT = 1000;   // before paying, names can be prepared up to the biggest package
const MAX_SHARED_REPLIES = 3000;
const BOT_RE = /bot|crawl|spider|preview|facebookexternalhit|telegrambot|whatsapp|slurp|discord/i;

// ---------------------------------------------------------------- owner API

export async function publishApi(request, env, url, parts) {
  const method = request.method;
  if (method !== 'GET' && request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
  const me = await getAccount(request, env);
  if (!me) return json({ error: 'Please sign in again.' }, 401);
  const inv = await env.DB.prepare(
    `SELECT i.*, p.named_guests FROM invitations i LEFT JOIN packages p ON p.code = i.package_code
      WHERE i.public_id = ?1 AND i.account_id = ?2 AND i.status <> 'archived'`
  ).bind(parts[2], me.id).first();
  if (!inv) return json({ error: 'Not found.' }, 404);
  const admin = isAdmin(me, env);

  if (parts[3] === 'publish' && parts.length === 4 && method === 'POST') return publish(env, inv, admin);
  if (parts[3] === 'guests' && parts.length === 4 && method === 'GET') return guestList(env, inv, admin);
  if (parts[3] === 'guests' && parts.length === 4 && method === 'POST') return addGuests(request, env, inv, admin);
  if (parts[3] === 'guests' && parts.length === 5 && method === 'DELETE' && /^[a-z0-9]{7}$/.test(parts[4])) {
    await env.DB.prepare(`DELETE FROM inv_guests WHERE invitation_id = ?1 AND code = ?2`).bind(inv.id, parts[4]).run();
    return guestList(env, inv, admin);
  }
  return json({ error: 'Not found.' }, 404);
}

function isAdmin(me, env) {
  return !!(env.ADMIN_PHONE && me.phone_verified_at && me.phone === normalizePhone(env.ADMIN_PHONE));
}
function guestLimit(inv, admin) {
  if (inv.status === 'draft') return admin ? ADMIN_GUEST_LIMIT : PREPAY_GUEST_LIMIT;   // links only work once published
  return inv.named_guests || (admin ? ADMIN_GUEST_LIMIT : 0);
}

async function publish(env, inv, admin) {
  if (inv.status === 'draft' && !admin) return json({ error: 'Please pay first, then publish.', code: 'unpaid' }, 402);
  const s = safeJson(inv.settings, {});
  const missing = [];
  if (!(s.groom && (s.groom.en || s.groom.km)) || !(s.bride && (s.bride.en || s.bride.km))) missing.push('names');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) missing.push('date');
  if (!s.venue) missing.push('venue');
  if (missing.length) return json({ error: 'Please fill in: ' + missing.join(', '), code: 'missing', missing }, 400);

  let slug = inv.slug;
  if (!slug) slug = await freeSlug(env, slugBase(s));
  await env.DB.prepare(
    `UPDATE invitations SET slug = ?1, status = 'published', published_at = COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?2`
  ).bind(slug, inv.id).run();
  return json({ ok: true, slug, url: `https://mongkulcard.com/${slug}` });
}

function slugBase(s) {
  const latin = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
  const a = latin(s.groom && s.groom.en), b = latin(s.bride && s.bride.en);
  const base = a && b ? `${a}-${b}` : a || b || '';
  return base.length >= 3 ? base.slice(0, 32) : 'mc' + randomCode(6);
}

async function freeSlug(env, base) {
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : i < 10 ? `${base}-${i + 1}` : `${base.slice(0, 26)}-${randomCode(5)}`;
    const taken = await env.DB.prepare(
      `SELECT 1 FROM invitations WHERE slug = ?1 UNION ALL SELECT 1 FROM events WHERE slug = ?1 UNION ALL SELECT 1 FROM reserved_slugs WHERE slug = ?1 LIMIT 1`
    ).bind(candidate).first();
    if (!taken) return candidate;
  }
  return 'mc' + randomCode(8);
}

async function guestList(env, inv, admin) {
  const [guests, shared] = await Promise.all([
    env.DB.prepare(
      `SELECT g.code, g.name, g.lang, g.first_opened_at, g.open_count, r.attending, r.party, r.message, r.updated_at AS replied_at
         FROM inv_guests g LEFT JOIN inv_rsvps r ON r.guest_id = g.id WHERE g.invitation_id = ?1 ORDER BY g.id DESC`
    ).bind(inv.id).all(),
    env.DB.prepare(
      `SELECT name, attending, party, message, updated_at AS replied_at FROM inv_rsvps WHERE invitation_id = ?1 AND guest_id IS NULL ORDER BY id DESC LIMIT 1000`
    ).bind(inv.id).all(),
  ]);
  const all = guests.results.filter((g) => g.attending !== null).concat(shared.results);
  const totals = {
    guests: guests.results.length,
    opened: guests.results.filter((g) => g.first_opened_at).length,
    replies: all.length,
    coming: all.filter((r) => r.attending === 1).length,
    people: all.filter((r) => r.attending === 1).reduce((n, r) => n + (r.party || 0), 0),
    notComing: all.filter((r) => r.attending === 0).length,
  };
  return json({
    status: inv.status, slug: inv.slug, url: inv.slug ? `https://mongkulcard.com/${inv.slug}` : null,
    limit: guestLimit(inv, admin), admin, totals, guests: guests.results, shared: shared.results,
  });
}

async function addGuests(request, env, inv, admin) {
  // Names can be prepared before paying; their links start working once the invitation is published.
  let body;
  try { body = await request.json(); } catch { body = null; }
  const lang = ['km', 'en', 'zh'].includes(body && body.lang) ? body.lang : 'km';
  const names = Array.isArray(body && body.names) ? body.names : [];
  const clean = [...new Set(names.map((n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))].slice(0, 1000);
  if (!clean.length) return json({ error: 'Please type at least one name.' }, 400);

  const limit = guestLimit(inv, admin);
  const have = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM inv_guests WHERE invitation_id = ?1`).bind(inv.id).first()).n;
  if (have + clean.length > limit) {
    return json({ error: `Your package allows ${limit} named guests. You have ${have}; ${Math.max(0, limit - have)} more fit.`, code: 'limit' }, 409);
  }
  const stmts = clean.map((name) =>
    env.DB.prepare(`INSERT OR IGNORE INTO inv_guests (invitation_id, code, name, lang) VALUES (?1, ?2, ?3, ?4)`).bind(inv.id, randomCode(7), name, lang));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return guestList(env, inv, admin);
}

// ---------------------------------------------------------------- guest pages

export async function selfServicePage(request, env, ctx, url, parts) {
  const slug = parts[0];
  const inv = await env.DB.prepare(
    `SELECT id, public_id, template, settings, status, slug FROM invitations WHERE slug = ?1`
  ).bind(slug).first();
  if (!inv) return null;                       // not a self-service invitation: the old system answers
  if (inv.status !== 'published') return notFoundPage();
  const s = safeJson(inv.settings, {});
  if (linksExpired(s.date)) return endedPage();

  let guest = null;
  if (parts.length === 2) {
    guest = await env.DB.prepare(
      `SELECT g.id, g.code, g.name, g.lang, r.attending, r.party, r.message
         FROM inv_guests g LEFT JOIN inv_rsvps r ON r.guest_id = g.id WHERE g.invitation_id = ?1 AND g.code = ?2`
    ).bind(inv.id, parts[1].toLowerCase()).first();
    if (!guest) return notFoundPage();
    if (request.method === 'GET' && !BOT_RE.test(request.headers.get('user-agent') || '')) {
      ctx.waitUntil(env.DB.prepare(
        `UPDATE inv_guests SET first_opened_at = COALESCE(first_opened_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                last_opened_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), open_count = open_count + 1 WHERE id = ?1`
      ).bind(guest.id).run());
    }
  }

  const media = await mediaFor(env, inv);
  const settings = buildSettings(s, media, guest);
  const rsvp = {
    on: s.sections ? s.sections.rsvp === true : false,
    endpoint: `/api/reply/${inv.slug}/${guest ? guest.code : 'shared'}`,
    shared: !guest,
    closed: replyClosed(s),
    by: s.rsvpBy || '',
    current: guest && guest.attending !== null ? { attending: guest.attending === 1, party: guest.party, message: guest.message || '' } : null,
  };

  const file = await env.ASSETS.fetch(new URL('/preview/invite.html', url));   // Golden Curtain (the only template so far)
  if (!file.ok) return new Response('Template missing', { status: 500 });
  let html = await file.text();
  const data = JSON.stringify({ settings, rsvp }).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  html = html.replace('</head>', () => `<script>window.MC_DATA=${data};</script>\n</head>`);
  html = html.replace('<html lang="km" data-lang="km"', () => `<html lang="${settings.lang}" data-lang="${settings.lang}"`);
  const title = `${settings.groom.en} & ${settings.bride.en} · MongkulCard`;
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}

// Same result as settings() in the editor (public/preview/index.html), made on the server.
const KM_M = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
const KM_D = ['អាទិត្យ', 'ចន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍'];
const EN_M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EN_D = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const khNum = (n) => String(n).replace(/\d/g, (d) => '០១២៣៤៥៦៧៨៩'[d]);

export function buildSettings(s, media, guest) {
  const g = s.groom || {}, b = s.bride || {};
  const d = new Date((s.date || '') + 'T12:00:00Z');
  const ok = !isNaN(d);
  const [hh, mm] = (s.time || '17:00').split(':');
  const h = Number(hh), h12 = ((h + 11) % 12) + 1;
  const kmPart = h < 12 ? 'ព្រឹក' : h < 17 ? 'រសៀល' : 'ល្ងាច', enPart = h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : 'in the evening';
  const lang = guest ? (guest.lang === 'en' ? 'en' : 'km') : 'km';   // 中文 comes later; Chinese guests see English for now
  const guestName = guest ? guest.name : null;
  const v = media.video && media.video.status === 'ready' ? { player: media.video.player, poster: media.video.poster } : null;
  return {
    theme: s.theme || 'burgundy', fontKh: s.fontKh || 'moul', fontEn: s.fontEn || 'greatvibes', lang,
    guest: guestName ? { km: guestName, en: guestName } : { km: 'ភ្ញៀវកិត្តិយស', en: 'Our dear guest' },
    groom: { en: g.en || g.km || '', km: g.km || '', full_km: g.km || g.en || '' },
    bride: { en: b.en || b.km || '', km: b.km || '', full_km: b.km || b.en || '' },
    start: `${s.date}T${s.time || '17:00'}:00+07:00`,
    dateShort: ok ? `${String(d.getUTCDate()).padStart(2, '0')} · ${String(d.getUTCMonth() + 1).padStart(2, '0')} · ${d.getUTCFullYear()}` : '',
    dateLong: ok ? {
      km: `ថ្ងៃ${KM_D[d.getUTCDay()]} ទី${khNum(d.getUTCDate())} ខែ${KM_M[d.getUTCMonth()]} ឆ្នាំ${khNum(d.getUTCFullYear())}`,
      en: `${EN_D[d.getUTCDay()]}, ${d.getUTCDate()} ${EN_M[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    } : { km: '', en: '' },
    time: { km: `វេលាម៉ោង ${khNum(h12)}:${khNum(mm || '00')} ${kmPart}`, en: `${h12}:${mm || '00'} ${enPart}` },
    venue: { km: s.venue || '', en: s.venue || '' },
    mapUrl: s.mapUrl || '', sections: s.sections || {},
    photos: media.photos.map((p) => p.url),
    musicUrl: s.music === 'custom' && media.music ? media.music.url : '',
    video: v, brandUrl: 'https://mongkulcard.com/',
  };
}

function linksExpired(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const end = Date.parse(date + 'T23:59:59+07:00') + 7 * 86400000;
  return Date.now() > end;
}
function replyClosed(s) {
  const by = /^\d{4}-\d{2}-\d{2}$/.test(s.rsvpBy || '') ? s.rsvpBy : s.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(by || '')) return false;
  return Date.now() > Date.parse(by + 'T23:59:59+07:00');
}

// ---------------------------------------------------------------- RSVP

export async function replyApi(request, env, url, parts) {
  // parts: ['api','reply',<slug>,<code|shared>]
  if (request.method !== 'POST' || parts.length !== 4) return json({ error: 'Not found.' }, 404);
  if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
  const inv = await env.DB.prepare(`SELECT id, settings, status FROM invitations WHERE slug = ?1`).bind(parts[2]).first();
  if (!inv || inv.status !== 'published') return json({ error: 'Not found.' }, 404);
  const s = safeJson(inv.settings, {});
  if (!(s.sections && s.sections.rsvp === true)) return json({ error: 'Replies are switched off.' }, 409);
  if (linksExpired(s.date) || replyClosed(s)) return json({ error: 'Replies are closed.', code: 'closed' }, 409);

  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body.attending !== 'boolean') return json({ error: 'Please choose yes or no.' }, 400);
  const attending = body.attending ? 1 : 0;
  const party = attending ? Math.min(50, Math.max(1, Math.round(Number(body.party) || 1))) : 0;
  const message = String(body.message || '').replace(/[\u0000-\u0009\u000b-\u001f<>]/g, '').trim().slice(0, 300) || null;

  if (parts[3] === 'shared') {
    const name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) return json({ error: 'Please type your name.', code: 'name' }, 400);
    const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM inv_rsvps WHERE invitation_id = ?1 AND guest_id IS NULL`).bind(inv.id).first()).n;
    if (n >= MAX_SHARED_REPLIES) return json({ error: 'Replies are full.' }, 409);
    await env.DB.prepare(`INSERT INTO inv_rsvps (invitation_id, name, attending, party, message) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(inv.id, name, attending, party, message).run();
    return json({ ok: true, attending: !!attending, party });
  }
  if (!/^[a-z0-9]{7}$/.test(parts[3])) return json({ error: 'Not found.' }, 404);
  const guest = await env.DB.prepare(`SELECT id FROM inv_guests WHERE invitation_id = ?1 AND code = ?2`).bind(inv.id, parts[3]).first();
  if (!guest) return json({ error: 'Not found.' }, 404);
  await env.DB.prepare(
    `INSERT INTO inv_rsvps (invitation_id, guest_id, attending, party, message) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(guest_id) DO UPDATE SET attending = excluded.attending, party = excluded.party, message = excluded.message,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).bind(inv.id, guest.id, attending, party, message).run();
  return json({ ok: true, attending: !!attending, party });
}

// ---------------------------------------------------------------- helpers

function notFoundPage() {
  return simplePage(404, 'Link not found', 'តំណនេះមិនត្រឹមត្រូវទេ។ សូមពិនិត្យម្តងទៀត ឬសុំតំណថ្មីពីម្ចាស់កម្មវិធី។', 'This link is not valid. Please check it, or ask the hosts to send it again.');
}
function endedPage() {
  return simplePage(410, 'This invitation has ended', 'ធៀបនេះបានបញ្ចប់ហើយ។ សូមអរគុណចំពោះការចូលរួម!', 'This invitation has ended. Thank you for celebrating with us!');
}
function simplePage(status, title, km, en) {
  return new Response(`<!doctype html><html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · MongkulCard</title><link rel="stylesheet" href="/site/site.css"></head>
<body class="center-page"><main class="card-box"><div class="brand">MONGKULCARD</div><p class="km">${km}</p><p>${en}</p></main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' } });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeJson(t, d) { try { return JSON.parse(t); } catch { return d; } }
function randomCode(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length];
  return s;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' },
  });
}

// MongkulCard: the Worker. Every request to the site arrives here first.
//
// Addresses:
//   /                     greeting page
//   /<event>              polite "use your personal link" page
//   /<event>/<code>       a guest's personal invitation
//   /login, /manage       the host's sign-in and guest manager (src/host.js)
//   /img/...             pictures (served from the public/ folder)
//   /media/<event>/<file> video and music (served from the R2 bucket)
//   /preview/             the new website prototype (hidden from search engines, nothing is saved)
//   /signin, /account, /auth/telegram, /tg/webhook, /api/account/...   customer accounts (src/account.js)
//   /api/invitations/...  the customer's own invitations, saved from the editor (src/invitations.js)
//   /api/packages, /api/orders/...  packages and KHQR payments checked with Bakong (src/payments.js)
//   /api/invitations/<id>/media|photos|music|video, /m/<invitation>/<file>   customers' uploads (src/media.js)
//   /api/invitations/<id>/publish|guests, /api/reply/..., /<slug>[/<code>]   publishing, guest links, RSVP (src/publish.js)

// Rules that match the database: 7 characters from a-z and 2-9 without i, l, o.
const CODE_RE = /^[a-hj-km-np-z2-9]{7}$/;
const SLUG_RE = /^[a-z0-9-]{3,40}$/;

// Link-preview robots (Telegram, Facebook...) fetch a link without a person opening it.
// They must not count as "opened".
const BOT_RE = /bot|crawler|spider|facebookexternalhit|whatsapp|preview|slurp/i;

import { hostPage, appFile, api } from './host.js';
import { siteRoute, accountApi } from './account.js';
import { invitationsApi } from './invitations.js';
import { paymentsApi, dailyJobs } from './payments.js';
import { mediaApi, serveInvitationFile, cleanupMedia } from './media.js';
import { publishApi, selfServicePage, replyApi } from './publish.js';
import { guestPhotos } from './guestphotos.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Customer accounts for the self-service website (src/account.js).
    if (parts[0] === 'api' && parts[1] === 'account') return accountApi(request, env, url, parts);
    if (parts[0] === 'api' && parts[1] === 'invitations' && parts.length >= 4 && ['media', 'photos', 'music', 'video'].includes(parts[3])) {
      return mediaApi(request, env, url, parts);
    }
    if (parts[0] === 'api' && parts[1] === 'invitations' && parts.length >= 4 && ['publish', 'guests'].includes(parts[3])) {
      return publishApi(request, env, url, parts);
    }
    if (parts[0] === 'api' && parts[1] === 'invitations') return invitationsApi(request, env, url, parts);
    if (parts[0] === 'api' && parts[1] === 'reply') return replyApi(request, env, url, parts);
    if (parts[0] === 'm' && parts.length === 3 && (request.method === 'GET' || request.method === 'HEAD')) {
      return (await serveInvitationFile(request, env, parts[1], parts[2])) || page(notFound(), 404);
    }
    if (parts[0] === 'api' && (parts[1] === 'packages' || parts[1] === 'orders')) return paymentsApi(request, env, ctx, url, parts);
    if (['signin', 'auth', 'account', 'site', 'tg'].includes(parts[0])) {
      return (await siteRoute(request, env, ctx, url, parts)) || page(notFound(), 404);
    }

    // A guest's own RSVP: /api/rsvp/<event>/<code> (the personal link is the key).
    if (parts[0] === 'api' && parts[1] === 'rsvp') return guestRsvp(request, env, url, parts);
    // A guest's photos: /api/gphotos/<event>/<code> (src/guestphotos.js).
    if (parts[0] === 'api' && parts[1] === 'gphotos') return guestPhotos(request, env, url, parts);

    // The host's manage page and its data. Only /api/... may change anything.
    if (parts[0] === 'api') return api(request, env, ctx, url, parts);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (parts[0] === 'login' || (parts[0] === 'manage' && parts.length === 1)) {
      return (await hostPage(request, env, url, parts)) || page(notFound(), 404);
    }
    if (parts[0] === 'app' && parts.length === 2) {
      return (await appFile(request, env, url, parts[1])) || page(notFound(), 404);
    }

    // Pictures: hand over to the static files in public/img.
    if (parts[0] === 'img') {
      return env.ASSETS.fetch(request);
    }

    // Video and music: /media/<event>/<file>, kept in the R2 bucket.
    if (parts[0] === 'media' && parts.length === 3 && SLUG_RE.test(parts[1])) {
      return serveMedia(request, env, parts[1], parts[2]);
    }

    // The website prototype: /preview/ and /preview/invite.html (static files in public/preview).
    if (parts[0] === 'preview') return previewFile(request, env, url, parts);

    // Home
    if (parts.length === 0) return page(greeting());

    // /<event>
    // Self-service invitations: /<slug> (shared link) and /<slug>/<code> (one guest). Others fall through to the old system.
    if ((parts.length === 1 || (parts.length === 2 && CODE_RE.test(parts[1].toLowerCase()))) && SLUG_RE.test(parts[0])) {
      const own = await selfServicePage(request, env, ctx, url, parts);
      if (own) return own;
    }
    if (parts.length === 1 && SLUG_RE.test(parts[0])) return page(politePage());

    // /<event>/<code>
    if (parts.length === 2 && SLUG_RE.test(parts[0]) && CODE_RE.test(parts[1].toLowerCase())) {
      return guestInvitation(request, env, ctx, url, parts[0], parts[1].toLowerCase());
    }

    return page(notFound(), 404);
  },

  // Once a day (wrangler.jsonc "triggers"): expire old payment QRs, remind Samotra before the Bakong token expires.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyJobs(env));
    ctx.waitUntil(cleanupMedia(env));
  },
};

async function guestInvitation(request, env, ctx, url, slug, code) {
  // lang_zh arrives with migration 0004; until it has been applied, read the guest without it.
  const guestSql = (zh) => env.DB.prepare(
    `SELECT g.id, g.display_name, ${zh ? "CASE WHEN g.lang_zh = 1 THEN 'zh' ELSE g.language END" : 'g.language'} AS language, e.status, t.code AS template,
            (strftime('%Y-%m-%dT%H:%M:%SZ','now') > e.links_expire_at) AS expired
       FROM guests g
       JOIN events e    ON e.id = g.event_id
       JOIN templates t ON t.id = e.template_id
      WHERE e.slug = ?1 AND g.code = ?2
        AND g.deleted_at IS NULL AND g.is_disabled = 0`
  ).bind(slug, code).first();
  let guest;
  try { guest = await guestSql(true); }
  catch (e) { if (!/lang_zh/.test(String(e && e.message))) throw e; guest = await guestSql(false); }

  // Unknown, disabled or archived: say nothing about why.
  if (!guest || guest.status === 'archived') return page(notFound(), 404);

  // Event over, or the link passed its expiry date: friendly page, not an error.
  if (guest.status === 'ended' || guest.expired) return page(endedPage(), 410);

  // Load the design file and put this guest's name in it.
  const file = await env.ASSETS.fetch(new URL(`/t/${guest.template}.html`, url));
  if (!file.ok) return new Response('Template missing', { status: 500 });
  let html = await file.text();

  // The design files say img/... and media/..., which only works on a page at the site root.
  // On /lychhayly/<code> the browser would look in /lychhayly/img/..., so make them start with "/". Media also gets the event name in front.
  html = html.replace(/(["'(])img\//g, '$1/img/');
  html = html.replace(/(["'(])media\//g, (m, q) => `${q}/media/${slug}/`);

  const MARK = '__GUEST_JS__';
  if (!html.includes("guest:'Chenda'")) return new Response('Template has no guest field', { status: 500 });
  html = html.replace("guest:'Chenda'", () => 'guest:' + MARK);        // the setting used by the script
  html = html.replaceAll('Chenda', () => escapeHtml(guest.display_name)); // the visible text
  html = html.replace(MARK, () => jsString(guest.display_name));

  // The language the host chose for this guest (the guest can still switch inside the invitation).
  const lang = guest.language === 'en' ? 'en' : guest.language === 'zh' ? 'zh' : 'km';
  const langAttr = lang === 'zh' ? 'zh-Hans' : lang;
  html = html.replace("lang:'km',", () => `lang:'${lang}',`);
  html = html.replace('<html lang="km" data-lang="km">', () => `<html lang="${langAttr}" data-lang="${lang}">`);

  // Count the open (real people only), without making the guest wait.
  if (request.method === 'GET' && !BOT_RE.test(request.headers.get('user-agent') || '')) {
    ctx.waitUntil(
      env.DB.prepare(
        `UPDATE guests
            SET first_opened_at = COALESCE(first_opened_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                last_opened_at  = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                open_count      = open_count + 1
          WHERE id = ?1`
      ).bind(guest.id).run()
    );
  }

  return page(html, 200, { 'cache-control': 'private, no-store' });
}

// ---------------------------------------------------------------- RSVP
// GET  /api/rsvp/<event>/<code>          -> { status: 'yes'|'no'|null, party }
// POST /api/rsvp/<event>/<code>  {status, party}
// The reply is stored for the event's main segment (the evening reception), one row per guest,
// and the guest can change it until the link expires.
async function guestRsvp(request, env, url, parts) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });
  if (parts.length !== 4 || !SLUG_RE.test(parts[2]) || !CODE_RE.test(parts[3].toLowerCase())) return out({ error: 'Not found.' }, 404);
  const method = request.method;
  if (method !== 'GET' && method !== 'POST') return out({ error: 'Method not allowed.' }, 405);
  if (method === 'POST') {
    if (request.headers.get('origin') !== url.origin) return out({ error: 'Not allowed.' }, 403);
    if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return out({ error: 'Not allowed.' }, 415);
  }

  const g = await env.DB.prepare(
    `SELECT g.id AS guest_id, e.id AS event_id, e.status, e.rsvp_enabled,
            (strftime('%Y-%m-%dT%H:%M:%SZ','now') > e.links_expire_at) AS expired,
            (SELECT s.id FROM segments s WHERE s.event_id = e.id ORDER BY s.is_primary DESC, s.sort_order DESC, s.id DESC LIMIT 1) AS segment_id
       FROM guests g JOIN events e ON e.id = g.event_id
      WHERE e.slug = ?1 AND g.code = ?2 AND g.deleted_at IS NULL AND g.is_disabled = 0`
  ).bind(parts[2], parts[3].toLowerCase()).first();
  if (!g || g.status === 'archived' || !g.segment_id) return out({ error: 'Not found.' }, 404);

  if (method === 'GET') {
    const r = await env.DB.prepare(`SELECT status, party_size FROM rsvps WHERE guest_id = ?1 AND segment_id = ?2`).bind(g.guest_id, g.segment_id).first();
    return out({ status: r ? r.status : null, party: r ? r.party_size : 0, open: g.status === 'live' && g.rsvp_enabled === 1 && !g.expired });
  }

  if (g.status !== 'live' || g.rsvp_enabled !== 1 || g.expired) return out({ error: 'Replies are not open.', closed: true }, 409);
  let body = null;
  try { body = await request.json(); } catch { body = null; }
  const status = body && (body.status === 'yes' || body.status === 'no') ? body.status : null;
  const party = status === 'yes' ? Math.trunc(Number(body.party)) : 0;
  if (!status || (status === 'yes' && !(party >= 1 && party <= 10))) return out({ error: 'Please check your answer.' }, 400);

  await env.DB.prepare(
    `INSERT INTO rsvps (guest_id, segment_id, event_id, status, party_size) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (guest_id, segment_id) DO UPDATE SET status = excluded.status, party_size = excluded.party_size,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).bind(g.guest_id, g.segment_id, g.event_id, status, party).run();
  return out({ ok: true, status, party });
}

// Video and music from R2. Phones ask for the file in pieces ("Range"), which is what
// lets a video start quickly and be skipped forward, so we answer those properly.
const MEDIA_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,59}\.(mp4|mp3|m4a|webm|jpg|png|webp)$/i;

async function serveMedia(request, env, slug, file) {
  if (!MEDIA_FILE_RE.test(file) || file.includes('..')) return page(notFound(), 404);

  const obj = await env.PHOTOS.get(`media/${slug}/${file}`, { range: request.headers });
  if (!obj) return page(notFound(), 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers); // content-type etc. stored with the file
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=3600');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('x-content-type-options', 'nosniff');

  let status = 200;
  if (obj.range && request.headers.has('range')) {
    const size = obj.size;
    let start, end;
    const r = obj.range;
    if (r.suffix !== undefined && r.suffix !== null) {
      // "the last N bytes"
      start = Math.max(0, size - r.suffix);
      end = size - 1;
    } else {
      start = r.offset ?? 0;
      end = r.length !== undefined && r.length !== null ? start + r.length - 1 : size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      // Safety net: read the numbers from the browser's own Range header instead.
      const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
      if (m && m[1] !== '') {
        start = Number(m[1]);
        end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else if (m && m[2] !== '') {
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      } else {
        start = 0;
        end = size - 1;
      }
    }
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
    headers.set('content-length', String(end - start + 1));
    status = 206;
  } else {
    headers.set('content-length', String(obj.size));
  }

  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
}

// ---------------------------------------------------------------- website prototype
// Only these two files; anything else under /preview is "not found".
async function previewFile(request, env, url, parts) {
  if (parts.length === 1 && !url.pathname.endsWith('/')) {
    return Response.redirect(new URL('/preview/', url).toString(), 301);
  }
  const file = parts.length === 1 ? 'index.html' : parts.length === 2 && ['invite.html', 'qrcode.js', 'bgm.mp3'].includes(parts[1]) ? parts[1] : null;
  if (!file) return page(notFound(), 404);
  const res = await env.ASSETS.fetch(new URL('/preview/' + file, url));
  if (!res.ok) return page(notFound(), 404);
  if (file === 'bgm.mp3') return audioFile(request, await res.arrayBuffer());
  if (file === 'qrcode.js') {
    return new Response(res.body, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
  }
  return page(await res.text(), 200, { 'cache-control': 'no-cache' });
}

// The website's soft background music. Safari only plays audio when the server answers "Range" requests.
function audioFile(request, buf) {
  const size = buf.byteLength;
  const headers = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' };
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (!m || (m[1] === '' && m[2] === '')) return new Response(buf, { headers: { ...headers, 'content-length': String(size) } });
  let start = m[1] !== '' ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
}

// ---------------------------------------------------------------- helpers

function page(html, status = 200, extra = {}) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow', // search engines blocked for now
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...extra,
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A safe JavaScript string for putting a name inside a <script>.
function jsString(s) {
  return JSON.stringify(String(s))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Battambang&display=swap" rel="stylesheet">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f1e7;color:#4a3f2a;font-family:'Cormorant Garamond',serif;text-align:center}
main{max-width:420px;padding:32px 24px}
h1{font-size:2rem;font-weight:600;margin:0 0 12px;color:#8a6d2f;letter-spacing:.04em}
p{font-size:1.2rem;line-height:1.5;margin:10px 0}
.kh{font-family:'Battambang',serif;font-size:1.05rem;line-height:1.9}
.rule{width:56px;height:1px;background:#c9a95c;margin:18px auto}
</style></head><body><main>${body}</main></body></html>`;
}

function greeting() {
  return shell('MongkulCard', `
<h1>MongkulCard</h1>
<div class="rule"></div>
<p>Khmer and English e-invitations for weddings and family celebrations.</p>
<p class="kh">សំបុត្រអញ្ជើញអេឡិចត្រូនិកជាភាសាខ្មែរ និងអង់គ្លេស</p>
<div class="rule"></div>
<p>To order, please contact us on Telegram.</p>`);
}

function politePage() {
  return shell('MongkulCard', `
<h1>Welcome</h1>
<div class="rule"></div>
<p>Please open the invitation using the personal link you received.</p>
<p class="kh">សូមបើកសំបុត្រអញ្ជើញតាមតំណផ្ទាល់ខ្លួនដែលអ្នកបានទទួល</p>`);
}

function endedPage() {
  return shell('Invitation ended', `
<h1>Thank you</h1>
<div class="rule"></div>
<p>This invitation has ended. We are grateful you were part of the celebration.</p>
<p class="kh">សំបុត្រអញ្ជើញនេះបានបញ្ចប់ហើយ។ សូមអរគុណដែលបានចូលរួមអបអរសាទរជាមួយយើងខ្ញុំ។</p>`);
}

function notFound() {
  return shell('Link not found', `
<h1>Link not found</h1>
<div class="rule"></div>
<p>This link is not valid. Please check it, or ask the host to send it again.</p>
<p class="kh">តំណនេះមិនត្រឹមត្រូវទេ។ សូមពិនិត្យម្តងទៀត ឬសុំអ្នកផ្ញើតំណថ្មី។</p>`);
}

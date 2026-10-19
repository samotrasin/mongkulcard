// MongkulCard: the Worker. Every request to the site arrives here first.
//
// Addresses:
//   /                     greeting page
//   /<event>              polite "use your personal link" page
//   /<event>/<code>       a guest's personal invitation
//   /img/...             pictures (served from the public/ folder)
//   /media/<event>/<file> video and music (served from the R2 bucket)

// Rules that match the database: 7 characters from a-z and 2-9 without i, l, o.
const CODE_RE = /^[a-hj-km-np-z2-9]{7}$/;
const SLUG_RE = /^[a-z0-9-]{3,40}$/;

// Link-preview robots (Telegram, Facebook...) fetch a link without a person opening it.
// They must not count as "opened".
const BOT_RE = /bot|crawler|spider|facebookexternalhit|whatsapp|preview|slurp/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Pictures: hand over to the static files in public/img.
    if (parts[0] === 'img') {
      return env.ASSETS.fetch(request);
    }

    // Video and music: /media/<event>/<file>, kept in the R2 bucket.
    if (parts[0] === 'media' && parts.length === 3 && SLUG_RE.test(parts[1])) {
      return serveMedia(request, env, parts[1], parts[2]);
    }

    // Home
    if (parts.length === 0) return page(greeting());

    // /<event>
    if (parts.length === 1 && SLUG_RE.test(parts[0])) return page(politePage());

    // /<event>/<code>
    if (parts.length === 2 && SLUG_RE.test(parts[0]) && CODE_RE.test(parts[1].toLowerCase())) {
      return guestInvitation(request, env, ctx, url, parts[0], parts[1].toLowerCase());
    }

    return page(notFound(), 404);
  },
};

async function guestInvitation(request, env, ctx, url, slug, code) {
  const guest = await env.DB.prepare(
    `SELECT g.id, g.display_name, e.status, t.code AS template,
            (strftime('%Y-%m-%dT%H:%M:%SZ','now') > e.links_expire_at) AS expired
       FROM guests g
       JOIN events e    ON e.id = g.event_id
       JOIN templates t ON t.id = e.template_id
      WHERE e.slug = ?1 AND g.code = ?2
        AND g.deleted_at IS NULL AND g.is_disabled = 0`
  ).bind(slug, code).first();

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

// Guest photo sharing for hand-made invitations (Ly Chhayly & Ma Meyhuy).
//
//   GET  /api/gphotos/<event>/<code>   is sharing open, how many photos this link has sent
//   POST /api/gphotos/<event>/<code>   one photo (multipart: photo, thumb, w, h, name, key)
//
// The couple's album lives behind their sign-in (see hostPhotos below, called from host.js):
//   GET    /api/photos?event=<id>       list
//   GET    /api/photos/<id>/thumb|full  the picture itself
//   DELETE /api/photos/<id>             remove a photo
//
// Files go to the private R2 bucket (env.PHOTOS); the database keeps one small row per photo.
// The database rules (trigger photos_rules) decide whether uploads are open and enforce 5 per link.

const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const CODE_RE = /^[a-hj-km-np-z2-9]{7}$/;
const MAX_PHOTO = 2621440;   // 2.5 MB, same as the database rule
const MAX_THUMB = 300000;

const H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' };
const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: H });

function isJpeg(buf) {
  const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
  return b.length === 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
function rand(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}
async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
function cleanName(v) {
  const s = String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 80) : null;
}

export async function guestPhotos(request, env, url, parts) {
  if (parts.length !== 4 || !SLUG_RE.test(parts[2]) || !CODE_RE.test(parts[3].toLowerCase())) return out({ error: 'Not found.' }, 404);
  const method = request.method;
  if (method !== 'GET' && method !== 'POST') return out({ error: 'Method not allowed.' }, 405);
  if (method === 'POST' && request.headers.get('origin') !== url.origin) return out({ error: 'Not allowed.' }, 403);

  const g = await env.DB.prepare(
    `SELECT g.id AS guest_id, e.id AS event_id, e.slug, e.max_photos_per_guest AS max,
            (e.status = 'live' AND e.photos_enabled = 1
             AND e.photos_open_at  <= strftime('%Y-%m-%dT%H:%M:%SZ','now')
             AND e.links_expire_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS open,
            (SELECT COUNT(*) FROM photos p WHERE p.guest_id = g.id) AS used
       FROM guests g JOIN events e ON e.id = g.event_id
      WHERE e.slug = ?1 AND g.code = ?2 AND g.deleted_at IS NULL AND g.is_disabled = 0 AND e.status != 'archived'`
  ).bind(parts[2], parts[3].toLowerCase()).first();
  if (!g) return out({ error: 'Not found.' }, 404);

  if (method === 'GET') return out({ open: g.open === 1, used: g.used, max: g.max });

  if (g.open !== 1) return out({ error: 'Photo sharing is not open.', closed: true }, 409);
  if (g.used >= g.max) return out({ error: 'This link has already shared the most photos.', full: true, used: g.used, max: g.max }, 409);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')) return out({ error: 'Not allowed.' }, 415);
  if (Number(request.headers.get('content-length') || 0) > MAX_PHOTO + MAX_THUMB + 20000) return out({ error: 'That photo is too large.' }, 413);

  let form;
  try { form = await request.formData(); } catch { return out({ error: 'Please try again.' }, 400); }
  const photo = form.get('photo'), thumb = form.get('thumb');
  if (!photo || typeof photo === 'string' || !thumb || typeof thumb === 'string') return out({ error: 'Please choose a photo.' }, 400);
  if (photo.size < 1 || photo.size > MAX_PHOTO || thumb.size < 1 || thumb.size > MAX_THUMB) return out({ error: 'That photo is too large.' }, 413);
  const w = Math.trunc(Number(form.get('w'))), h = Math.trunc(Number(form.get('h')));
  if (!(w > 0 && w <= 10000 && h > 0 && h <= 10000)) return out({ error: 'Please try again.' }, 400);
  const key = String(form.get('key') || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return out({ error: 'Please try again.' }, 400);
  const name = cleanName(form.get('name'));

  const pbuf = await photo.arrayBuffer(), tbuf = await thumb.arrayBuffer();
  if (!isJpeg(pbuf) || !isJpeg(tbuf)) return out({ error: 'Only photos can be shared.' }, 415);

  const day = new Date().toISOString().slice(0, 10);
  const r2 = `guest-photos/${g.slug}/${day}-${rand(12)}.jpg`;
  let id;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO photos (event_id, guest_id, source, uploader_name, uploader_key, r2_key, mime, bytes, width, height, sha256)
       VALUES (?1, ?2, 'guest_link', ?3, ?4, ?5, 'image/jpeg', ?6, ?7, ?8, ?9) RETURNING id`
    ).bind(g.event_id, g.guest_id, name, key, r2, pbuf.byteLength, w, h, await sha256(pbuf)).first();
    id = row.id;
  } catch (e) {
    const m = String(e && e.message);
    if (/limit/.test(m)) return out({ error: 'This link has already shared the most photos.', full: true }, 409);
    if (/closed/.test(m)) return out({ error: 'Photo sharing is not open.', closed: true }, 409);
    throw e;
  }
  try {
    await env.PHOTOS.put(r2, pbuf, { httpMetadata: { contentType: 'image/jpeg' } });
    await env.PHOTOS.put(r2.replace(/\.jpg$/, '.t.jpg'), tbuf, { httpMetadata: { contentType: 'image/jpeg' } });
  } catch (e) {
    await env.DB.prepare(`DELETE FROM photos WHERE id = ?1`).bind(id).run();
    try { await env.PHOTOS.delete([r2, r2.replace(/\.jpg$/, '.t.jpg')]); } catch {}
    return out({ error: 'Sorry, the photo did not upload. Please try again.' }, 503);
  }
  return out({ ok: true, used: g.used + 1, max: g.max });
}

// ---------------------------------------------------------------- the couple's album (needs their sign-in)

export async function hostPhotos(request, env, session, route, url, json, audit) {
  const method = request.method;
  if (route === 'photos' && method === 'GET') {
    const ev = await env.DB.prepare(`SELECT id, slug FROM events WHERE id = ?1 AND customer_id = ?2 AND status != 'archived'`)
      .bind(Number(url.searchParams.get('event')), session.customer_id).first();
    if (!ev) return json({ error: 'Not found.' }, 404);
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.uploader_name AS name, g.display_name AS guest, p.uploaded_at AS at, p.width AS w, p.height AS h, p.bytes
         FROM photos p LEFT JOIN guests g ON g.id = p.guest_id
        WHERE p.event_id = ?1 ORDER BY p.uploaded_at DESC, p.id DESC`
    ).bind(ev.id).all();
    return json({ slug: ev.slug, photos: results });
  }
  const m = /^photos\/(\d{1,12})(?:\/(thumb|full))?$/.exec(route);
  if (!m) return null;
  const p = await env.DB.prepare(
    `SELECT p.id, p.r2_key, p.event_id FROM photos p JOIN events e ON e.id = p.event_id
      WHERE p.id = ?1 AND e.customer_id = ?2`
  ).bind(Number(m[1]), session.customer_id).first();
  if (!p) return json({ error: 'Not found.' }, 404);

  if (method === 'GET' && m[2]) {
    const obj = await env.PHOTOS.get(m[2] === 'thumb' ? p.r2_key.replace(/\.jpg$/, '.t.jpg') : p.r2_key);
    if (!obj) return json({ error: 'Not found.' }, 404);
    return new Response(obj.body, { headers: {
      'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="photo-${p.id}.jpg"`,
    } });
  }
  if (method === 'DELETE' && !m[2]) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM photos WHERE id = ?1`).bind(p.id),
      audit(env, p.event_id, session.username, 'photo.deleted', 'photo', p.id, null),
    ]);
    try { await env.PHOTOS.delete([p.r2_key, p.r2_key.replace(/\.jpg$/, '.t.jpg')]); } catch {}
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}

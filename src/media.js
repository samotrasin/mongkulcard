// MongkulCard: photos and music customers upload for their own invitation (stored in R2).
//
//   GET    /api/invitations/<id>/media            what is uploaded
//   POST   /api/invitations/<id>/photos           one photo (JPEG/PNG/WebP, already resized on the phone; max 20)
//   PUT    /api/invitations/<id>/photos/order     new order { ids: [...] } (the first one is the cover)
//   POST   /api/invitations/<id>/music            the couple's own song (MP3/M4A, max 10 MB; replaces the old one)
//   POST   /api/invitations/<id>/video            ask Cloudflare Stream for a one-time upload link (the phone uploads straight to Stream)
//   DELETE /api/invitations/<id>/media/<mid>      remove one file
//   GET    /m/<invitation>/<file>                 the file itself, for guests (random names, cached for a year)
//
// Files are deleted 30 days after the guest links expire (event date + 7 days), see cleanupMedia().
//
// Video uses Cloudflare Stream (plays on every phone, adjusts quality to the guest's internet).
// Settings: CF_ACCOUNT_ID and CF_STREAM_TOKEN (secrets; token needs "Stream: Edit"). Video is off until both are set.

export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;   // Stream's simple upload allows up to 200 MB
export const VIDEO_MAX_SECONDS = 180;               // 3 minutes

import { getAccount } from './account.js';

export const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_MUSIC_BYTES = 10 * 1024 * 1024;
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MUSIC_TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a' };
const FILE_RE = /^[a-z0-9]{12}\.(jpg|png|webp|mp3|m4a)$/;

export async function mediaApi(request, env, url, parts) {
  // parts: ['api','invitations',<id>, 'media'|'photos'|'music', ...]
  const method = request.method;
  if (method !== 'GET' && request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
  const me = await getAccount(request, env);
  if (!me) return json({ error: 'Please sign in again.' }, 401);
  const inv = await env.DB.prepare(
    `SELECT id, public_id, status FROM invitations WHERE public_id = ?1 AND account_id = ?2 AND status <> 'archived'`
  ).bind(parts[2], me.id).first();
  if (!inv) return json({ error: 'Not found.' }, 404);

  const what = parts[3];
  if (what === 'media' && parts.length === 4 && method === 'GET') return listMedia(env, inv);
  if (what === 'photos' && parts.length === 4 && method === 'POST') return addPhoto(request, env, inv);
  if (what === 'photos' && parts[4] === 'order' && parts.length === 5 && method === 'PUT') return reorder(request, env, inv);
  if (what === 'music' && parts.length === 4 && method === 'POST') return setMusic(request, env, inv);
  if (what === 'video' && parts.length === 4 && method === 'POST') return startVideo(request, env, inv);
  if (what === 'media' && parts.length === 5 && method === 'DELETE' && /^[a-z0-9]{12}$/.test(parts[4])) return removeMedia(env, inv, parts[4]);
  return json({ error: 'Not found.' }, 404);
}

export async function listMedia(env, inv) {
  return json(await mediaFor(env, inv));
}

// Also used to build the guest page later.
export async function mediaFor(env, inv) {
  const { results } = await env.DB.prepare(
    `SELECT public_id, kind, r2_key, stream_uid, mime, bytes, width, height, duration, original_name, status
       FROM invitation_media WHERE invitation_id = ?1 ORDER BY kind, sort, id`
  ).bind(inv.id).all();
  const fileUrl = (r) => `/m/${inv.public_id}/${r.r2_key.split('/').pop()}`;
  const photos = results.filter((r) => r.kind === 'photo').map((r) => ({ id: r.public_id, url: fileUrl(r), w: r.width, h: r.height, bytes: r.bytes }));
  const m = results.find((r) => r.kind === 'music');
  let v = results.find((r) => r.kind === 'video');
  if (v && v.status !== 'ready' && v.status !== 'error' && streamReady(env)) v = await refreshVideo(env, v);
  return {
    photos, maxPhotos: MAX_PHOTOS,
    music: m ? { id: m.public_id, url: fileUrl(m), name: m.original_name, bytes: m.bytes } : null,
    video: v ? {
      id: v.public_id, uid: v.stream_uid, status: v.status, name: v.original_name, bytes: v.bytes, duration: v.duration,
      poster: `https://videodelivery.net/${v.stream_uid}/thumbnails/thumbnail.jpg?time=1s&height=720`,
      player: `https://iframe.videodelivery.net/${v.stream_uid}`,
    } : null,
    videoEnabled: streamReady(env), videoMaxBytes: VIDEO_MAX_BYTES, videoMaxSeconds: VIDEO_MAX_SECONDS,
  };
}

async function addPhoto(request, env, inv) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = PHOTO_TYPES[type];
  if (!ext) return json({ error: 'Please choose a photo (JPEG, PNG or WebP).' }, 415);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM invitation_media WHERE invitation_id = ?1 AND kind = 'photo'`).bind(inv.id).first();
  if (count.n >= MAX_PHOTOS) return json({ error: `You can add up to ${MAX_PHOTOS} photos.`, code: 'limit' }, 409);

  const body = await readLimited(request, MAX_PHOTO_BYTES);
  if (!body) return json({ error: 'This photo is too big. Please choose a smaller one.' }, 413);
  if (!looksLike(body, ext)) return json({ error: 'This file is not a photo.' }, 415);
  const w = clampInt(request.headers.get('x-width'), 1, 10000), h = clampInt(request.headers.get('x-height'), 1, 10000);

  const id = randomId(12);
  const key = `m/${inv.public_id}/${id}.${ext}`;
  await env.PHOTOS.put(key, body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare(
    `INSERT INTO invitation_media (public_id, invitation_id, kind, r2_key, mime, bytes, width, height, sort)
     VALUES (?1, ?2, 'photo', ?3, ?4, ?5, ?6, ?7, (SELECT COALESCE(MAX(sort), 0) + 1 FROM invitation_media WHERE invitation_id = ?2 AND kind = 'photo'))`
  ).bind(id, inv.id, key, type, body.byteLength, w, h).run();
  return json(await mediaFor(env, inv), 201);
}

async function reorder(request, env, inv) {
  let ids;
  try { ids = (await request.json()).ids; } catch { ids = null; }
  if (!Array.isArray(ids) || ids.length > MAX_PHOTOS || !ids.every((x) => typeof x === 'string' && /^[a-z0-9]{12}$/.test(x))) {
    return json({ error: 'Bad order.' }, 400);
  }
  await env.DB.batch(ids.map((pid, i) =>
    env.DB.prepare(`UPDATE invitation_media SET sort = ?1 WHERE public_id = ?2 AND invitation_id = ?3 AND kind = 'photo'`).bind(i + 1, pid, inv.id)));
  return json(await mediaFor(env, inv));
}

async function setMusic(request, env, inv) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = MUSIC_TYPES[type];
  if (!ext) return json({ error: 'Please choose an MP3 or M4A song.' }, 415);
  const body = await readLimited(request, MAX_MUSIC_BYTES);
  if (!body) return json({ error: 'This song is bigger than 10 MB. Please choose a shorter or smaller file.' }, 413);
  if (!looksLike(body, ext)) return json({ error: 'This file is not an MP3 or M4A song.' }, 415);
  const name = decodeHeader(request.headers.get('x-filename')).slice(0, 80);

  const old = await env.DB.prepare(`SELECT id, r2_key FROM invitation_media WHERE invitation_id = ?1 AND kind = 'music'`).bind(inv.id).all();
  const id = randomId(12);
  const key = `m/${inv.public_id}/${id}.${ext}`;
  await env.PHOTOS.put(key, body, { httpMetadata: { contentType: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4', cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare(
    `INSERT INTO invitation_media (public_id, invitation_id, kind, r2_key, mime, bytes, original_name) VALUES (?1, ?2, 'music', ?3, ?4, ?5, ?6)`
  ).bind(id, inv.id, key, type, body.byteLength, name || null).run();
  for (const o of old.results) {
    await env.PHOTOS.delete(o.r2_key);
    await env.DB.prepare(`DELETE FROM invitation_media WHERE id = ?1`).bind(o.id).run();
  }
  return json(await mediaFor(env, inv), 201);
}

async function removeMedia(env, inv, mid) {
  const row = await env.DB.prepare(`SELECT id, r2_key, stream_uid FROM invitation_media WHERE public_id = ?1 AND invitation_id = ?2`).bind(mid, inv.id).first();
  if (!row) return json({ error: 'Not found.' }, 404);
  if (row.r2_key) await env.PHOTOS.delete(row.r2_key);
  if (row.stream_uid) await streamDelete(env, row.stream_uid);
  await env.DB.prepare(`DELETE FROM invitation_media WHERE id = ?1`).bind(row.id).run();
  return json(await mediaFor(env, inv));
}

// ---------------------------------------------------------------- video (Cloudflare Stream)

function streamReady(env) { return !!(env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN); }
function streamApi(env, path) {
  return `${env.STREAM_API_BASE || 'https://api.cloudflare.com'}/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream${path}`;   // STREAM_API_BASE only for local tests
}
async function streamFetch(env, path, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(streamApi(env, path), { ...init, signal: ctl.signal, headers: { authorization: `Bearer ${env.CF_STREAM_TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
    return await r.json().catch(() => ({ success: false }));
  } catch (e) {
    return { success: false, errors: [{ message: String(e && e.message) }] };
  } finally { clearTimeout(t); }
}
export async function streamDelete(env, uid) {
  if (!streamReady(env) || !uid) return;
  await streamFetch(env, `/${encodeURIComponent(uid)}`, { method: 'DELETE' });
}

async function startVideo(request, env, inv) {
  if (!streamReady(env)) return json({ error: 'Video upload is being set up. Please try again soon.', code: 'not_ready' }, 503);
  let body;
  try { body = await request.json(); } catch { body = null; }
  const size = Number(body && body.size), seconds = Number(body && body.duration);
  const type = String((body && body.type) || '').toLowerCase();
  const name = String((body && body.name) || 'video').replace(/[\u0000-\u001f<>]/g, '').slice(0, 80);
  if (!['video/mp4', 'video/quicktime', 'video/x-m4v'].includes(type)) return json({ error: 'Please choose an MP4 or MOV video.' }, 415);
  if (!(size > 0) || size > VIDEO_MAX_BYTES) return json({ error: 'The video must be smaller than 200 MB.' }, 413);
  if (seconds && seconds > VIDEO_MAX_SECONDS + 1) return json({ error: 'The video must be 3 minutes or shorter.' }, 413);

  const res = await streamFetch(env, '/direct_upload', {
    method: 'POST',
    body: JSON.stringify({
      maxDurationSeconds: VIDEO_MAX_SECONDS,
      expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      requireSignedURLs: false,
      allowedOrigins: ['mongkulcard.com', '*.mongkulcard.com'],
      meta: { name, invitation: inv.public_id },
    }),
  });
  if (!res.success || !res.result || !res.result.uploadURL) {
    console.log('stream direct_upload failed', JSON.stringify(res.errors || res).slice(0, 300));
    return json({ error: 'Could not start the upload. Please try again.' }, 502);
  }
  const old = await env.DB.prepare(`SELECT id, stream_uid FROM invitation_media WHERE invitation_id = ?1 AND kind = 'video'`).bind(inv.id).all();
  const id = randomId(12);
  await env.DB.prepare(
    `INSERT INTO invitation_media (public_id, invitation_id, kind, stream_uid, mime, bytes, duration, original_name, status)
     VALUES (?1, ?2, 'video', ?3, ?4, ?5, ?6, ?7, 'uploading')`
  ).bind(id, inv.id, res.result.uid, type, Math.round(size), seconds || null, name).run();
  for (const o of old.results) {
    await streamDelete(env, o.stream_uid);
    await env.DB.prepare(`DELETE FROM invitation_media WHERE id = ?1`).bind(o.id).run();
  }
  return json({ uploadURL: res.result.uploadURL, id, uid: res.result.uid }, 201);
}

// Ask Stream how the video is doing (uploading → processing → ready).
async function refreshVideo(env, v) {
  const r = await streamFetch(env, `/${encodeURIComponent(v.stream_uid)}`);
  if (!r.success || !r.result) return v;
  const st = r.result.status || {};
  let status = v.status;
  if (r.result.readyToStream) status = 'ready';
  else if (st.state === 'error') status = 'error';
  else if (['queued', 'inprogress', 'downloading'].includes(st.state)) status = 'processing';
  const duration = r.result.duration > 0 ? r.result.duration : v.duration;
  if (status !== v.status || duration !== v.duration) {
    await env.DB.prepare(`UPDATE invitation_media SET status = ?1, duration = ?2 WHERE public_id = ?3`).bind(status, duration, v.public_id).run();
  }
  return { ...v, status, duration };
}

// ---------------------------------------------------------------- serving files to guests

export async function serveInvitationFile(request, env, invPublicId, file) {
  if (!/^[a-z0-9]{10}$/.test(invPublicId) || !FILE_RE.test(file)) return null;
  const obj = await env.PHOTOS.get(`m/${invPublicId}/${file}`, { range: request.headers });
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('x-content-type-options', 'nosniff');
  if (obj.range && request.headers.has('range')) {
    const size = obj.size;
    const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
    let start = 0, end = size - 1;
    if (m && m[1] !== '') { start = Number(m[1]); end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1; }
    else if (m && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// ---------------------------------------------------------------- cleanup (daily)
// Guest links work until one week after the event; uploads are deleted 30 days after that.

export async function cleanupMedia(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.r2_key, m.stream_uid FROM invitation_media m JOIN invitations i ON i.id = m.invitation_id
      WHERE json_extract(i.settings, '$.date') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(json_extract(i.settings, '$.date'), '+37 days') < date('now')
      LIMIT 500`
  ).all();
  for (const r of results) {
    if (r.r2_key) await env.PHOTOS.delete(r.r2_key);
    if (r.stream_uid) await streamDelete(env, r.stream_uid);
    await env.DB.prepare(`DELETE FROM invitation_media WHERE id = ?1`).bind(r.id).run();
  }
  return results.length;
}

// ---------------------------------------------------------------- helpers

async function readLimited(request, max) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > max) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > max) return null;
  return buf;
}

// Check the first bytes, so nobody can upload something else with a photo label.
function looksLike(buf, ext) {
  const b = new Uint8Array(buf.slice(0, 16));
  const ascii = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (ext === 'jpg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === 'png') return b[0] === 0x89 && ascii(1, 'PNG');
  if (ext === 'webp') return ascii(0, 'RIFF') && ascii(8, 'WEBP');
  if (ext === 'mp3') return ascii(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  if (ext === 'm4a') return ascii(4, 'ftyp');
  return false;
}

function decodeHeader(v) {
  if (!v) return '';
  try { return decodeURIComponent(v).replace(/[\u0000-\u001f<>]/g, ''); } catch { return ''; }
}
function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function randomId(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += ID_CHARS[x % ID_CHARS.length];
  return s;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' },
  });
}

// MongkulCard: the customer's own invitations (drafts saved from the editor).
//
//   GET    /api/invitations          my invitations (newest first)
//   POST   /api/invitations          new draft  { template, event_type, settings }
//   GET    /api/invitations/<id>     one invitation with its settings
//   PUT    /api/invitations/<id>     save settings (the editor's autosave)  { settings }
//   DELETE /api/invitations/<id>     delete a draft (paid or published ones cannot be deleted here)
//
// Every request needs a signed-in customer (account.js) and only ever sees that customer's own rows.

import { getAccount } from './account.js';

const MAX_ACTIVE = 10;                       // drafts + paid + published per account
const TEMPLATES = { 'golden-curtain': ['wedding'] };
const THEMES = ['burgundy', 'emerald', 'navy'];
const FONTS_KH = ['moul', 'moulpali', 'koulen', 'kantumruy', 'hanuman', 'fasthand'];
const FONTS_EN = ['greatvibes', 'pinyon', 'parisienne', 'alexbrush', 'cinzel', 'playfair'];
const OPENINGS = ['glitter', 'curtain'];
const MUSIC = ['none', 'custom', 'golden-morning', 'khmer-strings', 'forever-waltz'];
const SECTIONS = ['countdown', 'program', 'map', 'gallery', 'gift', 'rsvp', 'photos'];
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export async function invitationsApi(request, env, url, parts) {
  const method = request.method;
  if (method !== 'GET') {
    if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
    if (method !== 'DELETE' && !(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      return json({ error: 'Not allowed.' }, 415);
    }
  }
  const me = await getAccount(request, env);
  if (!me) return json({ error: 'Please sign in again.' }, 401);

  if (parts.length === 2) {
    if (method === 'GET') return list(env, me);
    if (method === 'POST') return create(request, env, me);
    return json({ error: 'Not allowed.' }, 405);
  }
  if (parts.length === 3 && /^[a-z0-9]{10}$/.test(parts[2])) {
    const row = await env.DB.prepare(
      `SELECT id, public_id, template, event_type, title, settings, status, created_at, updated_at
         FROM invitations WHERE public_id = ?1 AND account_id = ?2 AND status <> 'archived'`
    ).bind(parts[2], me.id).first();
    if (!row) return json({ error: 'Not found.' }, 404);
    if (method === 'GET') return json({ invitation: shape(row, true) });
    if (method === 'PUT') return save(request, env, me, row);
    if (method === 'DELETE') return remove(env, me, row);
    return json({ error: 'Not allowed.' }, 405);
  }
  return json({ error: 'Not found.' }, 404);
}

async function list(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT public_id, template, event_type, title, settings, status, created_at, updated_at
       FROM invitations WHERE account_id = ?1 AND status <> 'archived' ORDER BY updated_at DESC, id DESC LIMIT 50`
  ).bind(me.id).all();
  return json({ invitations: results.map((r) => shape(r, false)), max: MAX_ACTIVE });
}

async function create(request, env, me) {
  const body = await readJson(request);
  const template = typeof body?.template === 'string' ? body.template : '';
  const eventType = typeof body?.event_type === 'string' ? body.event_type : 'wedding';
  if (!TEMPLATES[template] || !TEMPLATES[template].includes(eventType)) return json({ error: 'Unknown template.' }, 400);

  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM invitations WHERE account_id = ?1 AND status <> 'archived'`).bind(me.id).first();
  if (count.n >= MAX_ACTIVE) return json({ error: `You can keep up to ${MAX_ACTIVE} invitations. Please delete an old draft first.`, code: 'limit' }, 409);

  const settings = clean(body?.settings);
  for (let attempt = 0; attempt < 3; attempt++) {
    const publicId = newId();
    try {
      await env.DB.prepare(
        `INSERT INTO invitations (public_id, account_id, template, event_type, title, settings) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(publicId, me.id, template, eventType, titleOf(settings), JSON.stringify(settings)).run();
      const row = await env.DB.prepare(
        `SELECT public_id, template, event_type, title, settings, status, created_at, updated_at FROM invitations WHERE public_id = ?1`
      ).bind(publicId).first();
      return json({ invitation: shape(row, true) }, 201);
    } catch (e) {
      if (!String(e && e.message).includes('UNIQUE')) throw e;   // the rare clash of two random ids: try again
    }
  }
  return json({ error: 'Please try again.' }, 500);
}

async function save(request, env, me, row) {
  const body = await readJson(request);
  if (!body || typeof body.settings !== 'object') return json({ error: 'Nothing to save.' }, 400);
  const settings = clean(body.settings);
  const text = JSON.stringify(settings);
  await env.DB.prepare(
    `UPDATE invitations SET settings = ?1, title = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?3 AND account_id = ?4`
  ).bind(text, titleOf(settings), row.id, me.id).run();
  return json({ ok: true, savedAt: new Date().toISOString(), settings });
}

async function remove(env, me, row) {
  if (row.status !== 'draft') return json({ error: 'Only drafts can be deleted. Please contact MongkulCard.' }, 409);
  const files = await env.DB.prepare(`SELECT r2_key FROM invitation_media WHERE invitation_id = ?1 AND r2_key IS NOT NULL`).bind(row.id).all();
  for (const f of files.results) await env.PHOTOS.delete(f.r2_key);
  await env.DB.prepare(`DELETE FROM invitations WHERE id = ?1 AND account_id = ?2 AND status = 'draft'`).bind(row.id, me.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- settings: keep only what the editor offers

function clean(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = (v) => ({ en: text(v && v.en, 40), km: text(v && v.km, 40) });
  const out = {
    groom: name(s.groom),
    bride: name(s.bride),
    date: /^\d{4}-\d{2}-\d{2}$/.test(s.date) && !isNaN(Date.parse(s.date + 'T00:00:00Z')) ? s.date : '',
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : '17:00',
    venue: text(s.venue, 140),
    mapUrl: typeof s.mapUrl === 'string' && /^https:\/\/[^\s<>"']{4,300}$/.test(s.mapUrl.trim()) ? s.mapUrl.trim() : '',
    theme: THEMES.includes(s.theme) ? s.theme : THEMES[0],
    fontKh: FONTS_KH.includes(s.fontKh) ? s.fontKh : FONTS_KH[0],
    fontEn: FONTS_EN.includes(s.fontEn) ? s.fontEn : FONTS_EN[0],
    opening: OPENINGS.includes(s.opening) ? s.opening : OPENINGS[0],
    music: MUSIC.includes(s.music) ? s.music : MUSIC[0],
    sections: {},
  };
  const sec = s.sections && typeof s.sections === 'object' ? s.sections : {};
  for (const k of SECTIONS) out.sections[k] = sec[k] === undefined ? k !== 'rsvp' : sec[k] === true;
  return out;
}

function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function titleOf(s) {
  const a = s.groom.en || s.groom.km, b = s.bride.en || s.bride.km;
  return (a && b ? `${a} & ${b}` : a || b || 'My invitation').slice(0, 120);
}

function shape(row, withSettings) {
  let settings = {};
  try { settings = JSON.parse(row.settings); } catch { /* keep {} */ }
  const out = {
    id: row.public_id, template: row.template, event_type: row.event_type, title: row.title,
    status: row.status, created_at: row.created_at, updated_at: row.updated_at,
    date: settings.date || '', theme: settings.theme || 'burgundy',
  };
  if (withSettings) out.settings = settings;
  return out;
}

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const x of b) s += ID_CHARS[x % ID_CHARS.length];
  return s;
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 40000) return null;
  try {
    const t = await request.text();
    if (t.length > 40000) return null;
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
    },
  });
}

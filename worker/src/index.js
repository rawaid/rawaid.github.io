// Guest book for the fridge. Entries wait in a queue until approved on /admin.
//
// KV layout (binding GUESTBOOK):
//   pending:<id>              ''   metadata { name, msg, ts }   waiting for review
//   img:<id>                  jpeg                              photo of a pending entry (admin only)
//   approved:<revTs>:<id>     ''   metadata { name, msg, ts }   lists newest first
//   pub:<id>                  jpeg                              photo of an approved entry (public)
//   rl:<hash>                 count, expires after a day        submission counters

import ADMIN_HTML from './admin.html';

const MAX_IMG = 300 * 1024;
const MAX_BODY = 450 * 1024;
const MAX_NAME = 24;
const MAX_MSG = 140;
const PER_VISITOR_PER_DAY = 5;
const PER_DAY = 150;
const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

// newest-first ordering for KV's lexicographic listing
const revTs = ts => String(9999999999999 - ts).padStart(13, '0');

const clean = (s, max) =>
  [...String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : null;
}

async function isAdmin(req, env) {
  if (!env.ADMIN_KEY) return false;
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const [a, b] = await Promise.all([sha256(given), sha256(env.ADMIN_KEY)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// counts one more against a daily limit; false when the limit is already used up
async function underLimit(kv, key, limit) {
  const n = parseInt(await kv.get(key), 10) || 0;
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: 86400 });
  return true;
}

function decodeJpeg(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  let bin;
  try { bin = atob(m[1]); } catch { return null; }
  if (bin.length < 4 || bin.length > MAX_IMG) return null;
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}

async function publish(kv, id, meta, bytes) {
  await kv.put('pub:' + id, bytes);
  await kv.put(`approved:${revTs(meta.ts)}:${id}`, '1', { metadata: meta });
}

async function listEntries(kv, prefix) {
  const { keys } = await kv.list({ prefix, limit: 100 });
  return keys.filter(k => k.metadata).map(k => ({ id: k.name.slice(-36), key: k.name, ...k.metadata }));
}

async function submit(req, env, ctx, cors) {
  if (!cors) return json({ error: 'origin' }, 403);
  if (Number(req.headers.get('Content-Length')) > MAX_BODY) return json({ error: 'too big' }, 413, cors);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: 'too big' }, 413, cors);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad request' }, 400, cors); }
  const bytes = decodeJpeg(body && body.img);
  if (!bytes) return json({ error: 'bad photo' }, 400, cors);

  const kv = env.GUESTBOOK, day = new Date().toISOString().slice(0, 10);
  const who = hex(await sha256((req.headers.get('CF-Connecting-IP') || 'unknown') + day)).slice(0, 24);
  if (!(await underLimit(kv, 'rl:' + who, PER_VISITOR_PER_DAY)) || !(await underLimit(kv, 'rl:all:' + day, PER_DAY)))
    return json({ error: 'slow down' }, 429, cors);

  const id = crypto.randomUUID();
  const meta = { name: clean(body.name, MAX_NAME), msg: clean(body.msg, MAX_MSG), ts: Date.now() };
  if (env.AUTO_APPROVE === 'true') {
    await publish(kv, id, meta, bytes);
  } else {
    await kv.put('img:' + id, bytes);
    await kv.put('pending:' + id, '1', { metadata: meta });
    if (env.DISCORD_WEBHOOK) ctx.waitUntil(fetch(env.DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `New guest book entry from ${meta.name || 'a guest'}: "${meta.msg}"\n${new URL('/admin', req.url)}`, allowed_mentions: { parse: [] } }),
    }).catch(() => {}));
  }
  return json({ id, ts: meta.ts }, 201, cors);
}

async function admin(req, env, path) {
  if (!(await isAdmin(req, env))) return json({ error: 'unauthorized' }, 401);
  const kv = env.GUESTBOOK;

  if (req.method === 'GET' && path === '/admin/entries')
    return json({ pending: (await listEntries(kv, 'pending:')).sort((a, b) => a.ts - b.ts), approved: await listEntries(kv, 'approved:') });

  const img = /^\/admin\/img\/(.+)$/.exec(path);
  if (req.method === 'GET' && img && ID.test(img[1])) {
    const bytes = await kv.get('img:' + img[1], 'arrayBuffer');
    return bytes ? new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } }) : json({ error: 'not found' }, 404);
  }

  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const { id } = await req.json().catch(() => ({}));
  if (!ID.test(id || '')) return json({ error: 'bad id' }, 400);

  if (path === '/admin/approve' || path === '/admin/deny') {
    const { metadata } = await kv.getWithMetadata('pending:' + id);
    if (!metadata) return json({ error: 'not found' }, 404);
    if (path === '/admin/approve') {
      const bytes = await kv.get('img:' + id, 'arrayBuffer');
      if (!bytes) return json({ error: 'not found' }, 404);
      await publish(kv, id, metadata, bytes);
    }
    await Promise.all([kv.delete('pending:' + id), kv.delete('img:' + id)]);
    return json({ ok: true });
  }
  if (path === '/admin/remove') {
    const entry = (await listEntries(kv, 'approved:')).find(e => e.id === id);
    if (!entry) return json({ error: 'not found' }, 404);
    await Promise.all([kv.delete(entry.key), kv.delete('pub:' + id)]);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const { pathname: path } = new URL(req.url);
    const cors = corsHeaders(req, env);

    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });

    if (path === '/entries' && req.method === 'GET') {
      const entries = (await listEntries(env.GUESTBOOK, 'approved:')).map(({ id, name, msg, ts }) => ({ id, name, msg, ts }));
      return json({ entries }, 200, { ...cors, 'Cache-Control': 'public, max-age=30' });
    }
    if (path === '/entries' && req.method === 'POST') return submit(req, env, ctx, cors);

    const pub = /^\/img\/(.+)$/.exec(path);
    if (pub && req.method === 'GET' && ID.test(pub[1])) {
      const bytes = await env.GUESTBOOK.get('pub:' + pub[1], 'arrayBuffer');
      if (!bytes) return json({ error: 'not found' }, 404);
      // approved photos are public, and the fridge draws them into a canvas, so any origin may read them
      return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } });
    }

    if (path === '/admin' && req.method === 'GET')
      return new Response(ADMIN_HTML, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      } });
    if (path.startsWith('/admin/')) return admin(req, env, path);

    return json({ error: 'not found' }, 404);
  },
};

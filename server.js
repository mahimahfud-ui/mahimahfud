import express from 'express';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';

const E = process.env;
const configured = value => Boolean(value && !/^SET_|^YOUR-/i.test(String(value).trim()));
const hasCloudinary = configured(E.CLOUDINARY_CLOUD_NAME) && configured(E.CLOUDINARY_API_KEY) && configured(E.CLOUDINARY_API_SECRET);
const hasSupabase = configured(E.SUPABASE_URL) && configured(E.SUPABASE_SERVICE_KEY);
if (hasCloudinary) cloudinary.config({ cloud_name: E.CLOUDINARY_CLOUD_NAME, api_key: E.CLOUDINARY_API_KEY, api_secret: E.CLOUDINARY_API_SECRET, secure: true });
const sb = hasSupabase ? createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) : null;
const TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const IMG = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAXMB = Math.min(100, Number(E.MAX_UPLOAD_MB || 100));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fail = (r, c, m) => r.status(c).json({ error: m });
const get = async id => sb ? (await sb.from('mf_videos').select('*').eq('id', id).maybeSingle()).data : null;
const signUpload = (publicId, timestamp) => cloudinary.utils.api_sign_request({ public_id: publicId, timestamp }, E.CLOUDINARY_API_SECRET);
const videoUrl = v => cloudinary.url(v.original_key, { secure: true, resource_type: 'video', format: TYPES[v.mime] || 'mp4' });
const imageUrl = publicId => cloudinary.url(publicId, { secure: true, resource_type: 'image' });

async function isOwner(t) {
  if (!sb || !t) return false;
  const u = (await sb.auth.getUser(t)).data?.user;
  return !!u?.email_confirmed_at && u.email?.toLowerCase() === (E.OWNER_EMAIL || '').toLowerCase();
}
const auth = async (q, r, n) => (await isOwner((q.headers.authorization || '').slice(7))) ? n() : fail(r, 403, 'Owner sign-in required.');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public', { index: false, maxAge: '1h' }));

app.get('/api/health', (q, r) => r.json({
  ok: true,
  service: 'mahiframe',
  setup: { supabase: Boolean(sb), storage: Boolean(hasCloudinary), publicConfig: Boolean(configured(E.SUPABASE_URL) && configured(E.SUPABASE_ANON_KEY)) }
}));

app.get('/api/config', (q, r) => r.json({ supabaseUrl: E.SUPABASE_URL, anonKey: E.SUPABASE_ANON_KEY }));

app.get('/api/public', async (q, r) => {
  if (!sb) return fail(r, 503, 'MahiFrame setup incomplete: add SUPABASE_SERVICE_KEY in the hosting environment.');
  const [p, v] = await Promise.all([
    sb.from('mf_profile').select('*').eq('id', 1).maybeSingle(),
    sb.from('mf_videos').select('id,title,description,category,width,height,duration,featured,created_at').eq('published', true).eq('status', 'ready').order('position')]);
  r.set('Cache-Control', 'public, max-age=30').json({ profile: p.data || {}, videos: v.data || [] });
});

// Cloudinary stores the uploaded original; delivery URLs do not request transformations.
async function media(q, r, col) {
  if (!sb || !hasCloudinary) return fail(r, 503, 'MahiFrame setup incomplete: configure Supabase and Cloudinary environment variables.');
  const v = await get(q.params.id);
  if (!v?.[col]) return r.sendStatus(404);
  const token = (q.headers.authorization || '').replace(/^Bearer\s+/i, '') || q.query.t;
  if (!(v.published && v.status === 'ready') && !(await isOwner(token))) return r.sendStatus(404);
  r.set('Cache-Control', 'public, max-age=300').redirect(302, col === 'original_key' ? videoUrl(v) : imageUrl(v.thumb_key));
}
app.get('/api/v/:id/file', (q, r) => media(q, r, 'original_key'));
app.get('/api/v/:id/thumb', (q, r) => media(q, r, 'thumb_key'));

const tpl = readFileSync('public/index.html', 'utf8');
async function page(q, r, v) {
  const p = sb ? ((await sb.from('mf_profile').select('*').eq('id', 1).maybeSingle()).data || {}) : {};
  const o = E.PUBLIC_URL || `${q.protocol}://${q.get('host')}`, n = p.name || 'MahiFrame';
  const t = v ? `${v.title} — ${n}` : `${n} — MahiFrame`, d = v?.description || p.bio || 'A personal video showcase.';
  const img = v?.thumb_key ? `${o}/api/v/${v.id}/thumb` : p.avatar_url || '';
  const m = (k, c, a = 'property') => `<meta ${a}="${k}" content="${esc(c)}">`;
  r.type('html').send(tpl.replace('<!--OG-->', `<title>${esc(t)}</title>` + m('description', d, 'name') + m('og:title', t) + m('og:description', d) + m('og:type', v ? 'video.other' : 'website') + m('og:url', o + (v ? '/v/' + v.id : '/')) + (img ? m('og:image', img) : '') + m('twitter:card', img ? 'summary_large_image' : 'summary')));
}
app.get('/', (q, r) => page(q, r, null));
app.get('/v/:id', async (q, r) => { const v = await get(q.params.id); page(q, r, v?.published && v.status === 'ready' ? v : null); });
app.get('/admin', (q, r) => r.sendFile('admin.html', { root: 'public' }));

// ---------- owner API ----------
const A = express.Router();
A.use((q, r, n) => {
  if (!sb) return fail(r, 503, 'MahiFrame setup incomplete: add SUPABASE_URL and SUPABASE_SERVICE_KEY in the hosting environment.');
  n();
});
A.use(auth);
const requireCloudinary = (q, r, n) => hasCloudinary ? n() : fail(r, 503, 'Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in Render Environment.');
A.get('/videos', async (q, r) => r.json({ videos: (await sb.from('mf_videos').select('*').order('position')).data || [] }));
A.get('/videos/:id/thumb-view-url', async (q, r) => {
  const v = await get(q.params.id);
  if (!v?.thumb_key) return fail(r, 404, 'No cover image.');
  r.json({ url: imageUrl(v.thumb_key) });
});

A.post('/upload/init', requireCloudinary, async (q, r) => {
  const { name, type, size, width, height, duration } = q.body;
  if (!TYPES[type]) return fail(r, 400, 'Unsupported video type. Use MP4, MOV or WebM.');
  if (!(Number.isFinite(Number(duration)) && Number(duration) >= 1 && Number(duration) <= 90)) return fail(r, 400, 'Videos must be between 1 and 90 seconds.');
  if (!(Number(size) > 0) || Number(size) > MAXMB * 1048576) return fail(r, 413, `Cloudinary Free upload limit is ${MAXMB} MB per video.`);
  const id = randomUUID(), publicId = `mahiframe/${id}`, timestamp = Math.floor(Date.now() / 1000);
  const last = (await sb.from('mf_videos').select('position').order('position', { ascending: false }).limit(1)).data?.[0]?.position ?? 0;
  const { error } = await sb.from('mf_videos').insert({
    id, title: String(name).replace(/\.[^.]+$/, '').slice(0, 120), original_name: String(name).slice(0, 255),
    mime: type, size: Number(size), width: width || null, height: height || null, duration: Number(duration),
    original_key: publicId, upload_id: null, position: last + 1, status: 'uploading'
  });
  if (error) return fail(r, 500, 'Could not create video record.');
  r.json({
    id, public_id: publicId, timestamp, signature: signUpload(publicId, timestamp),
    api_key: E.CLOUDINARY_API_KEY, cloud_name: E.CLOUDINARY_CLOUD_NAME,
    upload_url: `https://api.cloudinary.com/v1_1/${E.CLOUDINARY_CLOUD_NAME}/video/upload`
  });
});
A.post('/upload/complete', requireCloudinary, async (q, r) => {
  const v = await get(q.body.id);
  if (!v || v.status !== 'uploading' || q.body.public_id !== v.original_key) return fail(r, 404, 'No matching active upload.');
  try {
    const asset = await cloudinary.api.resource(v.original_key, { resource_type: 'video', type: 'upload' });
    if (Number(asset.bytes) !== Number(v.size)) {
      await cloudinary.uploader.destroy(v.original_key, { resource_type: 'video', type: 'upload', invalidate: true }).catch(() => {});
      await sb.from('mf_videos').delete().eq('id', v.id);
      return fail(r, 422, `Original integrity check failed: expected ${v.size} bytes, Cloudinary reports ${asset.bytes}. Upload discarded.`);
    }
    await sb.from('mf_videos').update({ status: 'ready', upload_id: null, storage_etag: String(asset.version || asset.etag || '') }).eq('id', v.id);
    r.json({ ok: true, bytes: asset.bytes, format: asset.format });
  } catch (e) {
    console.error('Cloudinary asset verification failed', e?.message || e);
    return fail(r, 502, 'Could not verify the uploaded asset with Cloudinary. Retry or remove the draft.');
  }
});
A.post('/upload/abort', requireCloudinary, async (q, r) => {
  const v = await get(q.body.id);
  if (v?.status === 'uploading') {
    await cloudinary.uploader.destroy(v.original_key, { resource_type: 'video', type: 'upload', invalidate: true }).catch(() => {});
    await sb.from('mf_videos').delete().eq('id', v.id);
  }
  r.json({ ok: true });
});
A.post('/videos/:id/thumb-url', requireCloudinary, async (q, r) => {
  const ext = IMG[q.body.type], v = await get(q.params.id);
  if (!ext || !v || v.status !== 'ready') return fail(r, 400, 'Use a JPEG, PNG or WebP image for a ready video.');
  const publicId = `mahiframe/thumbs/${v.id}-${randomUUID()}`, timestamp = Math.floor(Date.now() / 1000);
  r.json({
    public_id: publicId, timestamp, signature: signUpload(publicId, timestamp),
    api_key: E.CLOUDINARY_API_KEY, cloud_name: E.CLOUDINARY_CLOUD_NAME,
    upload_url: `https://api.cloudinary.com/v1_1/${E.CLOUDINARY_CLOUD_NAME}/image/upload`
  });
});
A.post('/videos/:id/thumb-complete', requireCloudinary, async (q, r) => {
  const v = await get(q.params.id), publicId = String(q.body.public_id || '');
  if (!v || v.status !== 'ready' || !publicId.startsWith(`mahiframe/thumbs/${v.id}-`)) return fail(r, 400, 'Invalid thumbnail upload.');
  try {
    const asset = await cloudinary.api.resource(publicId, { resource_type: 'image', type: 'upload' });
    if (Number(asset.bytes) !== Number(q.body.bytes)) return fail(r, 422, 'Thumbnail size verification failed.');
    const old = v.thumb_key;
    await sb.from('mf_videos').update({ thumb_key: publicId }).eq('id', v.id);
    if (old) await cloudinary.uploader.destroy(old, { resource_type: 'image', type: 'upload', invalidate: true }).catch(() => {});
    r.json({ ok: true, url: imageUrl(publicId) });
  } catch (e) {
    console.error('Cloudinary thumbnail verification failed', e?.message || e);
    return fail(r, 502, 'Could not verify the thumbnail with Cloudinary.');
  }
});
A.patch('/videos/:id', async (q, r) => {
  const u = { updated_at: new Date().toISOString() };
  for (const k of ['title', 'description', 'category']) if (k in q.body) u[k] = String(q.body[k]).slice(0, 2000);
  for (const k of ['published', 'featured']) if (k in q.body) u[k] = !!q.body[k];
  if (u.featured) await sb.from('mf_videos').update({ featured: false }).neq('id', q.params.id);
  const { error } = await sb.from('mf_videos').update(u).eq('id', q.params.id).eq('status', 'ready');
  error ? fail(r, 500, error.message) : r.json({ ok: true });
});
A.post('/reorder', async (q, r) => {
  await Promise.all((q.body.ids || []).map((id, i) => sb.from('mf_videos').update({ position: i + 1 }).eq('id', id)));
  r.json({ ok: true });
});
A.delete('/videos/:id', requireCloudinary, async (q, r) => {
  const v = await get(q.params.id);
  if (!v) return r.json({ ok: true });
  if (v.original_key) await cloudinary.uploader.destroy(v.original_key, { resource_type: 'video', type: 'upload', invalidate: true }).catch(() => {});
  if (v.thumb_key) await cloudinary.uploader.destroy(v.thumb_key, { resource_type: 'image', type: 'upload', invalidate: true }).catch(() => {});
  await sb.from('mf_videos').delete().eq('id', v.id);
  r.json({ ok: true });
});
A.put('/profile', async (q, r) => {
  const b = q.body, u = { id: 1, updated_at: new Date().toISOString(), verified: !!b.verified };
  for (const k of ['name', 'handle', 'bio', 'avatar_url', 'location']) u[k] = String(b[k] ?? '').slice(0, 600);
  u.socials = (b.socials || []).filter(s => /^https?:\/\//.test(s.url)).slice(0, 8).map(s => ({ label: String(s.label).slice(0, 30), url: s.url }));
  u.categories = (b.categories || []).map(c => String(c).trim().slice(0, 30)).filter(Boolean).slice(0, 12);
  const { error } = await sb.from('mf_profile').upsert(u);
  error ? fail(r, 500, error.message) : r.json({ ok: true });
});
app.use('/api/admin', A);

app.use((e, q, r, n) => { console.error(q.method, q.url, e); r.status(500).json({ error: 'Server error. Check the server logs.' }); });
app.listen(E.PORT || 3000, () => console.log('MahiFrame on :' + (E.PORT || 3000)));

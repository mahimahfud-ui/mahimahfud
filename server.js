import express from 'express';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@supabase/supabase-js';

const E = process.env, B = E.R2_BUCKET;
const s3 = new S3Client({ region: 'auto', endpoint: `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY } });
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const IMG = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAXMB = Number(E.MAX_UPLOAD_MB || 2048), PART = 16 * 1048576;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fail = (r, c, m) => r.status(c).json({ error: m });
const sign = (cmd, n = 3600) => getSignedUrl(s3, cmd, { expiresIn: n });
const get = async id => (await sb.from('mf_videos').select('*').eq('id', id).maybeSingle()).data;

async function isOwner(t) {
  if (!t) return false;
  const u = (await sb.auth.getUser(t)).data?.user;
  return !!u?.email_confirmed_at && u.email?.toLowerCase() === (E.OWNER_EMAIL || '').toLowerCase();
}
const auth = async (q, r, n) => (await isOwner((q.headers.authorization || '').slice(7))) ? n() : fail(r, 403, 'Owner sign-in required.');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public', { index: false, maxAge: '1h' }));

app.get('/api/config', (q, r) => r.json({ supabaseUrl: E.SUPABASE_URL, anonKey: E.SUPABASE_ANON_KEY }));

app.get('/api/public', async (q, r) => {
  const [p, v] = await Promise.all([
    sb.from('mf_profile').select('*').eq('id', 1).maybeSingle(),
    sb.from('mf_videos').select('id,title,description,category,width,height,duration,featured,created_at').eq('published', true).eq('status', 'ready').order('position')]);
  r.set('Cache-Control', 'public, max-age=30').json({ profile: p.data || {}, videos: v.data || [] });
});

// Private bucket: public viewers get a short-lived signed R2 link (supports Range/seek). Drafts need the owner token.
async function media(q, r, col) {
  const v = await get(q.params.id);
  if (!v?.[col]) return r.sendStatus(404);
  const token = (q.headers.authorization || '').replace(/^Bearer\\s+/i, '') || q.query.t;
  if (!(v.published && v.status === 'ready') && !(await isOwner(token))) return r.sendStatus(404);
  r.set('Cache-Control', 'private, max-age=300').redirect(302, await sign(new GetObjectCommand({ Bucket: B, Key: v[col] })));
}
app.get('/api/v/:id/file', (q, r) => media(q, r, 'original_key'));
app.get('/api/v/:id/thumb', (q, r) => media(q, r, 'thumb_key'));

const tpl = readFileSync('public/index.html', 'utf8');
async function page(q, r, v) {
  const p = (await sb.from('mf_profile').select('*').eq('id', 1).maybeSingle()).data || {};
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
A.use(auth);
A.get('/videos', async (q, r) => r.json({ videos: (await sb.from('mf_videos').select('*').order('position')).data || [] }));
A.get('/videos/:id/thumb-view-url', async (q, r) => {
  const v = await get(q.params.id);
  if (!v?.thumb_key) return fail(r, 404, 'No cover image.');
  r.json({ url: await sign(new GetObjectCommand({ Bucket: B, Key: v.thumb_key })) });
});

A.post('/upload/init', async (q, r) => {
  const { name, type, size, width, height, duration } = q.body, ext = TYPES[type];
  if (!ext) return fail(r, 400, 'Unsupported file type. Use MP4, MOV or WebM.');
  if (!(size > 0) || size > MAXMB * 1048576) return fail(r, 413, `File is larger than the ${MAXMB} MB limit.`);
  const id = randomUUID(), key = `originals/${id}.${ext}`;
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: B, Key: key, ContentType: type }));
  const last = (await sb.from('mf_videos').select('position').order('position', { ascending: false }).limit(1)).data?.[0]?.position ?? 0;
  const { error } = await sb.from('mf_videos').insert({ id, title: String(name).replace(/\.[^.]+$/, '').slice(0, 120), original_name: String(name).slice(0, 255), mime: type, size, width: width || null, height: height || null, duration: duration || null, original_key: key, upload_id: UploadId, position: last + 1 });
  if (error) { await s3.send(new AbortMultipartUploadCommand({ Bucket: B, Key: key, UploadId })).catch(() => {}); return fail(r, 500, error.message); }
  r.json({ id, partSize: PART });
});
A.post('/upload/part-url', async (q, r) => {
  const v = await get(q.body.id), n = +q.body.part;
  if (v?.status !== 'uploading' || !(n >= 1 && n <= 10000)) return fail(r, 404, 'No active upload.');
  r.json({ url: await sign(new UploadPartCommand({ Bucket: B, Key: v.original_key, UploadId: v.upload_id, PartNumber: n })) });
});
A.post('/upload/complete', async (q, r) => {
  const v = await get(q.body.id);
  if (v?.status !== 'uploading') return fail(r, 404, 'No active upload.');
  const Parts = (q.body.parts || []).map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag })).sort((a, b) => a.PartNumber - b.PartNumber);
  await s3.send(new CompleteMultipartUploadCommand({ Bucket: B, Key: v.original_key, UploadId: v.upload_id, MultipartUpload: { Parts } }));
  const h = await s3.send(new HeadObjectCommand({ Bucket: B, Key: v.original_key }));
  if (h.ContentLength !== Number(v.size)) {
    await s3.send(new DeleteObjectCommand({ Bucket: B, Key: v.original_key })); await sb.from('mf_videos').delete().eq('id', v.id);
    return fail(r, 422, `Integrity check failed: sent ${v.size} bytes, storage holds ${h.ContentLength}. The upload was discarded.`);
  }
  await sb.from('mf_videos').update({ status: 'ready', upload_id: null, storage_etag: h.ETag }).eq('id', v.id);
  r.json({ ok: true });
});
A.post('/upload/abort', async (q, r) => {
  const v = await get(q.body.id);
  if (v?.status === 'uploading') { await s3.send(new AbortMultipartUploadCommand({ Bucket: B, Key: v.original_key, UploadId: v.upload_id })).catch(() => {}); await sb.from('mf_videos').delete().eq('id', v.id); }
  r.json({ ok: true });
});
A.post('/videos/:id/thumb-url', async (q, r) => {
  const ext = IMG[q.body.type], v = await get(q.params.id);
  if (!ext || !v) return fail(r, 400, 'Use a JPEG, PNG or WebP image.');
  const old = v.thumb_key, key = `thumbs/${v.id}-${Date.now()}.${ext}`;
  await sb.from('mf_videos').update({ thumb_key: key }).eq('id', v.id);
  if (old) s3.send(new DeleteObjectCommand({ Bucket: B, Key: old })).catch(() => {});
  r.json({ url: await sign(new PutObjectCommand({ Bucket: B, Key: key, ContentType: q.body.type })) });
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
A.delete('/videos/:id', async (q, r) => {
  const v = await get(q.params.id);
  if (!v) return r.json({ ok: true });
  if (v.status === 'uploading') await s3.send(new AbortMultipartUploadCommand({ Bucket: B, Key: v.original_key, UploadId: v.upload_id })).catch(() => {});
  for (const Key of [v.original_key, v.thumb_key].filter(Boolean)) await s3.send(new DeleteObjectCommand({ Bucket: B, Key })).catch(() => {});
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

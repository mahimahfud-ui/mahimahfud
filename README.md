# MahiFrame

Video showcase. Originals go to a private Cloudflare R2 bucket byte-for-byte; a small Node API (Express) handles owner auth, signed multipart uploads and signed streaming links. Supabase holds only login and `mf_*` metadata tables (RLS on). Clips are limited to 1–90 seconds.

## Status
Written, not yet run against real R2/Supabase accounts. Nothing here has been tested end-to-end or deployed. Follow step 6 before trusting it.

## Setup
1. **R2** (Cloudflare dashboard → R2): create bucket `mahiframe` (keep it private, no public access). Create an API token with *Object Read & Write* on that bucket; copy the Account ID, Access Key ID and Secret.
2. **R2 CORS** (bucket → Settings → CORS policy), replace the origin with your real URL:
   `[{"AllowedOrigins":["https://YOUR-APP.onrender.com","http://localhost:3000"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]`
   Also add a lifecycle rule: *abort incomplete multipart uploads after 1 day*.
3. **Supabase** (existing project is fine; tables are `mf_*`, nothing else is touched): SQL Editor → run `sql/schema.sql`. Authentication → Users → add your owner user (email + password, confirmed). Copy the URL, anon key and service_role key. The service key is server-only. Only the email in `OWNER_EMAIL` gets owner rights, even if other users exist in the project.
4. **Config**: copy `.env.example` to `.env` and fill it in. Run locally with `npm install && npm run dev`, then open `/admin`.
5. **Deploy on Render**: use this repository (`mahimahfud-ui/mahimahfud`) to create a Node Web Service (build `npm install`, start `npm start`, region Singapore if available). Add every variable from `.env.example` in the service's Environment tab and set `PUBLIC_URL` to the final URL. Do not put `.env` or server keys in GitHub. If you already have a Render service for this repo, update that service rather than creating a duplicate. Put the final URL in your Instagram bio.
6. **Test before announcing**: upload a small clip, then a large 4K file; publish; open the link in a private window and on your phone; seek around; unpublish and confirm it disappears; refresh the page.

## Likely costs (check current pricing pages)
- Supabase: your existing project; no new cost.
- R2: has a free tier (about 10 GB storage, free egress), may require a payment method on file. Beyond the free tier, storage is billed per GB-month.
- Render: the free web service sleeps when idle, so the first visitor can wait about a minute. A paid instance avoids this. Lowest-cost path: free tier first, upgrade only if cold starts bother you.
- No domain is needed; the `onrender.com` URL works in Instagram.

## Behaviour to know
- Original uploads are never re-encoded. The thumbnail is a separate JPEG captured from one frame in your browser (or one you choose).
- No playback copy is generated. Visitors always get the original. H.265/HEVC `.mov` files from phones may not play in Chrome or Firefox; export H.264 MP4 if you need broad playback.
- Integrity check: after upload the API compares the stored byte size to your file's size. R2 also validates each part's checksum. A full-file hash is not computed.
- Unpublishing stops new access immediately, but a signed link already handed out can work for up to 1 hour.
- Parts upload one at a time with 4 attempts each; cancel aborts and cleans up the partial upload.

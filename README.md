# MahiFrame

A premium video showcase with a centered creator profile and a responsive gallery. Supabase Auth protects the owner dashboard and Supabase stores metadata in isolated `mf_*` tables. Cloudinary stores uploaded original videos and separate cover images.

## Free-plan limits

- The connected Cloudinary account currently reports the Free plan, 25 monthly credits, and 0 credits used at the time checked.
- This app caps each video at **100 MB** and each clip at **1–90 seconds**. Cloudinary's account limit reports 100 MB per video upload. Storage, delivery bandwidth, and transformations consume Cloudinary free-plan credits.
- Uploads are signed by the server and sent directly from the browser to Cloudinary. The original is uploaded without requested transformations; after upload the server checks the asset byte count against the selected file size.
- The gallery delivers the original video, not a separately transcoded playback variant. Some H.265/HEVC MOV files may not play in all browsers; H.264 MP4 is the most compatible choice.
- Cloudinary upload assets use public delivery URLs by default. Unpublishing removes a video from the gallery, but anyone with the direct Cloudinary URL may still access it. Do not upload confidential footage.

## Setup

1. **Supabase**: use the existing project configured for this app. The `mf_profile` and `mf_videos` tables already exist. In Authentication → Users, add an owner user with a confirmed email. Only the matching `OWNER_EMAIL` is allowed to administer the app.
2. **Cloudinary**: open the Cloudinary Console. Copy your Cloud Name and API Key from the dashboard and reveal/copy the API Secret from account settings. Never share or commit the API Secret.
3. **Render**: open the existing MahiFrame service and add these Environment variables:
   - `CLOUDINARY_CLOUD_NAME` — Cloudinary Cloud Name
   - `CLOUDINARY_API_KEY` — Cloudinary API Key
   - `CLOUDINARY_API_SECRET` — Cloudinary API Secret
   - `SUPABASE_SERVICE_KEY` — Supabase server-side secret key
   - `OWNER_EMAIL` — your confirmed Supabase owner email
   - Keep `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `PUBLIC_URL` as currently configured.
   - Set `MAX_UPLOAD_MB=100`.
   Save changes and deploy.
4. **Verify**: open `/api/health`. `setup.supabase`, `setup.storage`, and `setup.publicConfig` should all be `true`.
5. **Test**: open `/admin`, sign in, upload a 5–10 second MP4 under 50 MB, and confirm it appears in the public gallery. Test playback and seeking on another device.

## Deployment

The Render blueprint is in `render.yaml`. The public URL is `https://mahiframe-showcase.onrender.com`. Render's free service may sleep when idle, so the first request after sleep can be delayed.

## Security notes

- Never commit `.env`, Cloudinary API Secret, or Supabase service key to GitHub.
- The owner dashboard uses Supabase Auth; only the email configured in `OWNER_EMAIL` can administer uploads.
- Unpublishing hides a video from the catalogue but does not revoke a public Cloudinary delivery URL.
- Check Cloudinary Usage periodically before uploading a large batch. Free-plan credits are shared by storage, bandwidth, and transformations.

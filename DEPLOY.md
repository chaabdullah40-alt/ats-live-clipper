# DEPLOY.md — How to host ATS Live Clipper for free

## Why InfinityFree free will NOT run this

InfinityFree free hosting is **PHP + MySQL only**. Its own help pages say:

- Free hosting runs websites built with PHP and MySQL.
- Other server-side languages, such as Python, **Node.js**, Ruby, Java or Go,
  are **not available on free hosting**.
- Node.js is a premium feature, and free hosting is for pages humans load
  in a browser — it also blocks API-style hosting.

ATS Live Clipper is a **Node.js** app (server/index.js, api/index.js,
yt-dlp + ffmpeg for cutting). Uploading this code to InfinityFree free
will not run — there is no Node.js runtime there to execute it, and the
server-side API routes will return errors. Do not waste time uploading
it there.

If you must use InfinityFree, you would need a separate PHP rebuild of
the whole app. That is a different project, not this package.

## The free route that DOES work: Vercel (Hobby, free, no card)

Vercel's free Hobby plan runs Node.js serverless functions and static
files, which is exactly what this package needs.

### From a computer (easiest)

1. Create a free GitHub account at github.com (if you do not have one).
2. Create a new repository, e.g. `ats-live-clipper`, and push this folder:
   ```bash
   cd ats-live-clipper-code
   git init
   git add .
   git commit -m "ATS Live Clipper v1"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/ats-live-clipper.git
   git push -u origin main
   ```
   Do NOT commit a real `.env` file. `.gitignore` already excludes it.
3. Create a free Vercel account at vercel.com (sign in with GitHub).
4. Vercel → **Add New → Project** → Import your `ats-live-clipper` repo.
5. Framework Preset: **Other**. Build Command: leave empty.
   Output Directory: leave empty (the app serves `public/` itself).
6. **Environment Variables** — add these before Deploy:
   - `YOUTUBE_API_KEY` = your free YouTube Data API v3 key
   - `GEMINI_API_KEY` = your free Gemini key (optional; leave it out
     and the app falls back to chat + motion)
7. Click **Deploy**. Vercel gives you a free `https://ats-live-clipper-....vercel.app` link.
8. Open the link on your phone. Follow gate → paste a YouTube link → Analyze.

### From a phone (no computer)

1. Install the **GitHub** app and the **Vercel** app from the Play Store.
2. In the GitHub app, create a repo `ats-live-clipper`.
3. Upload this folder's files with the GitHub app / website (Upload files).
   Upload `package.json`, `vercel.json`, `server/`, `api/`, `public/`,
   `config/payments.json.example`, `.env.example`, `README.md`, `DEPLOY.md`.
   Do NOT upload a real `.env` or `config/payments.json` with real numbers.
4. In the Vercel app, **Add New → Project** → Import the repo.
5. Add the same Environment Variables as above, then Deploy.
6. Open the Vercel link on your phone and test one clip.

### After deploy

- **Test:** paste a short public YouTube VOD link, Analyze, cut a 15s clip,
  check captions and Download. If it fails, the clip shows the exact
  reason (e.g. yt-dlp blocked, no caption track).
- **Payments:** copy `config/payments.json.example` to
  `config/payments.json` in your repo, fill in your real Easypaisa /
  JazzCash / Binance details, redeploy. Never share that file publicly.
- **Limits on Vercel free:** serverless functions have a max duration
  (Hobby: 60s in `vercel.json` here, Vercel may enforce its own Hobby
  limit). Short clips (15–60s) are reliable. A 90s Full HD render can
  time out on Hobby. For long renders, run `npm start` on your own
  computer/VPS where `yt-dlp` + `ffmpeg` are installed, or upgrade Vercel.
- **YouTube API quota:** the free YouTube Data API key has a daily quota.
  If Analyze starts failing with a quota error, wait for the next day or
  create a second Google Cloud project key.
- **Gemini quota:** free Gemini keys have a daily quota. HTTP 429 means
  quota exceeded — the app falls back and says so. Wait or use a new key.

## Local run (for testing)

```bash
cp .env.example .env
# edit .env with your keys
npm install
npm start
# http://localhost:3000
```

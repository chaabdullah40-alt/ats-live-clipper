# ATS Live Clipper

**Paste Stream → Find Best Moments → Create Clips → Edit → Export**

ATS Live Clipper is a professional, mobile-first AI clipping studio. Paste a
YouTube live or VOD link, it finds the best moments from live chat spikes,
chat replay, comments and visual action, then cuts Full HD 1080p vertical
clips (9:16, 4:5, 1:1, 16:9) with large, bold, colorful word-by-word captions
burned in, and lets you download the MP4 to your phone gallery.

## Features

- **Follow gate (first open):** Telegram @fake_number_ahtisham_otp and
  WhatsApp channel, with an **I FOLLOWED** button.
- **Theme:** Yellow `#f7b500` and white, professional, mobile-first, simple use.
- **YouTube Data API v3 (server-side only):** real title, channel, thumbnail,
  duration, views, likes, comments, live/finished status. Key comes from
  env `YOUTUBE_API_KEY` — never in client code.
- **Chat-spike + action-peak detection:** live chat polling, VOD chat replay
  where available, comments fallback, motion scan fallback. Candidates show
  timecode, spike score and hype reason. Labels: `REAL CHAT LIVE` /
  `REAL CHAT REPLAY` / `REAL COMMENTS` / `ESTIMATED` / `ACTION PEAK`.
- **Split layout:** game on top, facecam alone on bottom full width, no game
  bleed in the bottom half, thin yellow divider. Facecam auto-detect samples
  10 frames, plus manual override per clip (Auto / Split / Full + Left/Top/
  Width/Height % form).
- **Captions:** large, bold, colorful word-by-word captions centered, burned
  into the MP4, plus SRT download.
- **Manual Clip mode:** start time like `12:34` or `1:00:00` + seconds to cut.
- **Gemini AI scene analysis:** server-side only, key from env
  `GEMINI_API_KEY`. If quota is exceeded (HTTP 429) the app shows a clear
  message and falls back to chat + motion. No key is in this code.
- **Video cutting:** server route using `yt-dlp` + `ffmpeg`, background job
  with progress in English (percent + elapsed timer), auto-download when
  ready, Download MP4 + SRT buttons per clip, post-download popup to join
  WhatsApp and Telegram channels.
- **Free / Premium:** Free 10 clips/day, Premium 100+/day, Premium
  499 PKR/month. Payment accounts are **not** hard-coded — edit
  `config/payments.json` (copy from `config/payments.json.example`).
- **No login, no database required** for core use.

## Quick start (computer)

```bash
cp .env.example .env
# Edit .env and put your own YOUTUBE_API_KEY (and GEMINI_API_KEY if you want it)
npm install
npm start
# Open http://localhost:3000
```

You need `yt-dlp` and `ffmpeg` installed on the machine that cuts videos.
On Ubuntu/Debian: `sudo apt install ffmpeg` and
`pip install -U yt-dlp` (or download the yt-dlp binary). On Vercel, long
video renders may hit the serverless time limit — see DEPLOY.md.

## Quick start (phone — Vercel, free)

See **DEPLOY.md** for the exact free Vercel steps from phone and computer.
Short version: push this folder to GitHub, import it in Vercel, add
`YOUTUBE_API_KEY` (and `GEMINI_API_KEY`) in Vercel → Settings →
Environment Variables, Deploy. No card is needed for Vercel's free Hobby plan.

## Files

```
package.json          Node, zero dependencies, "npm start" runs server/index.js
vercel.json           Vercel routing: /api/* -> api/index.js, rest -> public/
server/app.js         All API + static serving (YouTube, chat, Gemini, render)
server/index.js       Local server entry point
api/index.js          Vercel serverless entry point
public/index.html     App page (follow gate, clipper, premium)
public/app.js         Client logic
public/style.css      Yellow #f7b500 + white, mobile-first
public/logo.jpg       ATS Live Clipper logo
config/payments.json.example  Payment placeholders — copy to payments.json and edit
.env.example          Env placeholders only — never commit a real .env
README.md             This file
DEPLOY.md             Deploy guide + why InfinityFree free will NOT run this
```

## Honest limits

- Facecam auto-detection is a heuristic. It samples 10 frames and looks for
  a stable corner inset. It misses sometimes, especially on live streams.
  When it misses, the clip uses Full layout and the reason is shown, and you
  can set the facecam box manually.
- Gemini returns HTTP 429 when its free quota is exceeded. The app then
  falls back to chat + motion and says so clearly.
- YouTube may block some videos (private, age-restricted, bot-blocked).
  Those clips fail with a reason and a Retry button — never silently.
- Only clip streams you own or are authorized to clip. No tool can
  guarantee a clip is copyright-claim-free.
- Vercel Hobby serverless functions have a time limit (see DEPLOY.md).
  Long renders work best on a machine you control, or with a background
  worker. Short 15–60s clips are the reliable path on Vercel free.

## Security

- API keys live only in env vars. They never appear in client code, in
  responses, or in this repo.
- Payment numbers are never hard-coded. Edit `config/payments.json`
  yourself and do not commit it with real numbers.

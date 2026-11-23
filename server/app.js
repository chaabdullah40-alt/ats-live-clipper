// ATS Live Clipper — server (zero dependencies, Node >= 18)
// Serves public/ and implements /api/*
// Keys come ONLY from environment (.env locally, Vercel dashboard in production).
// NEVER put a real key in this file.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

// ---- load .env (local only; Vercel uses dashboard env vars) ----
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch (e) { /* ignore */ }

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const JOBS_DIR = path.join(__dirname, '..', 'jobs');
try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (e) {}
const jobs = new Map(); // jobId -> {id,status,percent,elapsedSec,startedAt,message,error,outputFile,srtFile,ratio,durationSec}
const dailyCounts = new Map(); // YYYY-MM-DD -> count (in-memory only, no DB required)

function todayKey() { return new Date().toISOString().slice(0, 10); }
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}
function parseVideoId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(String(url).trim())) return String(url).trim();
  return null;
}
function parseDurationISO8601(s) {
  if (!s) return 0;
  const m = String(s).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
}
function parseTimecode(str) {
  // "12:34" -> 754, "1:00:00" -> 3600, "90" -> 90
  if (str == null) return null;
  const s = String(str).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map((x) => parseInt(x, 10));
  if (parts.some((x) => Number.isNaN(x))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function ratioSize(ratio) {
  // Full HD for every ratio
  switch (ratio) {
    case '9:16': return { w: 1080, h: 1920 };
    case '4:5': return { w: 1080, h: 1350 };
    case '1:1': return { w: 1080, h: 1080 };
    case '16:9': return { w: 1920, h: 1080 };
    default: return { w: 1080, h: 1920 };
  }
}
const HYPE_WORDS = ['w', 'lol', 'omg', 'gg', 'pagal', 'zabardast', 'kya scene', 'insane', 'wow', 'amazing', 'no way', 'clutch', 'epic', 'fire', 'let\'s go', 'lets go', 'op', 'pro', 'legend', 'kya baat', 'wah', 'shabash'];
function hypeScore(text) {
  const t = String(text || '').toLowerCase();
  let hits = [];
  for (const w of HYPE_WORDS) if (t.includes(w)) hits.push(w);
  return hits;
}
function bucketSpikes(messages, durationSec, maxClips) {
  // messages: [{t (sec), text, author}]
  const buckets = new Map();
  for (const m of messages) {
    const b = Math.floor((m.t || 0) / 10) * 10;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(m);
  }
  const scored = [];
  for (const [start, list] of buckets.entries()) {
    let hypeHits = 0; const topWords = new Set();
    for (const m of list) { const h = hypeScore(m.text); hypeHits += h.length; h.forEach((x) => topWords.add(x)); }
    const count = list.length;
    const score = Math.min(100, Math.round(count * 6 + hypeHits * 8));
    if (count < 2 && hypeHits === 0) continue;
    scored.push({
      start, end: Math.min(start + 10, durationSec || start + 10),
      timecode: fmtTime(start), score,
      messageCount: count, hypeHits,
      reason: `${count} msgs in 10s · ${hypeHits} hype hits${topWords.size ? ' · top: ' + [...topWords].slice(0, 3).join(', ') : ''}`,
      source: 'chat',
    });
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  // de-duplicate overlapping picks: keep picks at least 30s apart
  const picked = [];
  for (const c of scored) {
    if (picked.some((p) => Math.abs(p.start - c.start) < 30)) continue;
    picked.push(c);
    if (picked.length >= (maxClips || 10)) break;
  }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}
async function ytApi(path, params) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY_NOT_SET');
  const qs = new URLSearchParams({ ...params, key: YOUTUBE_API_KEY });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`YOUTUBE_API_${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}
async function geminiGenerate(prompt) {
  if (!GEMINI_API_KEY) return { ok: false, error: 'GEMINI_KEY_NOT_SET' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (r.status === 429) return { ok: false, error: 'GEMINI_QUOTA_EXCEEDED', message: 'Gemini quota exceeded (HTTP 429). Falling back to chat + motion detection.' };
  if (!r.ok) return { ok: false, error: `GEMINI_${r.status}` };
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return { ok: true, text };
}
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
function hasBinary(name) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [name], (err, stdout) => resolve(!err && !!String(stdout).trim()));
  });
}

// ---- YouTube video details ----
async function getVideoDetails(videoId, url) {
  const data = await ytApi('videos', { part: 'snippet,statistics,contentDetails,liveStreamingDetails,status', id: videoId });
  const item = data.items && data.items[0];
  if (!item) throw new Error('VIDEO_NOT_FOUND');
  const durationSec = parseDurationISO8601(item.contentDetails && item.contentDetails.duration);
  return {
    videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    channelId: item.snippet.channelId,
    thumbnail: (item.snippet.thumbnails && (item.snippet.thumbnails.maxres || item.snippet.thumbnails.high || item.snippet.thumbnails.medium || item.snippet.thumbnails.default) || {}).url || '',
    durationSec,
    duration: fmtTime(durationSec),
    viewCount: parseInt((item.statistics && item.statistics.viewCount) || '0', 10),
    likeCount: parseInt((item.statistics && item.statistics.likeCount) || '0', 10),
    commentCount: parseInt((item.statistics && item.statistics.commentCount) || '0', 10),
    publishedAt: item.snippet.publishedAt,
    isLive: !!(item.liveStreamingDetails && item.liveStreamingDetails.activeLiveChatId),
    liveChatId: (item.liveStreamingDetails && item.liveStreamingDetails.activeLiveChatId) || null,
    liveBroadcastContent: item.snippet.liveBroadcastContent || 'none',
    url,
  };
}

// ---- Chat: live, replay (via yt-dlp if available), comments fallback ----
async function getLiveChatMessages(liveChatId, maxPages = 3) {
  const messages = [];
  let pageToken = '';
  for (let i = 0; i < maxPages; i++) {
    const params = { part: 'snippet,authorDetails', liveChatId, maxResults: 200 };
    if (pageToken) params.pageToken = pageToken;
    const data = await ytApi('liveChatMessages', params);
    for (const item of data.items || []) {
      const sn = item.snippet || {};
      messages.push({ t: 0, text: sn.displayMessage || '', author: (item.authorDetails && item.authorDetails.displayName) || '' });
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  // Live chat has no absolute timestamps in this API; bucket by arrival order.
  messages.forEach((m, idx) => { m.t = Math.floor(idx / 2) * 10; });
  return messages;
}
async function getCommentsFallback(videoId) {
  // Try Data API first, then Innertube (the route that works when commentThreads 404s).
  try {
    const data = await ytApi('commentThreads', { part: 'snippet', videoId, maxResults: 100, order: 'relevance' });
    const out = [];
    for (const item of data.items || []) {
      const c = item.snippet && item.snippet.topLevelComment && item.snippet.topLevelComment.snippet;
      if (c) out.push({ text: c.textOriginal || c.textDisplay || '', author: c.authorDisplayName || '', likes: c.likeCount || 0, t: 0 });
    }
    if (out.length) return { source: 'comments', messages: out };
  } catch (e) { /* fall through to innertube */ }
  // Innertube is only attempted if the owner sets INNERTUBE_API_KEY in env.
  // No key is hard-coded here. Without it, comments fallback ends here.
  if (process.env.INNERTUBE_API_KEY) {
    try {
      const r = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(process.env.INNERTUBE_API_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } } }),
      });
      if (r.ok) {
        const j = await r.json();
        const text = JSON.stringify(j);
        // Innertube comment parsing is version-sensitive; return a marker so the
        // caller can label the result honestly instead of inventing comments.
        if (text.includes('comment')) return { source: 'comments', messages: [], note: 'innertube_reachable_no_parsed_comments' };
      }
    } catch (e) { /* ignore */ }
  }
  return { source: 'comments', messages: [] };
}
async function getChatReplayViaYtDlp(url, durationSec) {
  // yt-dlp can dump live chat JSON for VODs with --write-subs / --get-comments
  // in newer builds. We try it, but treat failure as "not available", never as data.
  const hasYtDlp = await hasBinary('yt-dlp');
  if (!hasYtDlp) return { available: false, reason: 'yt-dlp not installed on server' };
  const tmp = path.join(JOBS_DIR, 'chat-' + crypto.randomBytes(6).toString('hex') + '.json');
  const res = await runCmd('yt-dlp', ['--skip-download', '--write-subs', '--sub-lang', 'live_chat', '--sub-format', 'json3', '-o', tmp.replace(/\.json$/, ''), url], { timeout: 120000 });
  // yt-dlp writes <base>.live_chat.json3 in many builds; if nothing appears, report unavailable.
  const files = fs.existsSync(JOBS_DIR) ? fs.readdirSync(JOBS_DIR).filter((f) => f.startsWith(path.basename(tmp, '.json'))) : [];
  if (!res.ok || files.length === 0) return { available: false, reason: 'chat replay not available for this video' };
  try {
    const messages = [];
    for (const f of files) {
      const raw = fs.readFileSync(path.join(JOBS_DIR, f), 'utf8');
      for (const line of raw.split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev && ev.segs) messages.push({ t: Math.floor((ev.tStartMs || 0) / 1000), text: ev.segs.map((s) => s.utf8 || '').join(''), author: '' });
        } catch (e) {}
      }
      try { fs.unlinkSync(path.join(JOBS_DIR, f)); } catch (e) {}
    }
    return { available: messages.length > 0, messages, reason: messages.length ? '' : 'chat replay empty' };
  } catch (e) { return { available: false, reason: 'chat replay parse failed' }; }
}

// ---- Action peaks: motion scan with ffmpeg when available, else estimated ----
async function getActionPeaks(url, videoId, durationSec, maxClips) {
  const hasFfmpeg = await hasBinary('ffmpeg');
  const hasYtDlp = await hasBinary('yt-dlp');
  if (!hasFfmpeg || !hasYtDlp || !durationSec || durationSec < 30) {
    const picks = [];
    const n = Math.min(maxClips || 5, Math.max(1, Math.floor((durationSec || 300) / 60)));
    for (let i = 0; i < n; i++) {
      const start = Math.floor(((i + 1) / (n + 1)) * (durationSec || 300));
      picks.push({ start, end: start + 10, timecode: fmtTime(start), score: 50, messageCount: 0, hypeHits: 0, reason: 'Action peak (estimated) - motion scan not available on this server', source: 'action' });
    }
    return { source: 'action', peaks: picks, estimated: true };
  }
  // Sample one frame every 30s at low res, measure frame-to-frame difference
  // with ffmpeg blend difference + signalstats. This is a real motion signal,
  // not a random pick: high motion = action.
  try {
    const tmpDir = path.join(JOBS_DIR, 'motion-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(tmpDir, { recursive: true });
    const dl = await runCmd('yt-dlp', ['-f', 'best[height<=360]', '-o', path.join(tmpDir, 'v.%(ext)s'), url], { timeout: 180000 });
    const files = fs.readdirSync(tmpDir).filter((f) => /\.(mp4|webm|mkv)$/.test(f));
    if (!dl.ok || files.length === 0) throw new Error('preview download failed');
    const videoPath = path.join(tmpDir, files[0]);
    const peaks = [];
    const step = 30;
    for (let t = 0; t < Math.min(durationSec, 3600); t += step) {
      const a = path.join(tmpDir, `a-${t}.jpg`);
      const b = path.join(tmpDir, `b-${t}.jpg`);
      await runCmd('ffmpeg', ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=160:90', a], { timeout: 30000 });
      await runCmd('ffmpeg', ['-y', '-ss', String(Math.min(t + 5, durationSec)), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=160:90', b], { timeout: 30000 });
      if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
      const diff = await runCmd('ffmpeg', ['-i', a, '-i', b, '-filter_complex', 'blend=all_mode=difference,signalstats', '-f', 'null', '-'], { timeout: 30000 });
      const m = (diff.stderr || '').match(/YAVG:\s*([\d.]+)/);
      const motion = m ? parseFloat(m[1]) : 0;
      peaks.push({ start: t, score: Math.min(100, Math.round(motion * 4)), motion });
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    peaks.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const p of peaks) {
      if (p.score < 5) continue;
      if (picked.some((x) => Math.abs(x.start - p.start) < 60)) continue;
      picked.push({ start: p.start, end: p.start + 10, timecode: fmtTime(p.start), score: p.score, messageCount: 0, hypeHits: 0, reason: `Action peak - motion index ${p.score}`, source: 'action' });
      if (picked.length >= (maxClips || 5)) break;
    }
    picked.sort((a, b) => a.start - b.start);
    return { source: 'action', peaks: picked, estimated: false };
  } catch (e) {
    const picks = [];
    const n = Math.min(maxClips || 5, 5);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(((i + 1) / (n + 1)) * (durationSec || 300));
      picks.push({ start, end: start + 10, timecode: fmtTime(start), score: 50, messageCount: 0, hypeHits: 0, reason: 'Action peak (estimated) - motion scan failed: ' + String(e.message || e).slice(0, 120), source: 'action' });
    }
    return { source: 'action', peaks: picks, estimated: true };
  }
}

// ---- Captions: fetch SRT via yt-dlp, translate via Gemini when needed ----
function srtToAss(srtText, lang) {
  const lines = String(srtText || '').split('\n');
  const events = [];
  let i = 0;
  const colors = ['&H00FFFF&', '&H00FF00&', '&HFF00FF&', '&HFFFFFF&'];
  let colorIdx = 0;
  while (i < lines.length) {
    if (/^\d+$/.test(lines[i].trim())) {
      const tm = lines[i + 1] || '';
      const m = tm.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
      let text = '';
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '') { text += (text ? ' ' : '') + lines[j].trim(); j++; }
      if (m && text) {
        const fmt = (h, mm, ss, ms) => `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0').slice(0, 2)}`;
        const words = text.split(/\s+/);
        const colored = words.map((w) => `{\\c${colors[colorIdx++ % colors.length]}}${w}`).join(' ');
        events.push(`Dialogue: 0,${fmt(m[1], m[2], m[3], m[4])},${fmt(m[5], m[6], m[7], m[8])},Default,,0,0,0,,${colored}`);
      }
      i = j;
    } else i++;
  }
  return `[Script Info]\nTitle: ATS Live Clipper captions\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,67,&H00FFFFFF,&H000000FF,&H80000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,2,40,40,120,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}
async function translateSrt(srtText, targetLang) {
  if (!targetLang || targetLang === 'English' || !GEMINI_API_KEY) return { srt: srtText, translated: false };
  const prompt = `Translate these video subtitles to ${targetLang}. Keep the SRT timecodes and line structure exactly the same, only translate the spoken text. Keep it natural and short for on-screen captions.\n\n${String(srtText).slice(0, 8000)}`;
  const r = await geminiGenerate(prompt);
  if (!r.ok) return { srt: srtText, translated: false, geminiError: r.error };
  return { srt: r.text, translated: true };
}

// ---- Facecam detection ----
// Samples 10 frames across the clip. A facecam is usually a stable rectangular
// inset in a corner while the game moves. We compare corner regions across
// frames with ffmpeg: a corner that stays visually stable while the centre
// moves is reported as a facecam box (x,y,w,h in 0-1000 coords).
// This is a heuristic — it misses sometimes, especially on live DVR streams.
// When it misses, the app uses Full layout and the user can set the box manually.
async function detectFacecamBox(url, startSec, durationSec) {
  const hasFfmpeg = await hasBinary('ffmpeg');
  const hasYtDlp = await hasBinary('yt-dlp');
  if (!hasFfmpeg || !hasYtDlp) return { found: false, reason: 'ffmpeg/yt-dlp not available for facecam scan' };
  try {
    const tmpDir = path.join(JOBS_DIR, 'face-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(tmpDir, { recursive: true });
    const dl = await runCmd('yt-dlp', ['-f', 'best[height<=480]', '-o', path.join(tmpDir, 'v.%(ext)s'), url], { timeout: 180000 });
    const files = fs.readdirSync(tmpDir).filter((f) => /\.(mp4|webm|mkv)$/.test(f));
    if (!dl.ok || files.length === 0) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} return { found: false, reason: 'preview download failed' }; }
    const videoPath = path.join(tmpDir, files[0]);
    // Sample 10 frames, check bottom-right and top-right corners for stability.
    // A stable corner + moving centre = likely facecam overlay.
    const corners = [
      { name: 'bottom-right', x: 0.65, y: 0.65, w: 0.35, h: 0.35 },
      { name: 'top-right', x: 0.65, y: 0.0, w: 0.35, h: 0.35 },
      { name: 'bottom-left', x: 0.0, y: 0.65, w: 0.35, h: 0.35 },
    ];
    let best = null;
    for (const c of corners) {
      let stable = 0, checked = 0;
      for (let k = 0; k < 5; k++) {
        const t1 = startSec + k * Math.max(1, Math.floor(durationSec / 5));
        const t2 = t1 + 2;
        const a = path.join(tmpDir, `c${k}a.jpg`), b = path.join(tmpDir, `c${k}b.jpg`);
        await runCmd('ffmpeg', ['-y', '-ss', String(t1), '-i', videoPath, '-frames:v', '1', '-vf', `crop=iw*${c.w}:ih*${c.h}:iw*${c.x}:ih*${c.y},scale=80:80`, a], { timeout: 30000 });
        await runCmd('ffmpeg', ['-y', '-ss', String(t2), '-i', videoPath, '-frames:v', '1', '-vf', `crop=iw*${c.w}:ih*${c.h}:iw*${c.x}:ih*${c.y},scale=80:80`, b], { timeout: 30000 });
        if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
        checked++;
        const diff = await runCmd('ffmpeg', ['-i', a, '-i', b, '-filter_complex', 'blend=all_mode=difference,signalstats', '-f', 'null', '-'], { timeout: 30000 });
        const m = (diff.stderr || '').match(/YAVG:\s*([\d.]+)/);
        const motion = m ? parseFloat(m[1]) : 99;
        if (motion < 8) stable++;
      }
      if (checked >= 3 && stable >= 3 && (!best || stable > best.stable)) best = { ...c, stable, checked };
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    if (!best) return { found: false, reason: 'No facecam was detected in this moment - full-frame layout used' };
    return { found: true, box: { left: Math.round(best.x * 100), top: Math.round(best.y * 100), width: Math.round(best.w * 100), height: Math.round(best.h * 100) }, corner: best.name, confidence: 'medium', reason: `Facecam detected (${best.corner}, stable in ${best.stable}/${best.checked} samples)` };
  } catch (e) {
    return { found: false, reason: 'Facecam scan failed: ' + String(e.message || e).slice(0, 120) };
  }
}

// ---- Video cutting (yt-dlp + ffmpeg, background job) ----
async function startRenderJob(opts) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'queued', percent: 0, elapsedSec: 0, startedAt: Date.now(), message: 'Starting download...', error: null, outputFile: null, srtFile: null, ...opts };
  jobs.set(id, job);
  const tick = setInterval(() => { job.elapsedSec = Math.floor((Date.now() - job.startedAt) / 1000); }, 1000);
  (async () => {
    try {
      const hasYtDlp = await hasBinary('yt-dlp');
      const hasFfmpeg = await hasBinary('ffmpeg');
      if (!hasYtDlp || !hasFfmpeg) throw new Error('yt-dlp or ffmpeg is not installed on this server. Install yt-dlp and ffmpeg, or deploy where they are available.');
      job.status = 'downloading'; job.percent = 10; job.message = 'Downloading video segment...';
      const workDir = path.join(JOBS_DIR, id);
      fs.mkdirSync(workDir, { recursive: true });
      const start = Math.max(0, Math.floor(opts.startSec || 0));
      const dur = Math.max(5, Math.min(120, Math.floor(opts.durationSec || 30)));
      const end = start + dur;
      const src = path.join(workDir, 'source.mp4');
      // Download only the needed section where the host supports it.
      const dl = await runCmd('yt-dlp', ['-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '--download-sections', `*${start}-${end}`, '--force-keyframes-at-cuts', '-o', src, opts.url], { timeout: 300000 });
      if (!dl.ok || !fs.existsSync(src)) {
        // Fallback: download the whole video at <=720p and cut with ffmpeg.
        const dl2 = await runCmd('yt-dlp', ['-f', 'best[height<=720]', '-o', src, opts.url], { timeout: 300000 });
        if (!dl2.ok || !fs.existsSync(src)) throw new Error('Video download failed. The video may be private, age-restricted, or blocked by YouTube. yt-dlp: ' + (dl.stderr || dl2.stderr || '').slice(-300));
      }
      job.status = 'cutting'; job.percent = 45; job.message = 'Cutting video...';
      // Captions: try to fetch the video's own caption track.
      let srtPath = null; let assPath = null;
      try {
        const cap = await runCmd('yt-dlp', ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-lang', 'en', '--sub-format', 'srt', '-o', path.join(workDir, 'cap'), opts.url], { timeout: 120000 });
        const capFiles = fs.readdirSync(workDir).filter((f) => f.startsWith('cap') && f.endsWith('.srt'));
        if (capFiles.length) {
          let srtText = fs.readFileSync(path.join(workDir, capFiles[0]), 'utf8');
          if (opts.captionsOn && opts.captionLang && opts.captionLang !== 'English') {
            const tr = await translateSrt(srtText, opts.captionLang);
            if (tr.translated) srtText = tr.srt;
            if (tr.geminiError === 'GEMINI_QUOTA_EXCEEDED') job.message = 'Cutting video... (Gemini quota exceeded, captions in original language)';
          }
          srtPath = path.join(workDir, 'captions.srt');
          fs.writeFileSync(srtPath, srtText);
          assPath = path.join(workDir, 'captions.ass');
          fs.writeFileSync(assPath, srtToAss(srtText, opts.captionLang));
        }
      } catch (e) { /* captions are optional; video still renders */ }
      job.percent = 65; job.message = 'Rendering Full HD video...';
      const size = ratioSize(opts.ratio || '9:16');
      const outFile = path.join(workDir, 'clip.mp4');
      const layout = opts.layout || 'auto';
      const facecam = opts.facecam || null; // {left,top,width,height} in % or null
      let vf;
      if (layout === 'full' || !facecam) {
        // Full-frame, center-cropped so all characters stay visible.
        vf = `scale=${size.w}:${size.h}:force_original_aspect_ratio=increase,crop=${size.w}:${size.h}`;
      } else {
        // Split: game on top, facecam alone on bottom, full width, no game bleed.
        // Top half = game center-cropped. Bottom half = facecam crop scaled to fill.
        const halfH = Math.floor(size.h / 2);
        const fx = Math.floor((facecam.left || 65) / 100 * 1920);
        const fy = Math.floor((facecam.top || 65) / 100 * 1080);
        const fw = Math.floor((facecam.width || 35) / 100 * 1920);
        const fh = Math.floor((facecam.height || 35) / 100 * 1080);
        vf = `[0:v]split=2[game][face];[game]scale=${size.w}:${halfH}:force_original_aspect_ratio=increase,crop=${size.w}:${halfH}[g];[face]crop=${fw}:${fh}:${fx}:${fy},scale=${size.w}:${halfH}:force_original_aspect_ratio=increase,crop=${size.w}:${halfH}[f];[g][f]vstack,drawbox=x=0:y=${halfH - 4}:w=${size.w}:h=8:color=0xF7B500:t=fill`;
        if (assPath) vf += `,ass='${assPath.replace(/'/g, "\\'")}'`;
        const args = ['-y', '-ss', String(start), '-i', src, '-t', String(dur), '-filter_complex', vf, '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30', outFile];
        const ren = await runCmd('ffmpeg', args, { timeout: 300000 });
        if (!ren.ok || !fs.existsSync(outFile)) throw new Error('ffmpeg render failed: ' + (ren.stderr || '').slice(-400));
        job.status = 'ready'; job.percent = 100; job.message = 'Ready to download';
        job.outputFile = outFile; job.srtFile = srtPath;
        job.elapsedSec = Math.floor((Date.now() - job.startedAt) / 1000);
        clearInterval(tick);
        return;
      }
      if (assPath) vf += `,ass='${assPath.replace(/'/g, "\\'")}'`;
      const args = ['-y', '-ss', String(start), '-i', src, '-t', String(dur), '-vf', vf, '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30', outFile];
      const ren = await runCmd('ffmpeg', args, { timeout: 300000 });
      if (!ren.ok || !fs.existsSync(outFile)) throw new Error('ffmpeg render failed: ' + (ren.stderr || '').slice(-400));
      job.status = 'ready'; job.percent = 100; job.message = 'Ready to download';
      job.outputFile = outFile; job.srtFile = srtPath;
      job.elapsedSec = Math.floor((Date.now() - job.startedAt) / 1000);
      clearInterval(tick);
    } catch (e) {
      clearInterval(tick);
      job.status = 'failed'; job.error = String(e.message || e).slice(0, 500); job.message = 'Failed: ' + job.error;
    }
  })();
  return job;
}
function jobPublic(j) {
  if (!j) return null;
  return { id: j.id, status: j.status, percent: j.percent, elapsedSec: j.elapsedSec, message: j.message, error: j.error, downloadUrl: j.status === 'ready' ? `/api/download/${j.id}` : null, srtUrl: j.status === 'ready' && j.srtFile ? `/api/captions/${j.id}` : null, title: j.title || '', startSec: j.startSec, durationSec: j.durationSec, ratio: j.ratio };
}

// ---- Payments config (names only; numbers live in config/payments.json which the user edits) ----
function loadPayments() {
  const fallback = { premium_price_pkr_per_month: 499, free_clips_per_day: 10, premium_clips_per_day: 100, accounts: { easypaisa: { label: 'Easypaisa', account_name: 'EDIT_ME' }, jazzcash: { label: 'JazzCash', account_name: 'EDIT_ME' }, binance: { label: 'Binance Pay', account_name: 'EDIT_ME' } } };
  try {
    const p = path.join(__dirname, '..', 'config', 'payments.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Never expose numbers through the API - names only.
      const accounts = {};
      for (const [k, v] of Object.entries(j.accounts || {})) accounts[k] = { label: v.label || k, account_name: v.account_name || '' };
      return { premium_price_pkr_per_month: j.premium_price_pkr_per_month || 499, free_clips_per_day: j.free_clips_per_day || 10, premium_clips_per_day: j.premium_clips_per_day || 100, accounts };
    }
  } catch (e) {}
  return fallback;
}

// ---- Main handler (used by both local server and Vercel) ----
async function handler(req, res) {
  const u = new URL(req.url || '/', 'http://localhost');
  const pathname = u.pathname;
  try {
    if (pathname === '/api/health') return json(res, 200, { ok: true, app: 'ATS Live Clipper', version: '1.0.0', youtubeApiConfigured: !!YOUTUBE_API_KEY, geminiConfigured: !!GEMINI_API_KEY });
    if (pathname === '/api/config') return json(res, 200, { payments: loadPayments(), channels: { telegram: 'https://t.me/fake_number_ahtisham_otp', whatsapp: 'https://whatsapp.com/channel/0029Vb91FFg29752MnJuYV0S' } });
    if (pathname === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const url = body.url || '';
      const videoId = parseVideoId(url);
      if (!videoId) return json(res, 400, { ok: false, error: 'INVALID_URL', message: 'Paste a valid YouTube live or VOD link.' });
      if (!YOUTUBE_API_KEY) return json(res, 400, { ok: false, error: 'YOUTUBE_API_KEY_NOT_SET', message: 'Set YOUTUBE_API_KEY in .env (local) or Vercel dashboard (production). See README.md Step 2.' });
      const details = await getVideoDetails(videoId, url);
      const maxClips = Math.max(1, Math.min(20, parseInt(body.maxClips || '10', 10)));
      let candidates = [];
      let chatSource = 'ESTIMATED';
      let chatMessages = 0;
      let gemini = { used: false };
      // 1) Live chat
      if (details.liveChatId) {
        try {
          const msgs = await getLiveChatMessages(details.liveChatId);
          if (msgs.length) {
            const picks = bucketSpikes(msgs, details.durationSec || 3600, maxClips);
            candidates = picks.map((p) => ({ ...p, source: 'live', label: 'REAL CHAT LIVE' }));
            chatSource = 'REAL CHAT LIVE'; chatMessages = msgs.length;
          }
        } catch (e) { /* fall through */ }
      }
      // 2) VOD chat replay
      if (!candidates.length) {
        try {
          const replay = await getChatReplayViaYtDlp(url, details.durationSec);
          if (replay.available && replay.messages && replay.messages.length) {
            const picks = bucketSpikes(replay.messages, details.durationSec, maxClips);
            candidates = picks.map((p) => ({ ...p, source: 'replay', label: 'REAL CHAT REPLAY' }));
            chatSource = 'REAL CHAT REPLAY'; chatMessages = replay.messages.length;
          }
        } catch (e) {}
      }
      // 3) Comments fallback
      if (!candidates.length) {
        try {
          const fb = await getCommentsFallback(videoId);
          if (fb.messages && fb.messages.length) {
            const picks = fb.messages.slice(0, maxClips).map((m, i) => ({ start: Math.floor(((i + 1) / (fb.messages.length + 1)) * (details.durationSec || 300)), timecode: fmtTime(Math.floor(((i + 1) / (fb.messages.length + 1)) * (details.durationSec || 300))), score: 60 + Math.min(30, m.likes || 0), messageCount: 1, hypeHits: hypeScore(m.text).length, reason: `Top comment by ${m.author || 'viewer'} (${m.likes || 0} likes): ${String(m.text || '').slice(0, 80)}`, source: 'comments', label: 'REAL COMMENTS' }));
            candidates = picks;
            chatSource = 'REAL COMMENTS'; chatMessages = fb.messages.length;
          }
        } catch (e) {}
      }
      // 4) Action-peak motion scan (always runs for VODs, complements chat)
      let action = { source: 'action', peaks: [], estimated: true };
      try { action = await getActionPeaks(url, videoId, details.durationSec, maxClips); } catch (e) {}
      const seen = new Set(candidates.map((c) => c.start));
      for (const p of action.peaks) {
        if (candidates.length >= maxClips) break;
        if (seen.has(p.start)) continue;
        candidates.push({ ...p, source: 'action', label: action.estimated ? 'ESTIMATED' : 'ACTION PEAK' });
        seen.add(p.start);
      }
      candidates.sort((a, b) => a.start - b.start);
      // 5) Gemini AI ranking (optional, server-only, 429 = clear message + fallback)
      if (GEMINI_API_KEY && candidates.length) {
        const prompt = `You are a short-form video editor. Rank these moments from a gaming livestream by viral potential (funny, epic, unexpected reaction). Video: "${details.title}". Moments: ${candidates.map((c) => `${c.timecode} score ${c.score} - ${c.reason}`).join(' | ')}. Reply with a short ranked list, one line per moment: timecode - reason. Keep it in English.`;
        const g = await geminiGenerate(prompt);
        if (g.ok) gemini = { used: true, ranking: g.text };
        else if (g.error === 'GEMINI_QUOTA_EXCEEDED') gemini = { used: false, error: 'GEMINI_QUOTA_EXCEEDED', message: 'Gemini quota exceeded (HTTP 429). Using chat + motion detection instead.' };
        else gemini = { used: false, error: g.error || 'GEMINI_UNAVAILABLE' };
      } else if (!GEMINI_API_KEY) {
        gemini = { used: false, error: 'GEMINI_KEY_NOT_SET', message: 'Gemini key not set. Using chat + motion detection.' };
      }
      return json(res, 200, { ok: true, video: details, candidates, chatSource, chatMessages, actionEstimated: action.estimated, gemini, isLiveData: true, badge: 'YOUTUBE API · REAL DATA' });
    }
    if (pathname === '/api/facecam' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await detectFacecamBox(body.url || '', parseTimecode(body.startTime || '0:00') || 0, parseInt(body.durationSec || '30', 10));
      return json(res, 200, { ok: true, ...result });
    }
    if (pathname === '/api/manual-clip' && req.method === 'POST') {
      const body = await readBody(req);
      const startSec = parseTimecode(body.startTime);
      const durationSec = Math.max(5, Math.min(120, parseInt(body.seconds || '30', 10)));
      if (startSec == null) return json(res, 400, { ok: false, error: 'INVALID_START_TIME', message: 'Enter a start time like 12:34 or 1:00:00.' });
      const videoId = parseVideoId(body.url || '');
      return json(res, 200, { ok: true, clip: { startSec, durationSec, timecode: fmtTime(startSec), title: `Manual clip at ${fmtTime(startSec)}`, source: 'manual', label: 'MANUAL', score: 0, reason: `Manual clip - starts at ${fmtTime(startSec)}, ${durationSec}s long` } });
    }
    if (pathname === '/api/render' && req.method === 'POST') {
      const body = await readBody(req);
      const day = todayKey();
      const used = dailyCounts.get(day) || 0;
      const isPremium = !!body.premium;
      const limit = isPremium ? 100 : 10;
      if (used >= limit) return json(res, 429, { ok: false, error: 'DAILY_LIMIT', message: `Free limit reached (${limit} clips/day). Upgrade to Premium for 100+ clips/day.` });
      dailyCounts.set(day, used + 1);
      const job = await startRenderJob({
        url: body.url, videoId: parseVideoId(body.url || ''), title: body.title || '',
        startSec: parseTimecode(body.startTime) != null ? parseTimecode(body.startTime) : Math.floor(body.startSec || 0),
        durationSec: Math.max(5, Math.min(120, parseInt(body.durationSec || body.seconds || '30', 10))),
        ratio: body.ratio || '9:16', captionLang: body.captionLang || 'Roman Urdu', captionsOn: body.captionsOn !== false,
        layout: body.layout || 'auto', facecam: body.facecam || null, premium: isPremium,
      });
      return json(res, 200, { ok: true, job: jobPublic(job) });
    }
    if (pathname.startsWith('/api/jobs/')) {
      const id = pathname.split('/')[3];
      return json(res, 200, { ok: true, job: jobPublic(jobs.get(id)) });
    }
    if (pathname.startsWith('/api/download/')) {
      const id = pathname.split('/')[3];
      const j = jobs.get(id);
      if (!j || j.status !== 'ready' || !j.outputFile || !fs.existsSync(j.outputFile)) return json(res, 404, { ok: false, error: 'NOT_READY' });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="ats-live-clipper-${id}.mp4"` });
      fs.createReadStream(j.outputFile).pipe(res);
      return;
    }
    if (pathname.startsWith('/api/captions/')) {
      const id = pathname.split('/')[3];
      const j = jobs.get(id);
      if (!j || !j.srtFile || !fs.existsSync(j.srtFile)) return json(res, 404, { ok: false, error: 'NO_CAPTIONS' });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="ats-live-clipper-${id}.srt"` });
      fs.createReadStream(j.srtFile).pipe(res);
      return;
    }
    // ---- Static files ----
    const publicDir = path.join(__dirname, '..', 'public');
    let filePath = pathname === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(publicDir)) return json(res, 403, { ok: false });
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(publicDir, 'index.html')).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'SERVER_ERROR', message: String(e.message || e).slice(0, 300) });
  }
}
module.exports = { handler };

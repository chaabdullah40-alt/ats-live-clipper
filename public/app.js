// ATS Live Clipper - client (no login, no database required for core use)
let currentUrl = '';
let currentVideo = null;
let usedToday = 0;
let isPremium = false;

function showTab(name) {
  document.getElementById('tab-clipper').classList.toggle('hidden', name !== 'clipper');
  document.getElementById('tab-premium').classList.toggle('hidden', name !== 'premium');
  document.getElementById('tabClipper').classList.toggle('active', name === 'clipper');
  document.getElementById('tabPremium').classList.toggle('active', name === 'premium');
}
function updateCounter() {
  const limit = isPremium ? 100 : 10;
  document.getElementById('counter').textContent = (isPremium ? 'Premium ' : 'Free ') + usedToday + '/' + limit + ' today';
}
async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const j = await r.json();
    if (j.payments) {
      const p = j.payments;
      const a = p.accounts || {};
      document.getElementById('payInfo').textContent =
        `Pay ${p.premium_price_pkr_per_month} PKR/month — Easypaisa (${a.easypaisa?.account_name || ''}), JazzCash (${a.jazzcash?.account_name || ''}), Binance (${a.binance?.account_name || ''}). Send payment, then submit your Transaction ID below.`;
    }
  } catch (e) {}
}
document.getElementById('followedBtn').addEventListener('click', () => {
  localStorage.setItem('ats_followed', '1');
  document.getElementById('followGate').classList.add('hidden');
});
if (localStorage.getItem('ats_followed') === '1') document.getElementById('followGate').classList.add('hidden');
updateCounter(); loadConfig();

async function analyze(isPoll) {
  const url = document.getElementById('url').value.trim();
  if (!url) { alert('Paste a YouTube live or VOD link first.'); return; }
  currentUrl = url;
  document.getElementById('status').textContent = isPoll ? 'Polling live chat...' : 'Analyzing... This can take 30-60 seconds for VOD chat replay and motion scan.';
  document.getElementById('analyzeBtn').disabled = true;
  try {
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, maxClips: document.getElementById('maxClips').value }) });
    const j = await r.json();
    if (!j.ok) { document.getElementById('status').textContent = 'Error: ' + (j.message || j.error); return; }
    currentVideo = j.video;
    document.getElementById('videoInfo').classList.remove('hidden');
    document.getElementById('thumb').src = j.video.thumbnail;
    document.getElementById('vTitle').textContent = j.video.title;
    document.getElementById('vMeta').textContent = `${j.video.channel} · ${j.video.duration} · ${Number(j.video.viewCount || 0).toLocaleString()} views · ${Number(j.video.likeCount || 0).toLocaleString()} likes · ${Number(j.video.commentCount || 0).toLocaleString()} comments`;
    document.getElementById('chatBadge').textContent = j.chatSource + (j.chatMessages ? ` · ${j.chatMessages} messages` : '');
    document.getElementById('chatBadge').className = 'badge' + (j.chatSource.includes('ESTIMATED') ? ' est' : j.chatSource.includes('LIVE') ? ' live' : '');
    document.getElementById('geminiNote').textContent = j.gemini && j.gemini.used ? ('Gemini AI ranking: ' + (j.gemini.ranking || '').slice(0, 400)) : (j.gemini && j.gemini.message ? j.gemini.message : 'Gemini not used — using chat + motion detection.');
    if (j.video.isLive) document.getElementById('pollBtn').classList.remove('hidden');
    renderCandidates(j.candidates || []);
    document.getElementById('status').textContent = `Found ${(j.candidates || []).length} moments. ${j.actionEstimated ? 'Action peaks are estimated on this server.' : 'Action peaks from motion scan.'}`;
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  } finally { document.getElementById('analyzeBtn').disabled = false; }
}
function renderCandidates(list) {
  const box = document.getElementById('clips');
  document.getElementById('noClips').style.display = list.length ? 'none' : 'block';
  box.innerHTML = '';
  list.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'clip';
    div.innerHTML = `<h3>${c.timecode} — Score ${c.score}</h3><span class="badge">${c.label || c.source || ''}</span><p>${c.reason || ''}</p><div class="actions"><button onclick="renderClip(${i})">CUT VIDEO + CAPTIONS</button></div>`;
    div.dataset.clip = JSON.stringify(c);
    box.appendChild(div);
    // store for renderClip
    div.querySelector('button').onclick = () => renderClip(c);
  });
}
async function manualClip() {
  const start = document.getElementById('manualStart').value.trim();
  const secs = document.getElementById('manualSecs').value;
  if (!currentUrl) { alert('Paste a link and Analyze first.'); return; }
  if (!start) { alert('Enter a start time like 12:34 or 1:00:00.'); return; }
  const r = await fetch('/api/manual-clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: currentUrl, startTime: start, seconds: secs }) });
  const j = await r.json();
  if (!j.ok) { alert(j.message || j.error); return; }
  renderCandidates([j.clip]);
  document.getElementById('status').textContent = 'Manual clip ready — tap CUT VIDEO + CAPTIONS below.';
}
function facecamFromForm() {
  return {
    left: parseInt(document.getElementById('fcLeft').value || '65', 10),
    top: parseInt(document.getElementById('fcTop').value || '65', 10),
    width: parseInt(document.getElementById('fcWidth').value || '35', 10),
    height: parseInt(document.getElementById('fcHeight').value || '35', 10),
  };
}
async function renderClip(c) {
  if (!currentUrl) return;
  const lib = document.getElementById('library');
  const item = document.createElement('div');
  item.className = 'clip';
  item.innerHTML = `<h3>Clip at ${c.timecode} — ${document.getElementById('clipLen').value}s, ${document.getElementById('ratio').value}</h3><div class="progress"><div></div></div><p class="progress-text">Starting download... 0% · 0s elapsed</p>`;
  lib.prepend(item);
  const bar = item.querySelector('.progress > div');
  const txt = item.querySelector('.progress-text');
  const started = Date.now();
  try {
    const r = await fetch('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      url: currentUrl, title: currentVideo?.title || '', startSec: c.start, startTime: c.timecode,
      durationSec: parseInt(document.getElementById('clipLen').value, 10),
      ratio: document.getElementById('ratio').value, captionLang: document.getElementById('capLang').value,
      captionsOn: document.getElementById('captionsOn').checked, layout: document.getElementById('layout').value,
      facecam: facecamFromForm(), premium: isPremium,
    }) });
    const j = await r.json();
    if (!j.ok) { txt.textContent = 'Failed: ' + (j.message || j.error); return; }
    const job = j.job;
    usedToday++; updateCounter();
    const poll = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      try {
        const pr = await fetch('/api/jobs/' + job.id);
        const pj = await pr.json();
        const jj = pj.job;
        if (!jj) return;
        bar.style.width = (jj.percent || 0) + '%';
        txt.textContent = `${jj.message || 'Working...'} ${jj.percent || 0}% · ${elapsed}s elapsed`;
        if (jj.status === 'ready') {
          clearInterval(poll);
          txt.textContent = `Ready in ${elapsed}s — download starting automatically...`;
          item.innerHTML += `<div class="actions"><a href="${jj.downloadUrl}" download><button>DOWNLOAD VIDEO (MP4)</button></a>${jj.srtUrl ? `<a href="${jj.srtUrl}" download><button class="secondary">CAPTIONS (.SRT)</button></a>` : ''}</div>`;
          // Auto-download when ready
          const a = document.createElement('a'); a.href = jj.downloadUrl; a.download = 'ats-live-clipper-clip.mp4'; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => document.getElementById('joinPopup').classList.remove('hidden'), 1200);
        } else if (jj.status === 'failed') {
          clearInterval(poll);
          txt.textContent = 'Failed: ' + (jj.error || 'Unknown error') + ' — try again, or use Manual Clip.';
          const b = document.createElement('button'); b.className = 'secondary'; b.textContent = 'RETRY CUT'; b.onclick = () => renderClip(c); item.appendChild(b);
        }
      } catch (e) {}
    }, 2000);
  } catch (e) { txt.textContent = 'Error: ' + e.message; }
}
function submitTxn() {
  const v = document.getElementById('txn').value.trim();
  if (!v) { document.getElementById('txnMsg').textContent = 'Enter your Transaction ID first.'; return; }
  document.getElementById('txnMsg').textContent = 'Txn ID ' + v + ' submitted. The owner will verify it and activate Premium manually. (This demo stores nothing — wire this to your Telegram approval bot.)';
}

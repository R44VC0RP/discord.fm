/**
 * anomaly.fm control room. Authentication happens in front of this app
 * (Caddy basic_auth on fm.anoma.ly); this server assumes trusted callers.
 *
 * Talks to the bot's control API for live state / rerun / music switching,
 * and manages the recordings + music directories directly.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 8091;
const BOT_API = process.env.BOT_API || 'http://bot:8090';
const RECORDINGS = process.env.RECORDING_DIR || '/recordings';
const MUSIC = process.env.MUSIC_DIR || '/music';
const VOICEMAILS = process.env.VOICEMAIL_DIR || '/voicemails';

// Twilio hotline (webhooks arrive via the public station host at /call/*).
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const CALL_BASE = (process.env.CALL_WEBHOOK_BASE || 'https://anomaly.fm').replace(/\/$/, '');
const TW_AUTH = 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64');

const SAFE_NAME = /^[\w.-]+\.mp3$/;

// --- voicemail transcription (xAI Grok STT; skipped when key is absent) ---
const XAI_KEY = process.env.XAI_API_KEY || '';

async function transcribe(mp3Path) {
  if (!XAI_KEY) return null;
  const fd = new FormData();
  fd.append('format', 'true'); // inverse text normalization ("six ninety nine" -> "$6.99")
  fd.append('language', 'en');
  // Per the docs, `file` must be the LAST multipart field.
  fd.append('file', new Blob([await fsp.readFile(mp3Path)], { type: 'audio/mpeg' }), path.basename(mp3Path));
  const res = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: { authorization: `Bearer ${XAI_KEY}` },
    body: fd,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`xai stt HTTP ${res.status}`);
  const data = await res.json();
  const text = String(data.text ?? '').trim();
  return text || null;
}

/** Adds meta.transcript to a voicemail json (best-effort). Empty string =
 *  transcription succeeded but no speech detected (stops re-attempts). */
async function transcribeVoicemail(base) {
  if (!XAI_KEY) return;
  const metaPath = path.join(VOICEMAILS, `${base}.json`);
  try {
    const text = (await transcribe(path.join(VOICEMAILS, `${base}.mp3`))) ?? '';
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    meta.transcript = text.slice(0, 4000);
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
    console.log(`[stt] transcribed ${base}: ${text ? text.slice(0, 80) : '(no speech)'}`);
  } catch (error) {
    console.warn(`[stt] ${base} failed:`, error.message);
  }
}

/** Backfill: transcribe any existing voicemails that lack a transcript. */
async function transcribeBackfill() {
  if (!XAI_KEY) return;
  const names = (await fsp.readdir(VOICEMAILS).catch(() => []))
    .filter((n) => n.startsWith('vm-') && n.endsWith('.json'));
  for (const name of names) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(VOICEMAILS, name), 'utf8'));
      if (meta.transcript !== undefined) continue;
    } catch { continue; }
    await transcribeVoicemail(name.replace(/\.json$/, ''));
  }
}

// --- archive -> branded mp4 renders (same look as the /clip command) ---
const WEB = process.env.WEB_DIR || '/web';
const MP4_DIR = path.join(RECORDINGS, 'mp4');
const MP4_ART = path.join(WEB, 'clip.png');
const MP4_FONT = path.join(WEB, 'fonts', 'PixelifySans.ttf');

let mp4Active = null; // one render at a time; "<file>" or "<file>:discord"
const mp4Errors = new Map(); // key -> last error message

// variant '' = archive quality (control room download); 'discord' = budgeted
// to fit a Discord upload cap (bot auto-posts finished sessions).
const mp4PathFor = (name, variant = '') =>
  path.join(MP4_DIR, name.replace(/\.mp3$/, variant ? `.${variant}.mp4` : '.mp4'));
const mp4Key = (name, variant = '') => (variant ? `${name}:${variant}` : name);

/** "session-2026-07-02T22-24-33(-partN).mp3" + meta -> drawtext label. */
function mp4Label(name, meta) {
  const m = String(name).match(/^session-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  let when = '';
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    when = d.toLocaleString('en-US', {
      timeZone: process.env.STATION_TZ || 'America/New_York',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }) + ' ET';
  }
  const part = String(name).match(/-part(\d+)\.mp3$/);
  const who = meta && Array.isArray(meta.members) && meta.members.length
    ? meta.members.join(', ')
    : 'the anomaly';
  return [when, part ? `part ${part[1]}` : '', who].filter(Boolean).join(' — ');
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const dur = Number.parseFloat(out.trim());
      if (code === 0 && Number.isFinite(dur) && dur > 0) resolve(dur);
      else reject(new Error('could not probe duration'));
    });
  });
}

async function renderMp4(name, variant = '', budgetBytes = 0) {
  await fsp.mkdir(MP4_DIR, { recursive: true });
  // Housekeeping: drop cached mp4s whose source recording is gone (retention).
  for (const f of await fsp.readdir(MP4_DIR).catch(() => [])) {
    if (f.endsWith('.mp4') && !fs.existsSync(path.join(RECORDINGS, f.replace(/(\.discord)?\.mp4$/, '.mp3')))) {
      await fsp.rm(path.join(MP4_DIR, f), { force: true });
    }
  }

  const src = path.join(RECORDINGS, name);
  const durationS = await probeDuration(src);
  let meta = null;
  try {
    meta = JSON.parse(await fsp.readFile(path.join(RECORDINGS, name.replace(/(-part\d+)?\.mp3$/, '.json')), 'utf8'));
  } catch { /* label falls back */ }
  const labelFile = path.join(MP4_DIR, `.${name}.label.txt`);
  await fsp.writeFile(labelFile, mp4Label(name, meta), 'utf8');

  // Archive quality by default; the discord variant fits a byte budget by
  // shrinking bitrate, then resolution/fps (audio is the product — it wins).
  let fps = 24;
  let scale = '';
  let audioBps = 96_000;
  let maxVideoBps = 1_500_000;
  if (budgetBytes > 0) {
    audioBps = 64_000;
    const totalBps = (budgetBytes * 8 * 0.92) / durationS; // 8% mux headroom
    maxVideoBps = Math.round(Math.min(1_500_000, Math.max(50_000, totalBps - audioBps)));
    if (maxVideoBps < 150_000) { scale = ',scale=640:360:flags=lanczos'; fps = 12; }
    else if (maxVideoBps < 400_000) { scale = ',scale=854:480:flags=lanczos'; fps = 18; }
  }

  const filter =
    '[0:a]asplit=2[aout][awave];' +
    `[awave]showwaves=s=520x150:mode=cline:rate=${fps}:colors=0x3e968f[waves];` +
    '[1:v][waves]overlay=96:470[v1];' +
    "[v1]drawbox=x=96:y=658:w=16:h=16:color=0x3e968f:t=fill:enable='lt(mod(t,1.7),0.85)'[v2];" +
    `[v2]drawtext=textfile=${labelFile}:fontfile=${MP4_FONT}:fontsize=30:fontcolor=0x17140f:x=126:y=648${scale}[vout]`;

  const tmp = mp4PathFor(name, variant) + '.tmp.mp4';
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-loop', '1', '-framerate', String(fps), '-i', MP4_ART,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    // Capped CRF. threads 2 keeps long renders from starving the tv encoder.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2',
    '-maxrate', String(maxVideoBps), '-bufsize', String(maxVideoBps),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', String(audioBps), '-ar', '44100', '-ac', '1',
    // ffmpeg 5.x hangs on -shortest with a looped image input; -t stops it.
    '-t', (durationS + 0.3).toFixed(2),
    '-movflags', '+faststart',
    '-y', tmp,
  ];

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (t) => { stderr = (stderr + t).slice(-2000); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`));
      });
      setTimeout(() => child.kill('SIGKILL'), 30 * 60_000).unref();
    });
    await fsp.rename(tmp, mp4PathFor(name, variant));
  } finally {
    await fsp.rm(labelFile, { force: true });
    await fsp.rm(tmp, { force: true });
  }
}

function startMp4Render(name, variant = '', budgetBytes = 0) {
  const key = mp4Key(name, variant);
  mp4Active = key;
  mp4Errors.delete(key);
  renderMp4(name, variant, budgetBytes)
    .then(() => console.log('[mp4] rendered', key))
    .catch((error) => {
      console.warn('[mp4] failed', key, error.message);
      mp4Errors.set(key, error.message);
    })
    .finally(() => { mp4Active = null; });
}

function mp4Status(name, variant = '') {
  const key = mp4Key(name, variant);
  if (fs.existsSync(mp4PathFor(name, variant))) return { status: 'ready' };
  if (mp4Active === key) return { status: 'rendering' };
  if (mp4Errors.has(key)) return { status: 'error', error: mp4Errors.get(key) };
  return { status: 'none' };
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const xml = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
};

/** Twilio request signature: HMAC-SHA1(authToken, url + sorted(k+v)). */
function twilioValid(req, pathname, params) {
  if (!TW_TOKEN) return false;
  let data = CALL_BASE + pathname;
  for (const key of [...params.keys()].sort()) data += key + params.get(key);
  const expected = crypto.createHmac('sha1', TW_TOKEN).update(data).digest();
  let got;
  try { got = Buffer.from(String(req.headers['x-twilio-signature'] || ''), 'base64'); } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(expected, got);
}

async function listVoicemails() {
  const names = (await fsp.readdir(VOICEMAILS).catch(() => []))
    .filter((n) => n.startsWith('vm-') && n.endsWith('.mp3'));
  const items = await Promise.all(
    names.map(async (name) => {
      const stat = await fsp.stat(path.join(VOICEMAILS, name)).catch(() => null);
      let meta = null;
      try {
        meta = JSON.parse(await fsp.readFile(path.join(VOICEMAILS, name.replace(/\.mp3$/, '.json')), 'utf8'));
      } catch { /* mid-write */ }
      return { file: name, bytes: stat?.size ?? 0, meta };
    }),
  );
  return items.sort((a, b) => b.file.localeCompare(a.file)); // newest first
}

async function botFetch(pathname, options, timeoutMs = 5000) {
  const res = await fetch(BOT_API + pathname, {
    ...options,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json() };
}

async function listRecordings() {
  const names = (await fsp.readdir(RECORDINGS).catch(() => []))
    .filter((n) => n.startsWith('session-') && n.endsWith('.mp3'));
  const items = await Promise.all(
    names.map(async (name) => {
      const stat = await fsp.stat(path.join(RECORDINGS, name)).catch(() => null);
      let meta = null;
      try {
        meta = JSON.parse(
          await fsp.readFile(path.join(RECORDINGS, name.replace(/(-part\d+)?\.mp3$/, '.json')), 'utf8'),
        );
      } catch { /* still recording, or metadata missing */ }
      return {
        file: name,
        bytes: stat?.size ?? 0,
        modified: stat ? new Date(stat.mtimeMs).toISOString() : null,
        mp4: fs.existsSync(mp4PathFor(name)),
        meta,
      };
    }),
  );
  return items.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
}

async function listMusic() {
  const names = (await fsp.readdir(MUSIC).catch(() => [])).filter((n) => n.endsWith('.mp3'));
  return Promise.all(
    names.map(async (name) => ({
      file: name,
      bytes: (await fsp.stat(path.join(MUSIC, name)).catch(() => null))?.size ?? 0,
    })),
  );
}

/** Minimal Range support so <audio> can seek recordings. */
function streamFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = stat.size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Number(range[2]);
    if (!range[1] && range[2]) { start = stat.size - Number(range[2]); end = stat.size - 1; }
    res.writeHead(206, {
      'content-type': 'audio/mpeg',
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
  } else {
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'accept-ranges': 'bytes',
      'content-length': stat.size,
    });
  }
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

const UI = fs.readFileSync(path.join(__dirname, 'ui.html'));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://admin');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, UI, 'text/html; charset=utf-8');
    }

    // --- Twilio hotline webhooks (signature-authenticated, no basic auth) ---
    if (req.method === 'POST' && p === '/call/incoming') {
      const params = new URLSearchParams(await readBody(req));
      if (!twilioValid(req, p, params)) return send(res, 403, { error: 'bad signature' });
      console.log('[call] incoming from', params.get('From'));
      return xml(res,
        `<Play>${CALL_BASE}/station/call-greeting.mp3</Play>` +
        `<Record maxLength="120" playBeep="true" finishOnKey="#" action="${CALL_BASE}/call/done" ` +
        `recordingStatusCallback="${CALL_BASE}/call/recorded" recordingStatusCallbackEvent="completed"/>` +
        '<Hangup/>');
    }
    if (req.method === 'POST' && p === '/call/done') {
      const params = new URLSearchParams(await readBody(req));
      if (!twilioValid(req, p, params)) return send(res, 403, { error: 'bad signature' });
      return xml(res, `<Play>${CALL_BASE}/station/call-received.mp3</Play><Hangup/>`);
    }
    if (req.method === 'POST' && p === '/call/recorded') {
      const params = new URLSearchParams(await readBody(req));
      if (!twilioValid(req, p, params)) return send(res, 403, { error: 'bad signature' });
      if (params.get('RecordingStatus') !== 'completed') return send(res, 200, { ok: true });

      let from = 'unknown';
      try {
        const call = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Calls/${params.get('CallSid')}.json`,
          { headers: { authorization: TW_AUTH }, signal: AbortSignal.timeout(8000) },
        );
        if (call.ok) from = (await call.json()).from || 'unknown';
      } catch { /* keep unknown */ }

      const rec = await fetch(`${params.get('RecordingUrl')}.mp3`, {
        headers: { authorization: TW_AUTH },
        signal: AbortSignal.timeout(20000),
      });
      if (!rec.ok) {
        console.warn('[call] recording download failed:', rec.status);
        return send(res, 200, { ok: false });
      }
      const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      const base = `vm-${stamp}`;
      await fsp.writeFile(path.join(VOICEMAILS, `${base}.mp3`), Buffer.from(await rec.arrayBuffer()));
      await fsp.writeFile(
        path.join(VOICEMAILS, `${base}.json`),
        JSON.stringify({
          from,
          durationSeconds: Number(params.get('RecordingDuration')) || null,
          receivedAt: new Date().toISOString(),
          callSid: params.get('CallSid'),
          archived: false,
        }, null, 2),
      );
      console.log(`[call] voicemail saved: ${base} from ${from}`);
      // Finish async so Twilio gets its 200 immediately: transcribe FIRST
      // (the Discord notify includes the transcript), then notify + cleanup.
      const recordingUrl = params.get('RecordingUrl');
      void (async () => {
        await transcribeVoicemail(base);
        try {
          await botFetch('/voicemail/received', { method: 'POST', body: JSON.stringify({ file: `${base}.mp3` }) });
        } catch { /* notification is best-effort */ }
        try {
          await fetch(`${recordingUrl}.json`, { method: 'DELETE', headers: { authorization: TW_AUTH } });
        } catch { /* best effort */ }
      })();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/audience') {
      const hours = Number(url.searchParams.get('hours')) || 168;
      const out = await botFetch(`/audience?hours=${hours}`);
      return send(res, out.status, out.body);
    }

    if (req.method === 'GET' && p === '/api/state') {
      const [bot, recordings, music, voicemails] = await Promise.all([
        botFetch('/state').catch(() => ({ status: 502, body: { error: 'bot unreachable' } })),
        listRecordings(),
        listMusic(),
        listVoicemails(),
      ]);
      return send(res, 200, { bot: bot.body, recordings, music, voicemails });
    }

    // voicemails
    const vmAudio = p.match(/^\/api\/voicemails\/([\w.-]+\.mp3)\/audio$/);
    if (req.method === 'GET' && vmAudio) {
      const filePath = path.join(VOICEMAILS, path.basename(vmAudio[1]));
      if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not found' });
      return streamFile(req, res, filePath);
    }
    const vmArch = p.match(/^\/api\/voicemails\/([\w.-]+\.mp3)\/archive$/);
    if (req.method === 'POST' && vmArch) {
      const name = path.basename(vmArch[1]);
      const metaPath = path.join(VOICEMAILS, name.replace(/\.mp3$/, '.json'));
      const body = JSON.parse(await readBody(req) || '{}');
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(metaPath, 'utf8')); } catch { /* fresh meta */ }
      meta.archived = Boolean(body.archived);
      await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
      return send(res, 200, { file: name, archived: meta.archived });
    }
    const vmDel = p.match(/^\/api\/voicemails\/([\w.-]+\.mp3)$/);
    if (req.method === 'DELETE' && vmDel) {
      const name = path.basename(vmDel[1]);
      await fsp.rm(path.join(VOICEMAILS, name), { force: true });
      await fsp.rm(path.join(VOICEMAILS, name.replace(/\.mp3$/, '.json')), { force: true });
      return send(res, 200, { deleted: name });
    }
    if (req.method === 'POST' && p === '/api/announce') {
      const body = await readBody(req);
      // Script + TTS generation runs ~15-25s; don't abort under it.
      const out = await botFetch('/announce', { method: 'POST', body: body || '{}' }, 45_000);
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && p === '/api/voicemail/play') {
      const body = await readBody(req);
      const out = await botFetch('/voicemail/play', { method: 'POST', body: body || '{}' });
      return send(res, out.status, out.body);
    }

    // recordings
    const audioMatch = p.match(/^\/api\/recordings\/([\w.-]+\.mp3)\/audio$/);
    if (req.method === 'GET' && audioMatch) {
      const filePath = path.join(RECORDINGS, path.basename(audioMatch[1]));
      if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not found' });
      return streamFile(req, res, filePath);
    }
    const recMatch = p.match(/^\/api\/recordings\/([\w.-]+\.mp3)$/);
    if (req.method === 'DELETE' && recMatch) {
      const name = path.basename(recMatch[1]);
      await fsp.rm(path.join(RECORDINGS, name), { force: true });
      await fsp.rm(path.join(RECORDINGS, name.replace(/(-part\d+)?\.mp3$/, '.json')), { force: true });
      await fsp.rm(mp4PathFor(name), { force: true });
      await fsp.rm(mp4PathFor(name, 'discord'), { force: true });
      return send(res, 200, { deleted: name });
    }

    // archive -> mp4 clip renders (?variant=discord&budget=<bytes> for the
    // size-capped variant the bot posts to Discord)
    const mp4Match = p.match(/^\/api\/recordings\/([\w.-]+\.mp3)\/mp4$/);
    const mp4Variant = url.searchParams.get('variant') === 'discord' ? 'discord' : '';
    if (req.method === 'POST' && mp4Match) {
      const name = path.basename(mp4Match[1]);
      if (!fs.existsSync(path.join(RECORDINGS, name))) return send(res, 404, { error: 'not found' });
      const current = mp4Status(name, mp4Variant);
      if (current.status === 'ready' || current.status === 'rendering') return send(res, 200, current);
      if (mp4Active) return send(res, 429, { status: 'busy', rendering: mp4Active });
      const budget = mp4Variant ? Math.max(1_000_000, Number(url.searchParams.get('budget')) || 9_500_000) : 0;
      startMp4Render(name, mp4Variant, budget);
      return send(res, 200, { status: 'rendering' });
    }
    const mp4StatusMatch = p.match(/^\/api\/recordings\/([\w.-]+\.mp3)\/mp4\/status$/);
    if (req.method === 'GET' && mp4StatusMatch) {
      return send(res, 200, mp4Status(path.basename(mp4StatusMatch[1]), mp4Variant));
    }
    if (req.method === 'GET' && mp4Match) {
      const name = path.basename(mp4Match[1]);
      const filePath = mp4PathFor(name, mp4Variant);
      if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not rendered' });
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': stat.size,
        'content-disposition': `attachment; filename="anomalyfm-${name.replace(/\.mp3$/, '.mp4')}"`,
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    // rerun controls (proxied to the bot)
    if (req.method === 'POST' && ['/api/rerun/queue', '/api/rerun/unqueue', '/api/rerun/skip', '/api/rerun/auto'].includes(p)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const out = await botFetch(p.replace('/api', ''), { method: 'POST', body: Buffer.concat(chunks).toString() || '{}' });
      return send(res, out.status, out.body);
    }

    // music bed
    if (req.method === 'PUT' && p === '/api/music/upload') {
      const name = path.basename(url.searchParams.get('name') ?? '');
      if (!SAFE_NAME.test(name)) return send(res, 400, { error: 'invalid name (use letters/numbers, .mp3)' });
      const target = path.join(MUSIC, name);
      const out = fs.createWriteStream(target);
      req.pipe(out);
      await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
      return send(res, 200, { uploaded: name, bytes: fs.statSync(target).size });
    }
    const musicAudio = p.match(/^\/api\/music\/([\w.-]+\.mp3)\/audio$/);
    if (req.method === 'GET' && musicAudio) {
      const filePath = path.join(MUSIC, path.basename(musicAudio[1]));
      if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not found' });
      return streamFile(req, res, filePath);
    }
    if (req.method === 'POST' && p === '/api/music/track') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const out = await botFetch('/music/track', { method: 'POST', body: Buffer.concat(chunks).toString() || '{}' });
      return send(res, out.status, out.body);
    }
    const musicMatch = p.match(/^\/api\/music\/([\w.-]+\.mp3)$/);
    if (req.method === 'DELETE' && musicMatch) {
      const name = path.basename(musicMatch[1]);
      const state = await botFetch('/state').catch(() => null);
      if (state?.body?.music?.track === name) return send(res, 409, { error: 'track is active' });
      await fsp.rm(path.join(MUSIC, name), { force: true });
      return send(res, 200, { deleted: name });
    }

    send(res, 404, { error: 'not found' });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

fs.mkdirSync(VOICEMAILS, { recursive: true });
server.listen(PORT, '0.0.0.0', () => console.log(`[admin] control room on :${PORT} (bot api: ${BOT_API})`));
// Transcribe any pre-existing voicemails once the server is settled.
setTimeout(() => void transcribeBackfill(), 10_000);

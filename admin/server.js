/**
 * anomaly.fm control room. Authentication happens in front of this app
 * (Caddy basic_auth on fm.anoma.ly); this server assumes trusted callers.
 *
 * Talks to the bot's control API for live state / rerun / music switching,
 * and manages the recordings + music directories directly.
 */

'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');
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

// --- durable automation service (asset catalog / queue / DJ / hotline) ---
// The browser never sees this token: the admin server proxies a fixed
// allowlist of automation routes and injects the credential server-side.
const AUTOMATION_API = (process.env.AUTOMATION_API || 'http://automation:8092').replace(/\/$/, '');
const AUTOMATION_TOKEN = process.env.AUTOMATION_INTERNAL_TOKEN || '';
const ORIGINALS = path.join(MUSIC, 'originals');
const STAGING_DIR = path.join(ORIGINALS, '.staging');
const UPLOAD_MAX_BYTES = Math.max(1_048_576, Number(process.env.UPLOAD_MAX_BYTES) || 60 * 1024 * 1024);
const PROXY_BODY_MAX_BYTES = 16 * 1024;
// Concurrency + aggregate staging budget: bounds simultaneous streams AND the
// ffprobe fan-out automation performs per registration.
const UPLOAD_MAX_CONCURRENT = Math.min(4, Math.max(1, Number(process.env.UPLOAD_MAX_CONCURRENT) || 2));
const STAGING_MAX_BYTES = Math.max(UPLOAD_MAX_BYTES, Number(process.env.STAGING_MAX_BYTES) || 256 * 1024 * 1024);

/**
 * Same-origin gate for every state mutation. Fail-closed for browsers:
 * - Sec-Fetch-Site present (all modern browsers): only `same-origin`/`none`.
 * - Otherwise an Origin header must match the request Host ("null" and
 *   mismatches — including simple text/plain cross-origin posts — are
 *   rejected).
 * - Requests with neither header are non-browser callers (the bot's mp4
 *   render requests, curl, tests) already inside the trusted network /
 *   behind Caddy basic_auth, and are allowed.
 * Twilio /call/* webhooks are handled before this gate and stay
 * signature-authenticated. With basic_auth in front and no cookie auth, a
 * separate CSRF token adds nothing beyond this check.
 */
function sameOriginOk(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  try {
    return new URL(String(origin)).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

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
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const automationUnavailable = (message, code = 'AUTOMATION_UNAVAILABLE') =>
  ({ status: 503, body: { error: { code, message } } });

/** Authenticated JSON call into automation. Fails soft (503) when the service
 *  is absent so the rest of the control room keeps working. */
async function automationFetch(pathname, options = {}, timeoutMs = 10_000) {
  if (!AUTOMATION_TOKEN) return automationUnavailable('automation is not configured on this box', 'AUTOMATION_NOT_CONFIGURED');
  try {
    const res = await fetch(AUTOMATION_API + pathname, {
      ...options,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AUTOMATION_TOKEN}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return automationUnavailable('automation service is unreachable');
  }
}

/** Reads a small JSON request body for proxying; rejects oversized payloads. */
async function readProxyBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > PROXY_BODY_MAX_BYTES) { const err = new Error('request body too large'); err.statusCode = 413; throw err; }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { JSON.parse(raw); } catch { const err = new Error('request body must be JSON'); err.statusCode = 400; throw err; }
  return raw;
}

// --- browser projections -------------------------------------------------
// Everything the proxy returns to the browser is rebuilt from an explicit
// per-field allowlist. Worker IDs, lease owners, run IDs, cue/group/asset
// internals the UI never uses, locators, checksums, and tokens are dropped
// here even if automation adds them later.

const pick = (source, keys) => {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
};

/**
 * Non-2xx automation bodies are reduced to a code plus a FIXED public
 * message. Raw automation messages can carry ffprobe stderr, private paths,
 * or internal IDs, so they are never forwarded; unknown codes get a generic
 * message and `details` is always dropped.
 */
const SAFE_AUTOMATION_ERRORS = {
  AUTOMATION_UNAVAILABLE: 'automation service is unavailable',
  AUTOMATION_NOT_CONFIGURED: 'automation is not configured on this box',
  UPLOAD_UNRESOLVED: 'automation became unreachable; the upload is kept and will be reconciled automatically',
  UPLOAD_NOT_ACCEPTED: 'automation did not accept the upload before becoming unreachable; the file was rolled back',
  REVISION_CONFLICT: 'the queue changed underneath you — refresh and try again',
  IDEMPOTENCY_CONFLICT: 'this action was already submitted with different content',
  MODERATION_VERSION_CONFLICT: 'the call changed underneath you — refresh and review again',
  CANDIDATE_ACTIVE: 'the call group is claimed or playing right now',
  CANDIDATE_AIRED: 'aired calls are terminal and cannot be reviewed',
  CANDIDATE_NOT_FOUND: 'call not found',
  CANDIDATE_INELIGIBLE: 'the call is not eligible',
  CANDIDATE_SCREEN_STALE: 'the screening policy changed — refresh and review again',
  INVALID_REVIEW_TRANSITION: 'that review action is not allowed from the current call state',
  ASSET_NOT_FOUND: 'asset not found',
  ASSET_NOT_READY: 'the asset is not READY',
  ASSET_KIND_MISMATCH: 'that asset kind cannot be used here',
  ASSET_FILE_MISSING: 'the asset audio file is missing',
  CHECKSUM_MISMATCH: 'the asset bytes no longer match the catalog',
  REPEAT_BLOCKED: 'that track is already queued or inside its repeat window',
  ARTIST_REPEAT_BLOCKED: 'that artist is already queued or inside the repeat window',
  QUEUE_CAP_EXCEEDED: 'the queue is at its item cap',
  HORIZON_CAP_EXCEEDED: 'the queue is at its duration cap',
  COMMENTARY_TOO_SOON: 'commentary needs at least three music tracks since the last spoken segment',
  COMMENTARY_DUE: 'commentary is due before another DJ track',
  SCRIPT_TOO_LONG: 'the script is too long',
  SCRIPT_CONTAINS_PII: 'the script contains or references private data',
  SCRIPT_UNSAFE: 'the script failed the safety screen',
  SCRIPT_BADWORD: 'the script failed deterministic speech screening',
  PROBE_FAILED: 'the uploaded file is not decodable MP3 audio',
  INVALID_AUDIO: 'uploads must contain MP3 audio',
  UPLOAD_FILE_MISSING: 'the staged upload file was not found',
  HOTLINE_DISABLED: 'hotline automation is disabled',
  PLAYOUT_DISABLED: 'automation playout is disabled',
  RANGE_NOT_SATISFIABLE: 'requested range is not satisfiable',
  NOT_FOUND: 'not found',
  UNAUTHORIZED: 'automation rejected the admin credential',
  AUDIO_PREVIEW_REJECTED: 'audio preview request was rejected',
  AUDIO_PREVIEW_UNAVAILABLE: 'audio preview is temporarily unavailable',
  AUDIO_PREVIEW_INVALID: 'audio preview returned an invalid response',
};
const projectError = (body) => {
  const rawCode = body && body.error && typeof body.error.code === 'string' ? body.error.code : '';
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'AUTOMATION_ERROR';
  const message = SAFE_AUTOMATION_ERRORS[code]
    || (code.startsWith('INVALID_') || ['UNKNOWN_FIELDS', 'TEXT_TOO_LONG', 'BODY_TOO_LARGE'].includes(code)
      ? 'automation rejected the request as invalid'
      : 'automation request failed');
  return { error: { code, message } };
};

/** Wraps a projection so error responses stay structured and status is kept. */
const projected = (out, projectBody) =>
  ({ status: out.status, body: out.status >= 200 && out.status < 300 ? projectBody(out.body || {}) : projectError(out.body) });

const FLAG_KEYS = ['playout_enabled', 'dj_enabled', 'dj_shadow', 'hotline_enabled', 'generation_enabled'];
const WATERMARK_KEYS = ['low_count', 'high_count', 'low_duration_ms', 'target_duration_ms', 'max_duration_ms'];

const oneOf = (value, allowed, fallback = null) => allowed.includes(value) ? value : fallback;
const safeNumber = (value, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : 0;
const safeDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
};
const safeVersion = (value) =>
  typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value) ? value : null;

const projectQueue = (body) => ({
  queue_revision: body.queue_revision,
  flags: pick(body.flags, FLAG_KEYS),
  watermarks: pick(body.watermarks, WATERMARK_KEYS),
  ...pick(body, ['ready_count', 'ready_duration_ms', 'generating_count', 'generating_duration_ms', 'tracks_since_commentary']),
  cues: (Array.isArray(body.cues) ? body.cues : []).map((cue) => ({
    ...pick(cue, ['type', 'state', 'role', 'planned_duration_ms', 'position', 'group_index', 'last_offset_ms']),
    public_metadata: pick(cue.public_metadata, ['title', 'artist']),
  })),
  presence: { humans: body.presence ? body.presence.humans : undefined },
});

const projectCatalog = (body) => ({
  items: (Array.isArray(body.items) ? body.items : []).map((item) =>
    pick(item, ['asset_id', 'kind', 'status', 'title', 'artist', 'album', 'tags', 'duration_ms'])),
  nextCursor: body.nextCursor ?? null,
});

const DJ_TOOLS = ['list_tracks', 'get_track_history', 'get_queue', 'enqueue_track', 'enqueue_commentary', 'list_hotline_candidates', 'enqueue_hotline_group'];
const DJ_RESULTS = ['COMPLETED', 'FAILED', 'ABORTED', 'NOOP', 'DAILY_BUDGET'];
const DJ_RUN_STATES = ['RUNNING', 'COMPLETED', 'FAILED', 'ABORTED', 'NOOP'];

/**
 * DJ status is a successful (200) response, but several source fields are fed
 * by provider/SDK failures. Treat it like an untrusted error boundary anyway:
 * reconstruct only booleans, bounded numbers, strict timestamps/version, and
 * closed enums. In particular no opencode.error, model/provider text, or
 * arbitrary failure diagnostics ever reaches the browser.
 */
const projectDj = (body) => {
  const oc = body && typeof body.opencode === 'object' ? body.opencode : {};
  const healthy = oc.healthy === true;
  const sourceHealth = oneOf(oc.status, ['OK', 'NOT_CONFIGURED', 'UNREACHABLE', 'UPSTREAM_ERROR', 'UNHEALTHY']);
  const healthStatus = healthy ? 'HEALTHY'
    : sourceHealth === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED'
      : 'UNAVAILABLE';
  const lease = body && typeof body.lease === 'object' ? body.lease : {};
  const run = body && typeof body.last_run === 'object' && body.last_run ? body.last_run : null;
  const daily = body && typeof body.daily === 'object' ? body.daily : {};
  const watermarks = body && typeof body.watermarks === 'object' ? body.watermarks : {};
  const runState = run ? oneOf(run.state, DJ_RUN_STATES, 'FAILED') : null;
  return {
    mode: oneOf(body && body.mode, ['OFF', 'SHADOW', 'LIVE'], 'OFF'),
    flags: Object.fromEntries(FLAG_KEYS.map((key) => [key, body && body.flags && body.flags[key] === true])),
    opencode: {
      healthy,
      status: healthStatus,
      version: safeVersion(oc.version),
      message_code: healthy ? 'OPENCODE_HEALTHY'
        : healthStatus === 'NOT_CONFIGURED' ? 'OPENCODE_NOT_CONFIGURED'
          : 'OPENCODE_UNAVAILABLE',
    },
    lease: {
      held: Boolean(lease.owner),
      expires_at: safeDate(lease.expires_at),
      cooldown_until: safeDate(lease.cooldown_until),
      backoff_until: safeDate(lease.backoff_until),
      failure_count: safeNumber(lease.failure_count, 0, 1_000_000),
      last_result: oneOf(lease.last_result, DJ_RESULTS),
    },
    // Deliberately no run/session IDs, model/provider data, timestamps,
    // token/cost accounting, or failure diagnostics. The panel needs only a
    // closed status plus a fixed public message code.
    last_run: run ? {
      state: runState,
      message_code: `DJ_RUN_${runState}`,
    } : null,
    daily: Object.fromEntries(['tool_calls', 'tool_call_limit', 'model_tokens', 'model_token_limit', 'tts_characters', 'tts_character_limit']
      .map((key) => [key, safeNumber(daily[key], 0)])),
    watermarks: Object.fromEntries(WATERMARK_KEYS.map((key) => [key, safeNumber(watermarks[key], 0)])),
    tools: [...new Set((Array.isArray(body && body.tools) ? body.tools : []).filter((tool) => DJ_TOOLS.includes(tool)))],
  };
};

const projectHistory = (body) => ({
  items: (Array.isArray(body.items) ? body.items : []).map((item) => pick(item, ['event', 'reason_code', 'at', 'title', 'type'])),
});

const projectHotline = (body) => ({
  hotlineEnabled: Boolean(body.hotlineEnabled),
  items: (Array.isArray(body.items) ? body.items : []).map((item) =>
    pick(item, ['candidate_id', 'call_id', 'status', 'screen_result', 'screen_current', 'moderation_version',
      'transcript', 'summary', 'archive_reason', 'operator_override', 'aired_at', 'updated_at', 'duration_ms', 'dj_visible'])),
  nextCursor: body.nextCursor ?? null,
});

const projectEnqueue = (body) => pick(body, ['accepted', 'queue_revision', 'state']);
const projectReview = (body) => pick(body, ['status', 'moderation_version', 'operator_override']);
const projectUpload = (body) => pick(body, ['created', 'duplicate', 'asset_id', 'title', 'duration_ms']);

// --- upload staging accounting + registration reconciliation --------------

let uploadsActive = 0;
let stagingBytesActive = 0; // bytes of in-flight streamed writes

const UNRESOLVED_PATH = path.join(STAGING_DIR, 'unresolved.json');

// Every journal operation shares this single promise queue. A rejected task
// cannot poison the queue for later callers.
let unresolvedJournalTail = Promise.resolve();
function withUnresolvedJournalLock(operation) {
  const result = unresolvedJournalTail.then(operation, operation);
  unresolvedJournalTail = result.catch(() => {});
  return result;
}

const validUnresolvedMap = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([id, entry]) => /^ast_[a-f0-9]{32}$/.test(id)
    && entry && typeof entry === 'object' && Number.isFinite(Number(entry.bytes)) && Number(entry.bytes) >= 0);

/** Must be called under withUnresolvedJournalLock. On corruption, retain the
 * broken file for forensics and conservatively reconstruct from every
 * immutable asset file. Catalog reconciliation can then adopt or prune each
 * one; a parse failure can never silently forget live bytes. */
async function loadUnresolvedLocked() {
  try {
    const parsed = JSON.parse(await fsp.readFile(UNRESOLVED_PATH, 'utf8'));
    if (!validUnresolvedMap(parsed)) throw new Error('invalid unresolved upload journal');
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    await fsp.mkdir(STAGING_DIR, { recursive: true, mode: 0o700 });
    const corrupt = `${UNRESOLVED_PATH}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
    // Copy, do not move: if rebuilding or the atomic replacement fails, the
    // original corrupt journal remains in place and the next restart retries
    // recovery instead of mistaking it for an empty journal.
    await fsp.copyFile(UNRESOLVED_PATH, corrupt).catch(() => {});
    const rebuilt = {};
    for (const name of await fsp.readdir(ORIGINALS).catch(() => [])) {
      const match = name.match(/^(ast_[a-f0-9]{32})\.mp3$/);
      if (!match) continue;
      const stat = await fsp.stat(path.join(ORIGINALS, name)).catch(() => null);
      if (stat && stat.isFile()) rebuilt[match[1]] = {
        bytes: stat.size,
        at: new Date(stat.mtimeMs).toISOString(),
        recovered_from_corruption: true,
      };
    }
    await saveUnresolvedLocked(rebuilt);
    return rebuilt;
  }
}

/** Must be called under withUnresolvedJournalLock. Unique temp names avoid
 * collisions with interrupted prior writes; rename is atomic on this mount. */
async function saveUnresolvedLocked(map) {
  await fsp.mkdir(STAGING_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${UNRESOLVED_PATH}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, UNRESOLVED_PATH);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

const readUnresolved = () => withUnresolvedJournalLock(() => loadUnresolvedLocked());
const addUnresolved = (assetId, entry) => withUnresolvedJournalLock(async () => {
  const latest = await loadUnresolvedLocked();
  latest[assetId] = entry;
  await saveUnresolvedLocked(latest);
});

const unresolvedBytes = (map) => Object.values(map).reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);

/**
 * Resolve uploads whose registration outcome was ambiguous (automation may
 * have committed before the response was lost). For each journaled asset id:
 * a catalog hit means the file IS the committed copy (keep, forget); a
 * definitive 404 means automation never committed (delete the orphan);
 * anything else stays journaled for the next pass. Runs at startup and
 * before each new upload.
 */
async function reconcileUnresolvedUploads() {
  return withUnresolvedJournalLock(async () => {
    const map = await loadUnresolvedLocked();
    const ids = Object.keys(map);
    if (!ids.length) return;
    for (const assetId of ids) {
      const out = await automationFetch(`/internal/catalog/assets/${assetId}`, {}, 5000);
      if (out.status === 200) {
        delete map[assetId];
      } else if (out.status === 404 && map[assetId].recovered_from_corruption !== true) {
        await fsp.rm(path.join(ORIGINALS, `${assetId}.mp3`), { force: true }).catch(() => {});
        delete map[assetId];
      }
      // Any other status stays journaled. Corruption-recovered files are also
      // retained on 404: the lost journal cannot prove they were disposable.
    }
    await saveUnresolvedLocked(map);
  });
}

/**
 * Registers a staged upload with retry + reconciliation so a response lost
 * AFTER automation committed never deletes the catalog's bytes.
 * Returns { outcome: 'created'|'duplicate'|'rejected'|'unresolved', status, body }.
 * File policy: created → keep; duplicate (different asset) → caller deletes;
 * rejected → caller deletes; unresolved → keep + journal.
 */
async function registerUploadWithReconciliation(assetId, registerBody) {
  const attempt = () => automationFetch('/internal/catalog/register-upload', { method: 'POST', body: registerBody }, 30_000);
  let out = null;
  for (let tries = 0; tries < 3; tries++) {
    out = await attempt();
    // Definitive automation answer (2xx/4xx). 5xx and synthetic transport
    // 503s are ambiguous: the registration is idempotent (same asset_id,
    // byte-identical content dedupe), so retrying is safe.
    if (out.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (tries + 1)));
  }
  if (out.status >= 200 && out.status < 300) {
    // A retry after a committed-but-lost response comes back as a
    // "duplicate" of our own asset id: that is a successful registration and
    // the file must be kept.
    if (out.body && out.body.duplicate && out.body.asset_id === assetId) {
      return { outcome: 'created', status: 201, body: { ...out.body, created: true, duplicate: false } };
    }
    return { outcome: out.body && out.body.duplicate ? 'duplicate' : 'created', status: out.status, body: out.body };
  }
  if (out.status >= 400 && out.status < 500) return { outcome: 'rejected', status: out.status, body: out.body };
  // Still ambiguous after retries: ask the catalog directly.
  for (let tries = 0; tries < 2; tries++) {
    const lookup = await automationFetch(`/internal/catalog/assets/${assetId}`, {}, 5000);
    if (lookup.status === 200) return { outcome: 'created', status: 201, body: { created: true, duplicate: false, asset_id: assetId, title: lookup.body.title, duration_ms: lookup.body.duration_ms } };
    if (lookup.status === 404) return { outcome: 'rejected', status: 503, body: { error: { code: 'UPLOAD_NOT_ACCEPTED', message: 'automation did not accept the upload before becoming unreachable; the file was rolled back' } } };
  }
  return { outcome: 'unresolved', status: 502, body: { error: { code: 'UPLOAD_UNRESOLVED', message: 'automation became unreachable; the upload is kept and will be reconciled automatically', asset_id: assetId } } };
}

/** Copies only allowlisted query params onto the internal automation URL. */
function passQuery(url, allowed) {
  const qs = new URLSearchParams();
  for (const name of allowed) {
    const value = url.searchParams.get(name);
    if (value !== null && value !== '') qs.set(name, value.slice(0, 256));
  }
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : '';
}

const AUDIO_ERROR_BODY_MAX = 16 * 1024;
const AUDIO_MAX_BYTES = 512 * 1024 * 1024;

/** Read only enough of a rejected response to recover a small structured code,
 * then cancel. The upstream body is never forwarded and cannot consume
 * unbounded memory/bandwidth. */
async function discardAudioError(upstream) {
  if (!upstream.body) return {};
  const reader = upstream.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes <= AUDIO_ERROR_BODY_MAX) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes <= AUDIO_ERROR_BODY_MAX) chunks.push(Buffer.from(value));
    }
  } catch { /* a rejected upstream body is disposable */ }
  finally { await reader.cancel().catch(() => {}); }
  if (bytes > AUDIO_ERROR_BODY_MAX) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function projectAudioError(status, body) {
  const code = body && body.error && body.error.code;
  if (status === 404 || code === 'ASSET_NOT_FOUND') {
    return { status: 404, body: { error: { code: 'ASSET_NOT_FOUND', message: SAFE_AUTOMATION_ERRORS.ASSET_NOT_FOUND } } };
  }
  if (status === 416 || code === 'RANGE_NOT_SATISFIABLE') {
    return { status: 416, body: { error: { code: 'RANGE_NOT_SATISFIABLE', message: SAFE_AUTOMATION_ERRORS.RANGE_NOT_SATISFIABLE } } };
  }
  if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
    return { status: 400, body: { error: { code: 'AUDIO_PREVIEW_REJECTED', message: SAFE_AUTOMATION_ERRORS.AUDIO_PREVIEW_REJECTED } } };
  }
  return { status: 502, body: { error: { code: 'AUDIO_PREVIEW_UNAVAILABLE', message: SAFE_AUTOMATION_ERRORS.AUDIO_PREVIEW_UNAVAILABLE } } };
}

/** Validate and normalize the only headers an audio body is allowed to carry.
 * Returns null for malformed/oversized metadata, before any body is streamed. */
function safeAudioHeaders(upstream) {
  if (upstream.status !== 200 && upstream.status !== 206) return null;
  const contentType = String(upstream.headers.get('content-type') || '').toLowerCase().split(';', 1)[0].trim();
  if (contentType !== 'audio/mpeg' && contentType !== 'audio/mp3') return null;
  const lengthText = upstream.headers.get('content-length');
  if (!/^(?:0|[1-9]\d{0,11})$/.test(lengthText || '')) return null;
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length) || length <= 0 || length > AUDIO_MAX_BYTES) return null;
  const acceptRanges = upstream.headers.get('accept-ranges');
  if (acceptRanges !== null && acceptRanges.toLowerCase() !== 'bytes') return null;
  const contentRange = upstream.headers.get('content-range');
  const headers = { 'content-type': 'audio/mpeg', 'content-length': String(length) };
  if (upstream.status === 206) {
    const match = contentRange && contentRange.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === '*' ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end - start + 1 !== length
      || (total !== null && (!Number.isSafeInteger(total) || total <= end || total > AUDIO_MAX_BYTES))) return null;
    headers['content-range'] = `bytes ${start}-${end}/${total === null ? '*' : total}`;
    headers['accept-ranges'] = 'bytes';
  } else {
    if (contentRange !== null) return null;
    if (acceptRanges && acceptRanges.toLowerCase() === 'bytes') headers['accept-ranges'] = 'bytes';
  }
  return headers;
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

const UI = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

/**
 * Defense-in-depth CSP (escaping remains the primary control): only the
 * page's own nonce'd script may run, so injected inline handlers/scripts are
 * dead even if markup escaping ever regressed. Inline styles + Google Fonts
 * stay allowed because the UI uses both.
 */
const cspFor = (nonce) => [
  "default-src 'none'",
  `script-src 'nonce-${nonce}'`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "media-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://admin');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': cspFor(nonce),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      return res.end(UI.replaceAll('__CSP_NONCE__', nonce));
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

    // Cross-origin browser mutations are rejected across the whole admin API
    // (uploads, deletes, rerun/skin/automation controls, bodyless skips, …).
    if (req.method !== 'GET' && p.startsWith('/api/') && !sameOriginOk(req)) {
      send(res, 403, { error: 'cross-origin request rejected' });
      req.destroy(); // do not consume a body we will never use
      return;
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

    // web-player skin policy (proxied; the bot remains the sole web writer)
    if (req.method === 'POST' && p === '/api/skin') {
      const body = await readBody(req);
      const out = await botFetch('/skin', { method: 'POST', body: body || '{}' });
      return send(res, out.status, out.body);
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

    // --- automation (asset library / queue / DJ / hotline moderation) ---
    // Fixed allowlist proxy: each browser-facing route maps to exactly one
    // internal automation route. No generic pass-through exists on purpose.
    if (req.method === 'GET' && p === '/api/automation/queue') {
      const out = projected(await automationFetch('/internal/queue/snapshot'), projectQueue);
      return send(res, out.status, out.body);
    }
    if (req.method === 'GET' && p === '/api/automation/catalog') {
      const out = projected(await automationFetch('/internal/admin/catalog' + passQuery(url, ['search', 'cursor', 'limit', 'status'])), projectCatalog);
      return send(res, out.status, out.body);
    }
    if (req.method === 'GET' && p === '/api/automation/dj') {
      const out = projected(await automationFetch('/internal/dj/status'), projectDj);
      return send(res, out.status, out.body);
    }
    if (req.method === 'GET' && p === '/api/automation/history') {
      const out = projected(await automationFetch('/internal/history' + passQuery(url, ['limit'])), projectHistory);
      return send(res, out.status, out.body);
    }
    if (req.method === 'GET' && p === '/api/automation/hotline') {
      const out = projected(await automationFetch('/internal/hotline/review' + passQuery(url, ['cursor', 'limit'])), projectHotline);
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && p === '/api/automation/queue/track') {
      const out = projected(await automationFetch('/internal/queue/tracks', { method: 'POST', body: await readProxyBody(req) }), projectEnqueue);
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && p === '/api/automation/queue/commentary') {
      const out = projected(await automationFetch('/internal/queue/commentary', { method: 'POST', body: await readProxyBody(req) }), projectEnqueue);
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && p === '/api/automation/hotline/review') {
      const out = projected(await automationFetch('/internal/hotline/review', { method: 'POST', body: await readProxyBody(req) }), projectReview);
      return send(res, out.status, out.body);
    }

    // Asset preview by immutable ID only (never a path); Range passes through.
    const assetAudio = p.match(/^\/api\/automation\/assets\/(ast_[a-f0-9]{32})\/audio$/);
    if (req.method === 'GET' && assetAudio) {
      if (!AUTOMATION_TOKEN) return send(res, 503, automationUnavailable('automation is not configured on this box', 'AUTOMATION_NOT_CONFIGURED').body);
      let upstream;
      try {
        const headers = { authorization: `Bearer ${AUTOMATION_TOKEN}` };
        if (req.headers.range) headers.range = String(req.headers.range).slice(0, 100);
        upstream = await fetch(`${AUTOMATION_API}/internal/catalog/assets/${assetAudio[1]}/audio`, {
          headers,
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        return send(res, 502, { error: { code: 'AUDIO_PREVIEW_UNAVAILABLE', message: SAFE_AUTOMATION_ERRORS.AUDIO_PREVIEW_UNAVAILABLE } });
      }
      if (!upstream.ok) {
        const safe = projectAudioError(upstream.status, await discardAudioError(upstream));
        return send(res, safe.status, safe.body);
      }
      const passHeaders = safeAudioHeaders(upstream);
      if (!passHeaders || !upstream.body) {
        if (upstream.body) await upstream.body.cancel().catch(() => {});
        return send(res, 502, { error: { code: 'AUDIO_PREVIEW_INVALID', message: SAFE_AUTOMATION_ERRORS.AUDIO_PREVIEW_INVALID } });
      }
      res.writeHead(upstream.status, passHeaders);
      const stream = Readable.fromWeb(upstream.body);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      return stream.pipe(res);
    }

    // Streamed MP3 upload into the durable asset library. Bytes stage under
    // music/originals/.staging on the same filesystem, rename atomically to a
    // server-generated immutable name, then automation probes and registers.
    // The original filename is untrusted metadata only, never a path.
    if (req.method === 'PUT' && p === '/api/automation/upload') {
      if (!AUTOMATION_TOKEN) return send(res, 503, automationUnavailable('automation is not configured on this box', 'AUTOMATION_NOT_CONFIGURED').body);
      // Concurrency slot first: bounds simultaneous streams and the ffprobe
      // work automation performs per registration.
      if (uploadsActive >= UPLOAD_MAX_CONCURRENT) {
        send(res, 429, { error: `another upload is in progress (max ${UPLOAD_MAX_CONCURRENT} concurrent)` });
        req.destroy();
        return;
      }
      uploadsActive += 1;
      let reservedBytes = 0;
      const meta = {
        title: (url.searchParams.get('title') || '').slice(0, 256).trim(),
        artist: (url.searchParams.get('artist') || '').slice(0, 256).trim(),
        tags: (url.searchParams.get('tags') || '').split(',').map((t) => t.trim().slice(0, 48)).filter(Boolean).slice(0, 20),
        original: path.basename(url.searchParams.get('filename') || '').slice(0, 200).trim(),
      };
      const assetId = 'ast_' + crypto.randomUUID().replaceAll('-', '');
      const tmp = path.join(STAGING_DIR, `${assetId}.part`);
      const final = path.join(ORIGINALS, `${assetId}.mp3`);
      try {
        // Resolve any earlier ambiguous registrations before consuming more
        // staging budget (also prunes orphans once automation is back).
        await reconcileUnresolvedUploads();
        const journaledBytes = unresolvedBytes(await readUnresolved());
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > UPLOAD_MAX_BYTES) { const err = new Error(`upload exceeds the ${Math.floor(UPLOAD_MAX_BYTES / 1048576)} MB cap`); err.statusCode = 413; throw err; }
        if (declared && stagingBytesActive + journaledBytes + declared > STAGING_MAX_BYTES) { const err = new Error('staging area is full — try again shortly'); err.statusCode = 507; throw err; }
        await fsp.mkdir(STAGING_DIR, { recursive: true, mode: 0o700 });
        let bytes = 0;
        await new Promise((resolve, reject) => {
          // 'wx' + server-generated name: no overwrite, no traversal, no
          // client-controlled path component anywhere.
          const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
          let aborted = false;
          const abort = (message, statusCode) => {
            if (aborted) return;
            aborted = true;
            req.unpipe(out);
            out.destroy();
            const err = new Error(message);
            err.statusCode = statusCode;
            reject(err);
          };
          out.on('error', reject);
          out.on('finish', resolve);
          req.on('error', reject);
          req.on('data', (chunk) => {
            bytes += chunk.length;
            stagingBytesActive += chunk.length;
            reservedBytes += chunk.length;
            if (bytes > UPLOAD_MAX_BYTES) abort(`upload exceeds the ${Math.floor(UPLOAD_MAX_BYTES / 1048576)} MB cap`, 413);
            else if (stagingBytesActive + journaledBytes > STAGING_MAX_BYTES) abort('staging area is full — try again shortly', 507);
          });
          req.pipe(out);
        });
        if (bytes === 0) { const err = new Error('upload is empty'); err.statusCode = 400; throw err; }
        await fsp.rename(tmp, final);
      } catch (error) {
        await fsp.rm(tmp, { force: true });
        stagingBytesActive -= reservedBytes;
        uploadsActive -= 1;
        // Tagged errors carry our own fixed messages; anything else (fs
        // errors etc.) may embed private paths and stays generic.
        send(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'upload failed' });
        req.destroy();
        return;
      }
      try {
        const reg = await registerUploadWithReconciliation(assetId, JSON.stringify({
          asset_id: assetId,
          title: meta.title || undefined,
          artist: meta.artist || undefined,
          tags: meta.tags,
          original_filename: meta.original || undefined,
        }));
        // File policy by definitive outcome:
        //   created    → the file IS the catalog copy: keep.
        //   duplicate  → identical bytes already cataloged under another id:
        //                delete the redundant staged copy.
        //   rejected   → automation definitively refused (probe failure,
        //                validation, or confirmed-absent after outage): delete.
        //   unresolved → automation may have committed; keep the bytes and
        //                journal the id for reconciliation. Never delete here.
        if (reg.outcome === 'duplicate' || reg.outcome === 'rejected') {
          await fsp.rm(final, { force: true });
        } else if (reg.outcome === 'unresolved') {
          await addUnresolved(assetId, { bytes: reservedBytes, at: new Date().toISOString() });
        }
        const responseBody = reg.outcome === 'created' || reg.outcome === 'duplicate'
          ? projectUpload(reg.body)
          : projectError(reg.body);
        return send(res, reg.status, responseBody);
      } finally {
        stagingBytesActive -= reservedBytes;
        uploadsActive -= 1;
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (error) {
    // Automation-facing routes never leak raw internal messages; tagged
    // errors (our own fixed strings) pass through everywhere.
    const generic = !error.statusCode && String(req.url || '').startsWith('/api/automation/');
    send(res, error.statusCode || 500, { error: generic ? 'internal error' : error.message });
  }
});

fs.mkdirSync(VOICEMAILS, { recursive: true });
// Best-effort: the originals library lives under the (read-write) music
// mount; if it is missing or read-only, uploads fail per-request instead.
try { fs.mkdirSync(ORIGINALS, { recursive: true }); } catch { /* uploads report the failure */ }

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`[admin] control room on :${PORT} (bot api: ${BOT_API})`));
  // Transcribe any pre-existing voicemails once the server is settled.
  setTimeout(() => void transcribeBackfill(), 10_000);
  // Resolve any uploads whose registration outcome was lost mid-flight.
  if (AUTOMATION_TOKEN) setTimeout(() => void reconcileUnresolvedUploads().catch(() => {}), 5000);
}

module.exports = { server, reconcileUnresolvedUploads };

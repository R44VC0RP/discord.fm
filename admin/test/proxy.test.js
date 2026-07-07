'use strict';

/**
 * Admin server automation proxy + upload tests. A fake automation service
 * stands in for the real one; the admin server is booted once with the token
 * configured. Covers: allowlist, token non-leak, status preservation, body
 * caps, upload atomicity/duplicates/probe-failure/size cap, range proxying.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { tempDirs, createFakeAutomation, startAdmin } = require('./helpers.js');

const TOKEN = 'unit-test-automation-token-do-not-leak';
let fake;
let admin;
let root;
const ORIGINALS = () => path.join(root, 'music', 'originals');
const STAGING = () => path.join(ORIGINALS(), '.staging');

before(async () => {
  root = tempDirs();
  fake = createFakeAutomation();
  const fakePort = await fake.listen();
  process.env.RECORDING_DIR = path.join(root, 'recordings');
  process.env.MUSIC_DIR = path.join(root, 'music');
  process.env.VOICEMAIL_DIR = path.join(root, 'voicemails');
  process.env.WEB_DIR = path.join(root, 'web');
  process.env.BOT_API = 'http://127.0.0.1:1';
  process.env.AUTOMATION_API = `http://127.0.0.1:${fakePort}`;
  process.env.AUTOMATION_INTERNAL_TOKEN = TOKEN;
  process.env.UPLOAD_MAX_BYTES = String(1024 * 1024); // clamp floor: 1 MB
  process.env.UPLOAD_MAX_CONCURRENT = '4';
  process.env.STAGING_MAX_BYTES = String(1024 * 1024); // == UPLOAD_MAX_BYTES clamp
  admin = await startAdmin();
});

after(async () => {
  await new Promise((resolve) => admin.server.close(() => resolve()));
  await fake.close().catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
});

test('GET proxies map to exactly one internal route and never leak the token', async () => {
  fake.calls.length = 0;
  const routes = [
    ['/api/automation/queue', '/internal/queue/snapshot'],
    ['/api/automation/dj', '/internal/dj/status'],
    ['/api/automation/hotline', '/internal/hotline/review'],
    ['/api/automation/history?limit=25', '/internal/history'],
    ['/api/automation/catalog?search=night&limit=5', '/internal/admin/catalog'],
  ];
  for (const [publicPath, internalPath] of routes) {
    const res = await fetch(admin.origin + publicPath);
    assert.equal(res.status, 200, publicPath);
    const text = await res.text();
    assert.ok(!text.includes(TOKEN), `token leaked in body of ${publicPath}`);
    for (const [name, value] of res.headers) assert.ok(!String(value).includes(TOKEN), `token leaked in header ${name}`);
    const call = fake.calls.at(-1);
    assert.equal(call.path, internalPath);
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  }
});

test('browser responses are rebuilt from field allowlists: no worker/lease/run/internal ids, locators, checksums, or secrets', async () => {
  const forbiddenKeys = /"(worker_id|owner|run_id|opencode_session_id|cue_id|group_id|claim_token|locator|content_sha256|checksum|internal_note|internal_url|transcript_private|call_sid|private_hint|observed_at)"/;
  const forbiddenValues = /SECRET|deadbeef|\/music\/originals|CA_SECRET|djrun_|ses_|worker_bot|cue_internal|grp_internal|ast_internal/;
  const scan = (label, text) => {
    assert.doesNotMatch(text, forbiddenKeys, `${label}: internal key leaked`);
    assert.doesNotMatch(text, forbiddenValues, `${label}: internal value leaked`);
  };
  for (const p of ['/api/automation/queue', '/api/automation/dj', '/api/automation/hotline', '/api/automation/history', '/api/automation/catalog']) {
    const res = await fetch(admin.origin + p);
    assert.equal(res.status, 200, p);
    scan(p, await res.text());
  }
  // Spot-check the useful fields survive projection.
  const queue = await (await fetch(admin.origin + '/api/automation/queue')).json();
  assert.equal(queue.queue_revision, 7);
  assert.equal(queue.cues[0].public_metadata.title, 'Track');
  assert.equal(queue.presence.humans, 0);
  const dj = await (await fetch(admin.origin + '/api/automation/dj')).json();
  assert.equal(dj.lease.held, true); // boolean replaces the owner id
  assert.equal(dj.last_run.state, 'COMPLETED');
  assert.deepEqual(dj.tools, ['list_tracks']);
  const hotline = await (await fetch(admin.origin + '/api/automation/hotline')).json();
  assert.equal(hotline.items[0].transcript, 'redacted text');
  assert.equal(hotline.items[0].candidate_id, 'callcand_1');
  // Mutation responses are projected too.
  const track = await fetch(admin.origin + '/api/automation/queue/track', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asset_id: 'ast_x', expected_queue_revision: 7, idempotency_key: 'proj1' }),
  });
  const trackBody = await track.text();
  scan('queue/track response', trackBody);
  assert.deepEqual(JSON.parse(trackBody), { accepted: true, queue_revision: 8, state: 'READY' });
});

test('asset retire/restore use fixed proxy routes, preserve status, and strip private fields', async () => {
  const id = 'ast_' + 'a'.repeat(32);
  for (const action of ['retire', 'restore']) {
    fake.calls.length = 0;
    const res = await fetch(`${admin.origin}/api/automation/assets/${id}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: admin.origin },
      body: JSON.stringify({ expected_queue_revision: 7, idempotency_key: `asset:${action}` }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { accepted: true, asset_id: id, status: action === 'retire' ? 'RETIRED' : 'READY', queue_revision: 8, canceled_cues: action === 'retire' ? 2 : 0 });
    const call = fake.calls.at(-1);
    assert.equal(call.path, `/internal/admin/catalog/assets/${id}/${action}`);
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(call.body), { expected_queue_revision: 7, idempotency_key: `asset:${action}` });
  }

  const key = `POST /internal/admin/catalog/assets/${id}/retire`;
  fake.override(key, (call, res) => fake.json(res, 409, { error: { code: 'ASSET_ACTIVE', message: 'SECRET /music/private.mp3' } }));
  try {
    const blocked = await fetch(`${admin.origin}/api/automation/assets/${id}/retire`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_queue_revision: 8, idempotency_key: 'blocked' }),
    });
    assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), { error: { code: 'ASSET_ACTIVE', message: 'the asset or its atomic queue group is claimed or playing' } });
  } finally { fake.clearOverride(key); }

  fake.calls.length = 0;
  const malformed = await fetch(`${admin.origin}/api/automation/assets/ast_..%2Fsecret/retire`, { method: 'POST', body: '{}' });
  assert.equal(malformed.status, 404); assert.equal(fake.calls.length, 0);
});

test('asset UI exposes confirmed keyboard buttons without delete controls or unsafe interpolation', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui.html'), 'utf8');
  assert.match(ui, /data-assetact="retire"/u); assert.match(ui, /data-assetact="restore"/u);
  assert.match(ui, /The audio bytes will be retained/u); assert.match(ui, /queued but unplayed cue/u);
  assert.match(ui, /path safety, checksum, and decodability/u);
  assert.match(ui, /aria-label="archive/u); assert.match(ui, /aria-label="restore/u);
  assert.match(ui, /escAttr\(a\.title \|\| a\.asset_id\)/u);
  assert.doesNotMatch(ui, /data-assetact="delete"|\/assets\/.*\/delete/u);
});

test('rerun UI labels automation versus legacy ownership and sends versioned idempotent toggles', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui.html'), 'utf8');
  assert.match(ui, /automationReruns \? 'AUTOMATION' : 'LEGACY'/u);
  assert.match(ui, /body\.expected_version = rerun\.control_version/u);
  assert.match(ui, /body\.idempotency_key = 'rerun-auto:' \+ crypto\.randomUUID\(\)/u);
  assert.match(ui, /explicit operator queue still bypasses OFF/u);
  assert.match(ui, /aria-pressed/u);
  assert.match(ui, /rerunAvailable \|\| !rerun\.playing/u);
});

test('rerun browser projection keeps only bounded control fields', () => {
  const projected = admin.module.projectRerun({
    owner: 'automation', available: true, auto: false, control_version: 4, manual_bypasses_auto: true,
    playing: 'session-2026-01-01T00-00-00.mp3', position: 12,
    queue: ['session-2026-01-02T00-00-00.mp3', '../SECRET.mp3'],
    nextUp: 'session-2026-01-02T00-00-00.mp3', waitSeconds: 30, cycle: { played: 1, total: 2 },
    worker_id: 'SECRET', claim_token: 'SECRET', locator: '/recordings/SECRET', nested: { secret: 'SECRET' },
  });
  assert.deepEqual(projected.queue, ['session-2026-01-02T00-00-00.mp3']);
  assert.equal(projected.owner, 'automation'); assert.equal(projected.control_version, 4);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|worker|claim|locator/u);
});

test('DJ successful projection recursively strips poisoned provider errors, diagnostics, paths, tokens, and run details', async () => {
  const poison = 'Bearer SECRET_TOKEN /private/provider/body opencode_session_SECRET';
  fake.override('GET /internal/dj/status', (call, res) => fake.json(res, 200, {
    mode: 'LIVE', model: poison,
    flags: { dj_enabled: true, playout_enabled: false, nested: { diagnostic: poison } },
    opencode: {
      healthy: false, status: 'UNREACHABLE', version: '1.17.13-SECRET_TOKEN', error: poison,
      provider: { response: { body: poison, token: poison, paths: ['/scratch/work'] } },
    },
    lease: { owner: poison, failure_count: 2, last_result: poison, backoff_until: '2026-07-06T00:00:00Z', diagnostic: { body: poison } },
    last_run: {
      state: 'FAILED', failure_code: poison, tool_calls: 4, input_tokens: 10, output_tokens: 20,
      estimated_cost_usd: 0.01, started_at: '2026-07-06T00:00:00Z', completed_at: '2026-07-06T00:00:30Z',
      run_id: poison, opencode_session_id: poison, provider_body: { recursive: [{ error: poison }] },
    },
    daily: { tool_calls: 4, tool_call_limit: 200, model_tokens: 30, model_token_limit: 1000, tts_characters: 0, tts_character_limit: 100 },
    watermarks: { low_count: 12, high_count: 24, low_duration_ms: 100, target_duration_ms: 200, max_duration_ms: 300 },
    tools: ['list_tracks', poison, { error: poison }],
    diagnostics: { arbitrary: [{ deeply: { poisoned: poison } }] },
  }));
  try {
    const res = await fetch(admin.origin + '/api/automation/dj');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /SECRET|private|provider|scratch|session/u);
    const body = JSON.parse(text);
    assert.deepEqual(body.opencode, {
      healthy: false, status: 'UNAVAILABLE', version: null, message_code: 'OPENCODE_UNAVAILABLE',
    });
    assert.deepEqual(body.last_run, { state: 'FAILED', message_code: 'DJ_RUN_FAILED' });
    assert.equal(body.lease.last_result, null);
    assert.deepEqual(body.tools, ['list_tracks']);
    assert.equal(Object.hasOwn(body, 'model'), false);
  } finally {
    fake.clearOverride('GET /internal/dj/status');
  }
});

test('DJ safe status labels zero daily limits as unlimited', async () => {
  fake.override('GET /internal/dj/status', (call, res) => fake.json(res, 200, {
    mode: 'LIVE', flags: { dj_enabled: true }, lease: {}, last_run: null,
    daily: { tool_calls: 7, tool_call_limit: 0, model_tokens: 12345, model_token_limit: 0, tts_characters: 456, tts_character_limit: 0 },
    watermarks: {}, tools: [], opencode: { healthy: true, version: '1.17.13' },
  }));
  try {
    const body = await (await fetch(admin.origin + '/api/automation/dj')).json();
    assert.deepEqual(body.daily, {
      tool_calls: 7, tool_call_limit: 'unlimited',
      model_tokens: 12345, model_token_limit: 'unlimited',
      tts_characters: 456, tts_character_limit: 'unlimited',
    });
  } finally {
    fake.clearOverride('GET /internal/dj/status');
  }
});

test('automation error messages are never forwarded: fixed safe text per code, poison stripped recursively', async () => {
  const POISON_MESSAGE = 'ffprobe exited 1: /music/originals/ast_SECRET.mp3: Invalid data found; token=Bearer SECRET_TOKEN worker_bot_SECRET';
  const POISON_DETAILS = { locator: '/music/originals/ast_SECRET.mp3', stderr: 'SECRET_STDERR', content_sha256: 'deadbeef' };
  const poison = /SECRET|ffprobe|\/music\/originals|deadbeef|Invalid data/;

  // Known code: fixed message, no details, status preserved.
  fake.override('POST /internal/catalog/register-upload', (call, res) =>
    fake.json(res, 422, { error: { code: 'PROBE_FAILED', message: POISON_MESSAGE, details: POISON_DETAILS } }));
  try {
    const res = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('poison probe bytes') });
    assert.equal(res.status, 422);
    const text = await res.text();
    assert.doesNotMatch(text, poison);
    assert.deepEqual(JSON.parse(text), { error: { code: 'PROBE_FAILED', message: 'the uploaded file is not decodable MP3 audio' } });
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
  }

  // Conflict code on a mutation: code + status preserved, message replaced.
  fake.override('POST /internal/queue/tracks', (call, res) =>
    fake.json(res, 409, { error: { code: 'REVISION_CONFLICT', message: POISON_MESSAGE, details: { expected: 1, actual: 2, ...POISON_DETAILS } } }));
  try {
    const res = await fetch(admin.origin + '/api/automation/queue/track', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset_id: 'ast_x', expected_queue_revision: 1, idempotency_key: 'poison1' }),
    });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.doesNotMatch(text, poison);
    assert.equal(JSON.parse(text).error.code, 'REVISION_CONFLICT');
    assert.match(JSON.parse(text).error.message, /queue changed/u);
  } finally {
    fake.clearOverride('POST /internal/queue/tracks');
  }

  // Unknown/hostile codes collapse to a generic envelope on every GET proxy.
  for (const p of ['/api/automation/queue', '/api/automation/dj', '/api/automation/hotline', '/api/automation/catalog', '/api/automation/history']) {
    const internal = { '/api/automation/queue': 'GET /internal/queue/snapshot', '/api/automation/dj': 'GET /internal/dj/status', '/api/automation/hotline': 'GET /internal/hotline/review', '/api/automation/catalog': 'GET /internal/admin/catalog', '/api/automation/history': 'GET /internal/history' }[p];
    fake.override(internal, (call, res) => fake.json(res, 500, { error: { code: '<img onerror=x>', message: POISON_MESSAGE, details: POISON_DETAILS } }));
    try {
      const res = await fetch(admin.origin + p);
      assert.equal(res.status, 500, p);
      const text = await res.text();
      assert.doesNotMatch(text, poison, p);
      assert.deepEqual(JSON.parse(text), { error: { code: 'AUTOMATION_ERROR', message: 'automation request failed' } }, p);
    } finally {
      fake.clearOverride(internal);
    }
  }

  // Validation-family codes get the invalid-request message without details.
  fake.override('POST /internal/queue/commentary', (call, res) =>
    fake.json(res, 400, { error: { code: 'UNKNOWN_FIELDS', message: POISON_MESSAGE, details: { fields: ['locator'] } } }));
  try {
    const res = await fetch(admin.origin + '/api/automation/queue/commentary', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: { code: 'UNKNOWN_FIELDS', message: 'automation rejected the request as invalid' } });
  } finally {
    fake.clearOverride('POST /internal/queue/commentary');
  }
});

test('catalog proxy forwards only allowlisted query params', async () => {
  fake.calls.length = 0;
  const res = await fetch(admin.origin + '/api/automation/catalog?search=abc&limit=9&cursor=ast_1&status=READY&evil=1&token=x');
  assert.equal(res.status, 200);
  assert.deepEqual(fake.calls.at(-1).query, { search: 'abc', limit: '9', cursor: 'ast_1', status: 'READY' });
});

test('unknown automation paths are 404: there is no generic proxy', async () => {
  fake.calls.length = 0;
  for (const p of ['/api/automation/maintenance/backup', '/api/automation/queue/refill', '/api/automation/../internal/queue/tracks', '/api/automation/dj/capture']) {
    const res = await fetch(admin.origin + p, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404, p);
  }
  assert.equal(fake.calls.length, 0, 'no request reached automation');
});

test('mutation proxies preserve automation status codes and error bodies', async () => {
  fake.override('POST /internal/queue/tracks', (call, res) =>
    fake.json(res, 409, { error: { code: 'REVISION_CONFLICT', message: 'queue revision is stale' } }));
  try {
    const res = await fetch(admin.origin + '/api/automation/queue/track', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset_id: 'ast_x', expected_queue_revision: 3, idempotency_key: 'k1' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'REVISION_CONFLICT');
  } finally {
    fake.clearOverride('POST /internal/queue/tracks');
  }
  // happy path forwards the body verbatim
  fake.calls.length = 0;
  const ok = await fetch(admin.origin + '/api/automation/queue/commentary', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script: 'hello anomaly', expected_queue_revision: 7, idempotency_key: 'k2' }),
  });
  assert.equal(ok.status, 202);
  assert.deepEqual(JSON.parse(fake.calls.at(-1).body), { script: 'hello anomaly', expected_queue_revision: 7, idempotency_key: 'k2' });
});

test('hotline review proxy forwards the body to the internal review route', async () => {
  fake.calls.length = 0;
  const res = await fetch(admin.origin + '/api/automation/hotline/review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidate_id: 'callcand_x', action: 'reject', expected_moderation_version: 1, idempotency_key: 'k3' }),
  });
  assert.equal(res.status, 200);
  assert.equal(fake.calls.at(-1).path, '/internal/hotline/review');
  assert.equal(JSON.parse(fake.calls.at(-1).body).action, 'reject');
});

test('proxy bodies are capped and must be JSON', async () => {
  fake.calls.length = 0;
  const big = await fetch(admin.origin + '/api/automation/queue/commentary', {
    method: 'POST', body: 'x'.repeat(17 * 1024),
  });
  assert.equal(big.status, 413);
  const notJson = await fetch(admin.origin + '/api/automation/queue/track', { method: 'POST', body: 'not json' });
  assert.equal(notJson.status, 400);
  assert.equal(fake.calls.length, 0, 'invalid bodies never reach automation');
});

test('upload streams to staging, renames atomically, and registers through automation', async () => {
  fake.calls.length = 0;
  const bytes = Buffer.from('fake mp3 payload for upload');
  const res = await fetch(admin.origin + '/api/automation/upload?' + new URLSearchParams({
    title: 'Night Drive', artist: 'Uploader', tags: 'ambient, night ,', filename: '../..//weird name.mp3',
  }), { method: 'PUT', body: bytes });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.asset_id, /^ast_[a-f0-9]{32}$/);
  const registered = JSON.parse(fake.calls.at(-1).body);
  assert.equal(registered.asset_id, body.asset_id);
  assert.equal(registered.title, 'Night Drive');
  assert.deepEqual(registered.tags, ['ambient', 'night']);
  assert.equal(registered.original_filename, 'weird name.mp3', 'original filename is basename-only metadata');
  const final = path.join(ORIGINALS(), `${body.asset_id}.mp3`);
  assert.deepEqual(fs.readFileSync(final), bytes);
  assert.deepEqual(fs.readdirSync(STAGING()), [], 'staging directory is empty after rename');
});

test('duplicate uploads keep the original asset and remove the staged copy', async () => {
  fake.override('POST /internal/catalog/register-upload', (call, res) =>
    fake.json(res, 200, { created: false, duplicate: true, asset_id: 'ast_' + 'f'.repeat(32), title: 'Original', duration_ms: 1234 }));
  try {
    const beforeFiles = fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3'));
    const res = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('fake mp3 payload for upload') });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, true);
    const afterFiles = fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3'));
    assert.deepEqual(afterFiles, beforeFiles, 'duplicate staged bytes were deleted');
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
  }
});

test('probe failure removes the staged file and forwards the error', async () => {
  fake.override('POST /internal/catalog/register-upload', (call, res) =>
    fake.json(res, 422, { error: { code: 'PROBE_FAILED', message: 'uploaded audio is not decodable' } }));
  try {
    const before = fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3'));
    const res = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('garbage bytes') });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'PROBE_FAILED');
    assert.deepEqual(fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3')), before);
    assert.deepEqual(fs.readdirSync(STAGING()), []);
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
  }
});

test('uploads above the size cap are rejected and leave no bytes behind', async () => {
  const before = fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3'));
  const res = await fetch(admin.origin + '/api/automation/upload', {
    method: 'PUT', body: Buffer.alloc(2 * 1024 * 1024, 1),
  }).catch(() => null);
  // The server may cut the connection mid-body (413) or the client may see a
  // reset; either way no staged or final file survives.
  if (res) assert.equal(res.status, 413);
  assert.deepEqual(fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3')), before);
  assert.deepEqual(fs.readdirSync(STAGING()), []);
  // The deliberate mid-upload socket destroy can complete just after fetch()
  // rejects on macOS. Let the server finish closing that connection before the
  // next Range-proxy test reuses the local HTTP pool.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('empty uploads are rejected', async () => {
  const res = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.alloc(0) });
  assert.equal(res.status, 400);
  assert.deepEqual(fs.readdirSync(STAGING()), []);
});

test('asset audio proxy accepts immutable ids only and passes Range through', async () => {
  fake.calls.length = 0;
  const goodId = 'ast_' + 'a'.repeat(32);
  const full = await fetch(`${admin.origin}/api/automation/assets/${goodId}/audio`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await full.arrayBuffer()).byteLength, 100);

  const ranged = await fetch(`${admin.origin}/api/automation/assets/${goodId}/audio`, { headers: { range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  assert.equal(fake.calls.at(-1).headers.range, 'bytes=0-9');

  fake.calls.length = 0;
  for (const bad of ['ast_../secret', 'ast_' + 'a'.repeat(31), 'anything', encodeURIComponent('/etc/passwd')]) {
    const res = await fetch(`${admin.origin}/api/automation/assets/${bad}/audio`);
    assert.equal(res.status, 404, bad);
  }
  assert.equal(fake.calls.length, 0, 'malformed asset ids never reach automation');
});

test('asset audio proxy replaces poisoned 4xx/5xx and huge bodies/headers with fixed JSON', async () => {
  const id = 'ast_' + 'b'.repeat(32);
  const key = `GET /internal/catalog/assets/${id}/audio`;
  const poison = 'Bearer SECRET_AUDIO_TOKEN /music/originals/private.mp3 provider diagnostic';
  const cases = [
    { upstream: 404, expected: 404, code: 'ASSET_NOT_FOUND', huge: false },
    { upstream: 416, expected: 416, code: 'RANGE_NOT_SATISFIABLE', huge: false },
    { upstream: 422, expected: 400, code: 'AUDIO_PREVIEW_REJECTED', huge: false },
    { upstream: 500, expected: 502, code: 'AUDIO_PREVIEW_UNAVAILABLE', huge: true },
  ];
  try {
    for (const item of cases) {
      fake.override(key, (call, res) => {
        res.writeHead(item.upstream, {
          'content-type': 'audio/mpeg',
          'content-disposition': `attachment; filename="${poison}"`,
          'x-private-diagnostic': poison,
          'accept-ranges': 'bytes',
        });
        if (item.huge) return res.end(Buffer.concat([Buffer.from(poison), Buffer.alloc(2 * 1024 * 1024, 65)]));
        return res.end(JSON.stringify({ error: { code: item.code, message: poison, details: { token: poison, path: poison } } }));
      });
      const res = await fetch(`${admin.origin}/api/automation/assets/${id}/audio`);
      assert.equal(res.status, item.expected);
      assert.equal(res.headers.get('content-type'), 'application/json');
      assert.equal(res.headers.get('content-disposition'), null);
      assert.equal(res.headers.get('x-private-diagnostic'), null);
      const text = await res.text();
      assert.doesNotMatch(text, /SECRET|\/music\/originals|provider|diagnostic/u);
      assert.equal(JSON.parse(text).error.code, item.code);
    }
  } finally {
    fake.clearOverride(key);
  }
});

test('asset audio proxy streams only sane validated 2xx audio metadata', async () => {
  const id = 'ast_' + 'c'.repeat(32);
  const key = `GET /internal/catalog/assets/${id}/audio`;
  const invalid = [
    { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '6', 'content-disposition': 'attachment; filename="SECRET"' } },
    { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '999999999999' } },
    { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-length': '6', 'content-range': 'bytes 0-2/6', 'accept-ranges': 'bytes' } },
    { status: 204, headers: { 'content-type': 'audio/mpeg', 'content-length': '6' } },
  ];
  try {
    for (const item of invalid) {
      fake.override(key, (call, res) => { res.writeHead(item.status, item.headers); res.end('SECRET'); });
      const response = await fetch(`${admin.origin}/api/automation/assets/${id}/audio`);
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('content-disposition'), null);
      assert.deepEqual(await response.json(), { error: { code: 'AUDIO_PREVIEW_INVALID', message: 'audio preview returned an invalid response' } });
    }
  } finally {
    fake.clearOverride(key);
  }
});

test('a registration committed by automation but with a lost response is reconciled by idempotent retry, never deleted', async () => {
  let attempts = 0;
  fake.override('POST /internal/catalog/register-upload', (call, res) => {
    attempts += 1;
    const body = JSON.parse(call.body || '{}');
    if (attempts === 1) { res.destroy(); return; } // automation committed, response lost
    // Idempotent retry: byte-identical content dedupes to OUR OWN asset id.
    fake.json(res, 200, { created: false, duplicate: true, asset_id: body.asset_id, title: 'Committed', duration_ms: 999 });
  });
  try {
    const res = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('commit-then-timeout bytes') });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual({ created: body.created, duplicate: body.duplicate }, { created: true, duplicate: false });
    assert.equal(attempts, 2, 'exactly one idempotent retry');
    assert.equal(fs.existsSync(path.join(ORIGINALS(), `${body.asset_id}.mp3`)), true, 'committed bytes are kept');
    await fsp.rm(path.join(ORIGINALS(), `${body.asset_id}.mp3`), { force: true });
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
  }
});

test('after ambiguous errors a catalog lookup decides: present keeps the file, absent deletes it', async () => {
  fake.override('POST /internal/catalog/register-upload', (call, res) => fake.json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }));
  // Case A: automation committed (lookup hit) -> success, file kept.
  fake.override('GET /internal/catalog/assets/*', (call, res) => fake.json(res, 200, { asset_id: call.assetId, kind: 'music', status: 'READY', title: 'Recovered', duration_ms: 777 }));
  try {
    const okRes = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('lookup-hit bytes') });
    assert.equal(okRes.status, 201);
    const okBody = await okRes.json();
    assert.equal(okBody.title, 'Recovered');
    assert.equal(fs.existsSync(path.join(ORIGINALS(), `${okBody.asset_id}.mp3`)), true);
    await fsp.rm(path.join(ORIGINALS(), `${okBody.asset_id}.mp3`), { force: true });

    // Case B: automation definitively has no such asset -> orphan removed.
    fake.clearOverride('GET /internal/catalog/assets/*');
    const before = fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3'));
    const badRes = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('lookup-miss bytes') });
    assert.equal(badRes.status, 503);
    assert.deepEqual(fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3')), before, 'unconfirmed bytes rolled back');
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
    fake.clearOverride('GET /internal/catalog/assets/*');
  }
});

test('a fully ambiguous outcome keeps + journals the file, and reconciliation later prunes or adopts it', async () => {
  fake.override('POST /internal/catalog/register-upload', (call, res) => fake.json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }));
  fake.override('GET /internal/catalog/assets/*', (call, res) => fake.json(res, 503, { error: { code: 'UNAVAILABLE', message: 'down' } }));
  let unresolvedId;
  try {
    const res = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('ambiguous bytes') });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'UPLOAD_UNRESOLVED');
    const journal = JSON.parse(fs.readFileSync(path.join(STAGING(), 'unresolved.json'), 'utf8'));
    const ids = Object.keys(journal);
    assert.equal(ids.length, 1);
    unresolvedId = ids[0];
    assert.equal(fs.existsSync(path.join(ORIGINALS(), `${unresolvedId}.mp3`)), true, 'ambiguous bytes are never deleted');
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
    fake.clearOverride('GET /internal/catalog/assets/*');
  }
  // Automation is back and reports the asset was never committed: the next
  // upload's reconciliation pass prunes the orphan (default lookup = 404).
  const next = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('post-outage bytes') });
  assert.equal(next.status, 201);
  const nextBody = await next.json();
  assert.equal(fs.existsSync(path.join(ORIGINALS(), `${unresolvedId}.mp3`)), false, 'orphan pruned after definitive 404');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(STAGING(), 'unresolved.json'), 'utf8')), {}, 'journal cleared');
  await fsp.rm(path.join(ORIGINALS(), `${nextBody.asset_id}.mp3`), { force: true });

  // The adoption direction: a journaled id that IS in the catalog is kept.
  const keptId = 'ast_' + '9'.repeat(32);
  fs.writeFileSync(path.join(ORIGINALS(), `${keptId}.mp3`), 'adopted bytes');
  fs.writeFileSync(path.join(STAGING(), 'unresolved.json'), JSON.stringify({ [keptId]: { bytes: 13, at: new Date().toISOString() } }));
  fake.override('GET /internal/catalog/assets/*', (call, res) => fake.json(res, 200, { asset_id: call.assetId, kind: 'music', status: 'READY', title: 'Adopted', duration_ms: 13 }));
  try {
    await admin.module.reconcileUnresolvedUploads();
    assert.equal(fs.existsSync(path.join(ORIGINALS(), `${keptId}.mp3`)), true, 'committed bytes adopted, not deleted');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(STAGING(), 'unresolved.json'), 'utf8')), {});
  } finally {
    fake.clearOverride('GET /internal/catalog/assets/*');
    await fsp.rm(path.join(ORIGINALS(), `${keptId}.mp3`), { force: true });
  }
});

test('uploads above the concurrency limit get 429 and the slot is always released', async () => {
  fake.override('POST /internal/catalog/register-upload', (call, res) => {
    const body = JSON.parse(call.body || '{}');
    setTimeout(() => fake.json(res, 201, { created: true, duplicate: false, asset_id: body.asset_id, title: 'Slow', duration_ms: 1 }), 400);
  });
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from(`concurrent ${index}`) })));
    const statuses = responses.map((res) => res.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 201, 429]);
    for (const res of responses) if (res.status === 201) await fsp.rm(path.join(ORIGINALS(), `${(await res.json()).asset_id}.mp3`), { force: true });
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
  }
  // Slot released: a follow-up upload succeeds immediately.
  const after2 = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('post-concurrency bytes') });
  assert.equal(after2.status, 201);
  await fsp.rm(path.join(ORIGINALS(), `${(await after2.json()).asset_id}.mp3`), { force: true });
});

test('20 concurrent ambiguous uploads plus reconciliation overlap never lose or duplicate journal entries', async () => {
  const journalPath = path.join(STAGING(), 'unresolved.json');
  const baseline = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : {};
  fake.override('POST /internal/catalog/register-upload', (call, res) => fake.json(res, 503, { error: { code: 'UNAVAILABLE', message: 'poison /private SECRET' } }));
  fake.override('GET /internal/catalog/assets/*', (call, res) => fake.json(res, 503, { error: { code: 'UNAVAILABLE', message: 'still ambiguous' } }));
  try {
    for (let batch = 0; batch < 5; batch++) {
      const uploads = Array.from({ length: 4 }, (_, index) => fetch(admin.origin + '/api/automation/upload', {
        method: 'PUT', body: Buffer.from(`ambiguous stress ${batch}-${index}`),
      }));
      const results = await Promise.all([...uploads, admin.module.reconcileUnresolvedUploads(), admin.module.reconcileUnresolvedUploads()]);
      for (const response of results.slice(0, 4)) {
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, 'UPLOAD_UNRESOLVED');
      }
    }
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const added = Object.keys(journal).filter((id) => !Object.hasOwn(baseline, id));
    assert.equal(added.length, 20);
    assert.equal(new Set(added).size, 20, 'every ambiguous upload appears exactly once');
    for (const id of added) assert.equal(fs.existsSync(path.join(ORIGINALS(), `${id}.mp3`)), true, `${id} bytes retained`);
    assert.deepEqual(fs.readdirSync(STAGING()).filter((name) => name.includes('.tmp-') || name.endsWith('.part')), []);

    // Overlapping definitive reconciles serialize too: catalog hits are
    // adopted, misses are deleted, and no stale writer resurrects entries.
    const adopted = new Set(added.filter((_, index) => index % 2 === 0));
    fake.override('GET /internal/catalog/assets/*', (call, res) => adopted.has(call.assetId)
      ? fake.json(res, 200, { asset_id: call.assetId, status: 'READY' })
      : fake.json(res, 404, { error: { code: 'ASSET_NOT_FOUND' } }));
    await Promise.all(Array.from({ length: 6 }, () => admin.module.reconcileUnresolvedUploads()));
    const after = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    for (const id of added) {
      assert.equal(Object.hasOwn(after, id), false);
      assert.equal(fs.existsSync(path.join(ORIGINALS(), `${id}.mp3`)), adopted.has(id));
      await fsp.rm(path.join(ORIGINALS(), `${id}.mp3`), { force: true });
    }
  } finally {
    fake.clearOverride('POST /internal/catalog/register-upload');
    fake.clearOverride('GET /internal/catalog/assets/*');
  }
});

test('corrupt journal recovery is fail-safe and reconstructs live immutable files before reconciliation', async () => {
  const ids = ['ast_' + '6'.repeat(32), 'ast_' + '7'.repeat(32)];
  for (const id of ids) fs.writeFileSync(path.join(ORIGINALS(), `${id}.mp3`), `live ${id}`);
  const journalPath = path.join(STAGING(), 'unresolved.json');
  fs.writeFileSync(journalPath, '{"truncated":');
  fake.override('GET /internal/catalog/assets/*', (call, res) => fake.json(res, 404, { error: { code: 'ASSET_NOT_FOUND' } }));
  try {
    await admin.module.reconcileUnresolvedUploads();
    const recovered = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    for (const id of ids) {
      assert.equal(Object.hasOwn(recovered, id), true);
      assert.equal(recovered[id].recovered_from_corruption, true);
      assert.equal(fs.existsSync(path.join(ORIGINALS(), `${id}.mp3`)), true);
    }
    assert.ok(fs.readdirSync(STAGING()).some((name) => name.startsWith('unresolved.json.corrupt-')));
    fake.override('GET /internal/catalog/assets/*', (call, res) => fake.json(res, 200, { asset_id: call.assetId, status: 'READY' }));
    await admin.module.reconcileUnresolvedUploads();
    assert.deepEqual(JSON.parse(fs.readFileSync(journalPath, 'utf8')), {});
  } finally {
    fake.clearOverride('GET /internal/catalog/assets/*');
    for (const id of ids) await fsp.rm(path.join(ORIGINALS(), `${id}.mp3`), { force: true });
  }
});

test('the aggregate staging budget rejects with 507 while ambiguous bytes are outstanding', async () => {
  // Journal a large unresolved upload that reconciliation cannot resolve yet.
  const bigId = 'ast_' + '8'.repeat(32);
  fs.mkdirSync(STAGING(), { recursive: true });
  fs.writeFileSync(path.join(ORIGINALS(), `${bigId}.mp3`), 'big');
  fs.writeFileSync(path.join(STAGING(), 'unresolved.json'), JSON.stringify({ [bigId]: { bytes: 1000 * 1024, at: new Date().toISOString() } }));
  fake.override('GET /internal/catalog/assets/*', (call, res) => fake.json(res, 503, { error: { code: 'UNAVAILABLE', message: 'down' } }));
  try {
    const res = await fetch(admin.origin + '/api/automation/upload', {
      method: 'PUT', body: Buffer.alloc(200 * 1024, 1),
    });
    assert.equal(res.status, 507);
    assert.deepEqual(fs.readdirSync(STAGING()).filter((f) => f.endsWith('.part')), [], 'no partial file left');
  } finally {
    fake.clearOverride('GET /internal/catalog/assets/*');
    await fsp.rm(path.join(ORIGINALS(), `${bigId}.mp3`), { force: true });
    fs.writeFileSync(path.join(STAGING(), 'unresolved.json'), '{}');
  }
  // Budget released: normal uploads work again.
  const ok = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('post-507 bytes') });
  assert.equal(ok.status, 201);
  await fsp.rm(path.join(ORIGINALS(), `${(await ok.json()).asset_id}.mp3`), { force: true });
});

test('a full automation outage degrades reads to 503 and keeps+journals an in-flight upload', async () => {
  await fake.close();
  const res = await fetch(admin.origin + '/api/automation/queue');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'AUTOMATION_UNAVAILABLE');
  // An upload during a hard outage is AMBIGUOUS (automation may have died
  // after committing): the bytes are kept and journaled, never deleted.
  const before = fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3'));
  const upload = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('outage bytes') });
  assert.equal(upload.status, 502);
  assert.equal((await upload.json()).error.code, 'UPLOAD_UNRESOLVED');
  const after = fs.readdirSync(ORIGINALS()).filter((f) => f.endsWith('.mp3'));
  assert.equal(after.length, before.length + 1, 'ambiguous bytes retained for reconciliation');
  const journal = JSON.parse(fs.readFileSync(path.join(STAGING(), 'unresolved.json'), 'utf8'));
  assert.equal(Object.keys(journal).length, 1);
  assert.deepEqual(fs.readdirSync(STAGING()).filter((f) => f.endsWith('.part')), [], 'no partial temp left');
  const ui = await fetch(admin.origin + '/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /control room/iu);
});

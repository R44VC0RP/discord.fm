'use strict';

/** Shared fixtures for admin server tests: temp dirs, a fake automation
 *  service, and helpers to boot the admin server on an ephemeral port. */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-admin-'));
  for (const dir of ['recordings', 'music', 'voicemails', 'web']) fs.mkdirSync(path.join(root, dir));
  return root;
}

/** Minimal fake automation API that records every request it receives. */
function createFakeAutomation() {
  const calls = [];
  const overrides = new Map();
  // Defaults are deliberately poisoned with private/internal fields the admin
  // proxy must strip before anything reaches a browser.
  const POISON = {
    worker_id: 'worker_bot_SECRET_1',
    locator: '/music/originals/ast_secret.mp3',
    content_sha256: 'deadbeef'.repeat(8),
    claim_token: 'claim_SECRET',
    internal_note: 'SECRET_NOTE',
  };
  const defaults = {
    'GET /internal/queue/snapshot': (call, res) => json(res, 200, {
      queue_revision: 7, ready_count: 2, ready_duration_ms: 300000, generating_count: 0,
      flags: { playout_enabled: false, dj_enabled: false },
      watermarks: { low_count: 12, high_count: 24, low_duration_ms: 2700000, target_duration_ms: 5400000 },
      cues: [{ cue_id: 'cue_internal_1', type: 'music', state: 'READY', asset_id: 'ast_internal', group_id: 'grp_internal', planned_duration_ms: 60000, last_offset_ms: 0, position: 1, public_metadata: { title: 'Track', artist: 'Artist', private_hint: 'SECRET_META' }, ...POISON }],
      presence: { humans: 0, observed_at: '2026-07-06T00:00:00Z', worker_id: 'worker_bot_SECRET_1' },
    }),
    'GET /internal/admin/catalog': (call, res) => json(res, 200, { items: [{ asset_id: 'ast_' + 'a'.repeat(32), kind: 'music', status: 'READY', title: 'Track', artist: 'Artist', album: null, tags: [], duration_ms: 60000, created_at: '2026-07-06T00:00:00Z', ...POISON }], nextCursor: null }),
    'GET /internal/dj/status': (call, res) => json(res, 200, {
      mode: 'OFF', model: 'opencode/test', flags: { dj_enabled: false },
      lease: { owner: 'automation_SECRET_PID', expires_at: null, cooldown_until: null, backoff_until: null, failure_count: 0, last_result: null },
      last_run: { run_id: 'djrun_SECRET', opencode_session_id: 'ses_SECRET', model: 'opencode/test', state: 'COMPLETED', tool_calls: 1, input_tokens: 10, output_tokens: 5, estimated_cost_usd: 0.01, failure_code: null, started_at: '2026-07-06T00:00:00Z', completed_at: '2026-07-06T00:00:30Z' },
      daily: { tool_calls: 1, tool_call_limit: 200, model_tokens: 15, model_token_limit: 200000, tts_characters: 0, tts_character_limit: 20000 },
      watermarks: { low_count: 12, high_count: 24, low_duration_ms: 2700000, target_duration_ms: 5400000 },
      tools: ['list_tracks'], opencode: { healthy: true, version: '1.17.13', internal_url: 'http://opencode_SECRET:4096' },
    }),
    'GET /internal/hotline/review': (call, res) => json(res, 200, { hotlineEnabled: false, items: [{ candidate_id: 'callcand_1', call_id: 'vm-2026-07-06T00-00-00', status: 'ELIGIBLE', screen_result: 'PASS', screen_current: true, moderation_version: 1, transcript: 'redacted text', summary: null, archive_reason: null, operator_override: null, aired_at: null, updated_at: '2026-07-06T00:00:00Z', duration_ms: 30000, dj_visible: true, transcript_private: 'RAW_SECRET_TRANSCRIPT', call_sid: 'CA_SECRET', ...POISON }], nextCursor: null }),
    'GET /internal/history': (call, res) => json(res, 200, { items: [{ cue_id: 'cue_internal_1', asset_id: 'ast_internal', event: 'ENQUEUED', reason_code: null, at: '2026-07-06T00:00:00Z', title: 'Track', type: 'music', ...POISON }] }),
    'POST /internal/queue/tracks': (call, res) => json(res, 201, { accepted: true, queue_revision: 8, cue_id: 'cue_test', state: 'READY' }),
    'POST /internal/queue/commentary': (call, res) => json(res, 202, { accepted: true, queue_revision: 8, state: 'GENERATING' }),
    'POST /internal/hotline/review': (call, res) => json(res, 200, { candidate_id: 'callcand_x', status: 'REJECTED', moderation_version: 2 }),
    'POST /internal/catalog/register-upload': (call, res) => {
      const body = JSON.parse(call.body || '{}');
      json(res, 201, { created: true, duplicate: false, asset_id: body.asset_id, title: body.title || 'Untitled', duration_ms: 1234 });
    },
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: Buffer.concat(chunks).toString() };
      calls.push(call);
      const key = `${req.method} ${url.pathname}`;
      const lookup = url.pathname.match(/^\/internal\/catalog\/assets\/([\w]+)$/);
      if (req.method === 'GET' && lookup) {
        call.assetId = lookup[1];
        const handler = overrides.get(key) || overrides.get('GET /internal/catalog/assets/*');
        if (handler) return handler(call, res);
        return json(res, 404, { error: { code: 'ASSET_NOT_FOUND', message: 'asset does not exist' } });
      }
      const audio = url.pathname.match(/^\/internal\/catalog\/assets\/([\w]+)\/audio$/);
      if (req.method === 'GET' && audio && !overrides.has(key)) {
        const bytes = Buffer.alloc(100, 7);
        if (req.headers.range) {
          res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-9/${bytes.length}`, 'accept-ranges': 'bytes', 'content-length': 10 });
          return res.end(bytes.subarray(0, 10));
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': bytes.length });
        return res.end(bytes);
      }
      const handler = overrides.get(key) || defaults[key];
      if (!handler) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'endpoint not found' } });
      handler(call, res);
    });
  });
  return {
    server,
    calls,
    json,
    override: (key, handler) => overrides.set(key, handler),
    clearOverride: (key) => overrides.delete(key),
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function startAdmin() {
  // env must be final before require: the server reads it at module load.
  const mod = require('../server.js');
  const { server } = mod;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, module: mod, origin: `http://127.0.0.1:${server.address().port}` };
}

module.exports = { tempDirs, createFakeAutomation, startAdmin };

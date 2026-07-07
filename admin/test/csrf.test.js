'use strict';

/**
 * Same-origin (CSRF) enforcement across EVERY admin state mutation.
 * Fail-closed for browsers: forged Origin / cross-site Sec-Fetch-Site is
 * rejected on every mutating route (including bodyless skips, uploads, and
 * simple text/plain posts), while same-origin browser requests, header-less
 * non-browser callers (the bot, curl, tests), and the signature-authenticated
 * Twilio /call/* webhooks keep working.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { tempDirs, createFakeAutomation, startAdmin } = require('./helpers.js');

let fake;
let admin;
let root;

const MUTATIONS = [
  ['POST', '/api/announce'],
  ['POST', '/api/voicemail/play'],
  ['POST', '/api/voicemails/vm-x.mp3/archive'],
  ['DELETE', '/api/voicemails/vm-x.mp3'],
  ['DELETE', '/api/recordings/session-x.mp3'],
  ['POST', '/api/recordings/session-x.mp3/mp4'],
  ['POST', '/api/skin'],
  ['POST', '/api/rerun/queue'],
  ['POST', '/api/rerun/unqueue'],
  ['POST', '/api/rerun/skip'], // bodyless
  ['POST', '/api/rerun/auto'],
  ['PUT', '/api/music/upload?name=t.mp3'],
  ['POST', '/api/music/track'],
  ['DELETE', '/api/music/t.mp3'],
  ['POST', '/api/automation/queue/track'],
  ['POST', '/api/automation/queue/commentary'],
  ['POST', '/api/automation/hotline/review'],
  ['POST', '/api/automation/assets/ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/retire'],
  ['POST', '/api/automation/assets/ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/restore'],
  ['PUT', '/api/automation/upload'],
];

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
  process.env.AUTOMATION_INTERNAL_TOKEN = 'csrf-test-token';
  admin = await startAdmin();
});

after(async () => {
  await new Promise((resolve) => admin.server.close(() => resolve()));
  await fake.close().catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
});

const call = (method, p, headers = {}, body = '{}') =>
  fetch(admin.origin + p, { method, headers, body: method === 'DELETE' ? undefined : body });

test('every mutation route rejects a forged cross-origin browser request', async () => {
  for (const [method, p] of MUTATIONS) {
    const res = await call(method, p, { origin: 'https://evil.example', 'content-type': 'application/json' });
    assert.equal(res.status, 403, `${method} ${p}`);
    assert.equal((await res.json()).error, 'cross-origin request rejected', `${method} ${p}`);
  }
});

test('every mutation route rejects Sec-Fetch-Site: cross-site (and same-site)', async () => {
  for (const [method, p] of MUTATIONS) {
    for (const site of ['cross-site', 'same-site']) {
      const res = await call(method, p, { 'sec-fetch-site': site, 'content-type': 'application/json' });
      assert.equal(res.status, 403, `${method} ${p} (${site})`);
    }
  }
});

test('a simple text/plain cross-origin post (classic CSRF shape) is rejected', async () => {
  const res = await call('POST', '/api/rerun/skip', { origin: 'https://evil.example', 'content-type': 'text/plain' }, 'x');
  assert.equal(res.status, 403);
  const upload = await call('PUT', '/api/automation/upload', { origin: 'https://evil.example', 'content-type': 'text/plain' }, 'mp3bytes');
  assert.equal(upload.status, 403);
});

test('an Origin of "null" (sandboxed page) is rejected', async () => {
  const res = await call('POST', '/api/rerun/skip', { origin: 'null' });
  assert.equal(res.status, 403);
});

test('same-origin browser requests pass the gate on every mutation route', async () => {
  const host = new URL(admin.origin).host;
  for (const [method, p] of MUTATIONS) {
    for (const headers of [
      { origin: `http://${host}`, 'content-type': 'application/json' },
      { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    ]) {
      const res = await call(method, p, headers);
      const body = await res.json().catch(() => ({}));
      assert.notEqual(body.error, 'cross-origin request rejected', `${method} ${p} ${JSON.stringify(headers)}`);
    }
  }
});

test('header-less non-browser callers (bot mp4 renders, curl) are not blocked', async () => {
  // The bot posts render requests with no Origin/Sec-Fetch-Site.
  const res = await call('POST', '/api/recordings/session-x.mp3/mp4');
  assert.equal(res.status, 404); // passes the gate; recording simply absent
  const skip = await call('POST', '/api/rerun/skip');
  assert.notEqual(skip.status, 403); // bot API is down (fake), but not CSRF-blocked
});

test('GET routes are not affected by the origin gate', async () => {
  const res = await fetch(admin.origin + '/api/automation/queue', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 200); // reads are safe; auth is Caddy basic_auth
});

test('Twilio /call/* webhooks keep signature auth and bypass the origin gate', async () => {
  const res = await fetch(admin.origin + '/call/incoming', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'From=%2B15551234567',
  });
  assert.equal(res.status, 403);
  // Rejected by the SIGNATURE check, not the CSRF gate.
  assert.equal((await res.json()).error, 'bad signature');
});

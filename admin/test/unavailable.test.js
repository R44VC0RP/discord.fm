'use strict';

/**
 * Admin server with NO automation token configured (separate process from
 * proxy.test.js so module-load env differs): automation panels degrade to a
 * clear 503 and everything else keeps working. The token short-circuit also
 * means uploads never write bytes at all.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { tempDirs, startAdmin } = require('./helpers.js');

let admin;
let root;

before(async () => {
  root = tempDirs();
  process.env.RECORDING_DIR = path.join(root, 'recordings');
  process.env.MUSIC_DIR = path.join(root, 'music');
  process.env.VOICEMAIL_DIR = path.join(root, 'voicemails');
  process.env.WEB_DIR = path.join(root, 'web');
  process.env.BOT_API = 'http://127.0.0.1:1';
  delete process.env.AUTOMATION_API;
  delete process.env.AUTOMATION_INTERNAL_TOKEN;
  admin = await startAdmin();
});

after(async () => {
  await new Promise((resolve) => admin.server.close(() => resolve()));
  await fsp.rm(root, { recursive: true, force: true });
});

test('automation routes fail soft with a structured 503 when unconfigured', async () => {
  for (const p of ['/api/automation/queue', '/api/automation/catalog', '/api/automation/dj', '/api/automation/hotline', '/api/automation/history']) {
    const res = await fetch(admin.origin + p);
    assert.equal(res.status, 503, p);
    const body = await res.json();
    assert.equal(body.error.code, 'AUTOMATION_NOT_CONFIGURED');
    assert.match(body.error.message, /not configured/u);
  }
  const audio = await fetch(`${admin.origin}/api/automation/assets/ast_${'a'.repeat(32)}/audio`);
  assert.equal(audio.status, 503);
});

test('uploads are refused before any byte is written when unconfigured', async () => {
  const res = await fetch(admin.origin + '/api/automation/upload', { method: 'PUT', body: Buffer.from('mp3 bytes') });
  assert.equal(res.status, 503);
  const originals = path.join(root, 'music', 'originals');
  const entries = fs.existsSync(originals) ? fs.readdirSync(originals).filter((f) => f !== '.staging') : [];
  assert.deepEqual(entries, [], 'nothing was staged or renamed');
});

test('the rest of the control room still serves', async () => {
  const ui = await fetch(admin.origin + '/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /ASSET LIBRARY/u);
  const missing = await fetch(admin.origin + '/api/automation/nope');
  assert.equal(missing.status, 404);
});

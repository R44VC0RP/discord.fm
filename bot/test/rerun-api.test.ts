import assert from 'node:assert/strict';
import test from 'node:test';
import { Mixer } from '../src/mixer.js';
import { startApi, type ApiDeps } from '../src/api.js';

const baseDeps = (rerun: ApiDeps['rerun'], owner: 'automation' | 'legacy'): ApiDeps => ({
  mixer: new Mixer(), rerun, rerunOwner: owner, skin: null,
  getSnapshot: () => ({ live: true, humans: 0, members: [], memberIds: [] }),
  getListeners: async () => ({ total: 0, web: 0, youtube: null }),
  getAudience: () => [], getMusicTrack: () => '', setMusicTrack: async () => {},
  queueVoicemail: () => 0, getVoicemailQueue: () => [], voicemailReceived: async () => {},
  announce: async () => ({ fired: false }),
});

async function withApi(deps: ApiDeps, run: (origin: string) => Promise<void>): Promise<void> {
  const server = startApi(deps, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('rerun API routes versioned automation toggle/skip and preserves honest offline state', async () => {
  const calls: unknown[][] = [];
  const rerun: ApiDeps['rerun'] = {
    state: async () => ({ queue: [], auto: false, control_version: 7, available: false }),
    enqueue: async () => {}, unqueue: async () => {},
    skip: async () => { calls.push(['skip']); },
    setAuto: async (...args) => { calls.push(args); },
  };
  await withApi(baseDeps(rerun, 'automation'), async (origin) => {
    const state = await (await fetch(`${origin}/state`)).json() as { rerun: Record<string, unknown> };
    assert.equal(state.rerun.owner, 'automation'); assert.equal(state.rerun.available, false);
    const invalid = await fetch(`${origin}/rerun/auto`, { method: 'POST', body: JSON.stringify({ enabled: true }) });
    assert.equal(invalid.status, 400);
    const toggled = await fetch(`${origin}/rerun/auto`, { method: 'POST', body: JSON.stringify({ enabled: true, expected_version: 7, idempotency_key: 'ui:toggle:1' }) });
    assert.equal(toggled.status, 200);
    await fetch(`${origin}/rerun/skip`, { method: 'POST' });
  });
  assert.deepEqual(calls, [[true, 7, 'ui:toggle:1'], ['skip']]);
});

test('legacy rerun toggle remains compatible without automation version fields', async () => {
  const calls: unknown[][] = [];
  const rerun: ApiDeps['rerun'] = {
    state: async () => ({ queue: [], auto: true }), enqueue: async () => {}, unqueue: async () => {}, skip: async () => {},
    setAuto: async (...args) => { calls.push(args); },
  };
  await withApi(baseDeps(rerun, 'legacy'), async (origin) => {
    const response = await fetch(`${origin}/rerun/auto`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
    assert.equal(response.status, 200);
    const state = await (await fetch(`${origin}/state`)).json() as { rerun: Record<string, unknown> };
    assert.equal(state.rerun.owner, 'legacy'); assert.equal(state.rerun.available, true);
  });
  assert.deepEqual(calls, [[false]]);
});

test('automation rerun conflicts preserve status with a fixed non-private message', async () => {
  const secret = 'private upstream path /state/station.db';
  const rerun: ApiDeps['rerun'] = {
    state: async () => ({ queue: [], auto: true, control_version: 2 }), enqueue: async () => {}, unqueue: async () => {}, skip: async () => {},
    setAuto: async () => { throw Object.assign(new Error(secret), { status: 409, code: 'RERUN_VERSION_CONFLICT' }); },
  };
  await withApi(baseDeps(rerun, 'automation'), async (origin) => {
    const response = await fetch(`${origin}/rerun/auto`, { method: 'POST', body: JSON.stringify({ enabled: false, expected_version: 1, idempotency_key: 'stale:1' }) });
    assert.equal(response.status, 409);
    const text = await response.text();
    assert.doesNotMatch(text, /private|state\/station/u);
    assert.deepEqual(JSON.parse(text), { error: 'rerun control changed — refresh and try again', code: 'RERUN_VERSION_CONFLICT' });
  });
});

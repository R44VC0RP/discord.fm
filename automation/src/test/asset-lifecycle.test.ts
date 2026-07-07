import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DomainError } from '../errors.js';
import { sha256File } from '../importer.js';
import { testAsset, testFixture } from './helpers.js';
import { createServer } from '../server.js';

const execFileAsync = promisify(execFile);

async function realMusic(store: import('../store.js').AutomationStore, name: string, duration = 1): Promise<{ id: string; file: string }> {
  const file = path.join(store.config.musicDir, `${name}.mp3`);
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-ar', '48000', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', file]);
  const id = store.putAsset({ kind: 'music', checksum: await sha256File(file), sourceLocator: file, playoutLocator: file, title: name, artist: 'Lifecycle Artist', durationMs: duration * 1000, mimeType: 'audio/mpeg', codecName: 'mp3', sampleRateHz: 48_000, channels: 2, bitRate: 128_000 }).assetId;
  return { id, file: fs.realpathSync(file) };
}

const isCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('retire rejects CLAIMED and PLAYING music without mutation', async () => {
  const fixture = await testFixture();
  const music = await realMusic(fixture.store, 'active-retire');
  fixture.store.presence({ humans: 0, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_asset' });
  fixture.store.enqueueTrack({ assetId: music.id, expectedRevision: 0, idempotencyKey: 'active:enqueue' });
  const claim = fixture.store.claim({ expectedRevision: 1, workerId: 'worker_asset', idempotencyKey: 'active:claim' });
  const cue = claim.cue as Record<string, unknown>;
  assert.throws(() => fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 2, idempotencyKey: 'active:retire:claimed' }), isCode('ASSET_ACTIVE'));
  fixture.store.start(String(cue.cue_id), { expectedRevision: 2, workerId: 'worker_asset', claimToken: String(cue.claim_token), idempotencyKey: 'active:start' });
  assert.throws(() => fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 3, idempotencyKey: 'active:retire:playing' }), isCode('ASSET_ACTIVE'));
  assert.equal(fixture.store.revision(), 3);
  assert.equal((fixture.store.db.prepare('SELECT status FROM assets WHERE id=?').get(music.id) as { status: string }).status, 'READY');
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('retire cancels unclaimed cues, retains bytes, audits once, and is CAS/idempotent', async () => {
  const fixture = await testFixture();
  const music = await realMusic(fixture.store, 'retire-ready');
  const queued = fixture.store.enqueueTrack({ assetId: music.id, expectedRevision: 0, idempotencyKey: 'ready:enqueue' });
  const input = { assetId: music.id, expectedRevision: 1, idempotencyKey: 'ready:retire' };
  const retired = fixture.store.retireMusicAsset(input);
  assert.deepEqual(fixture.store.retireMusicAsset(input), retired);
  assert.equal(retired.queue_revision, 2); assert.equal(retired.canceled_cues, 1);
  assert.equal((fixture.store.db.prepare('SELECT state FROM cues WHERE id=?').get(queued.cue_id) as { state: string }).state, 'CANCELED');
  assert.equal((fixture.store.db.prepare('SELECT status FROM assets WHERE id=?').get(music.id) as { status: string }).status, 'RETIRED');
  const projected = fixture.store.listCatalogAdmin({ status: 'RETIRED' }).items as Array<Record<string, unknown>>;
  assert.equal(projected[0]?.status, 'RETIRED'); assert.doesNotMatch(JSON.stringify(projected), /locator|checksum|content_sha256/u);
  assert.equal(fs.existsSync(music.file), true, 'retire must retain immutable source bytes');
  assert.equal((fixture.store.db.prepare("SELECT count(*) count FROM asset_events WHERE asset_id=? AND event_type='RETIRED'").get(music.id) as { count: number }).count, 1);
  const history = fixture.store.history(10).items as Array<Record<string, unknown>>;
  assert.ok(history.some((item) => item.event === 'RETIRED' && item.asset_id === music.id && item.title === 'retire-ready'));
  assert.throws(() => fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 1, idempotencyKey: 'ready:concurrent' }), isCode('REVISION_CONFLICT'));
  assert.throws(() => fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 2, idempotencyKey: 'ready:wrong-state' }), isCode('ASSET_STATE_CONFLICT'));
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('retiring a generating hotline destination cancels the whole group and restores candidate', async () => {
  const fixture = await testFixture();
  const call = testAsset(fixture.store, 'retire-group-call', 'hotline', 20_000);
  const music = await realMusic(fixture.store, 'retire-group-destination');
  const candidate = fixture.store.registerHotline({ callId: 'retire_group_call', assetId: call, transcript: 'A safe group call.', moderationVersion: 1 });
  const group = fixture.store.enqueueHotlineGroup({ candidateId: String(candidate.candidate_id), moderationVersion: 1, introScript: 'A listener left a safe thought.', nextTrackAssetId: music.id, expectedRevision: 0, idempotencyKey: 'group:enqueue' });
  const result = fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 1, idempotencyKey: 'group:retire' });
  assert.equal(result.queue_revision, 2);
  assert.equal((fixture.store.db.prepare('SELECT state FROM cue_groups WHERE id=?').get(group.group_id) as { state: string }).state, 'CANCELED');
  assert.equal((fixture.store.db.prepare("SELECT count(*) count FROM cues WHERE group_id=? AND state='CANCELED'").get(group.group_id) as { count: number }).count, 3);
  assert.equal((fixture.store.db.prepare('SELECT state FROM generation_jobs').get() as { state: string }).state, 'CANCELED');
  assert.equal((fixture.store.db.prepare('SELECT status FROM hotline_candidates WHERE id=?').get(candidate.candidate_id) as { status: string }).status, 'ELIGIBLE');
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('retire rejects when a sibling in the referencing atomic group is CLAIMED', async () => {
  const fixture = await testFixture();
  const call = testAsset(fixture.store, 'retire-active-group-call', 'hotline', 20_000);
  const music = await realMusic(fixture.store, 'retire-active-group-destination');
  const candidate = fixture.store.registerHotline({ callId: 'retire_active_group', assetId: call, transcript: 'A safe group call.', moderationVersion: 1 });
  const group = fixture.store.enqueueHotlineGroup({ candidateId: String(candidate.candidate_id), moderationVersion: 1, introScript: 'A listener left a thought.', nextTrackAssetId: music.id, expectedRevision: 0, idempotencyKey: 'active-group:enqueue' });
  fixture.store.db.prepare("UPDATE cues SET state='CLAIMED',claimed_by='worker',claim_token='claim',claim_expires_at=? WHERE group_id=? AND group_index=0").run(new Date(Date.now() + 60_000).toISOString(), group.group_id);
  assert.throws(() => fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 1, idempotencyKey: 'active-group:retire' }), isCode('ASSET_ACTIVE'));
  assert.equal((fixture.store.db.prepare('SELECT status FROM assets WHERE id=?').get(music.id) as { status: string }).status, 'READY');
  assert.equal((fixture.store.db.prepare("SELECT count(*) count FROM cues WHERE group_id=? AND state='CANCELED'").get(group.group_id) as { count: number }).count, 0);
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('restore revalidates bytes/probe, clears retired state, and replays idempotently', async () => {
  const fixture = await testFixture();
  const music = await realMusic(fixture.store, 'restore-valid');
  fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 0, idempotencyKey: 'restore:retire' });
  const input = { assetId: music.id, expectedRevision: 1, idempotencyKey: 'restore:apply' };
  const restored = fixture.store.restoreMusicAsset(input);
  assert.deepEqual(fixture.store.restoreMusicAsset(input), restored);
  assert.equal(restored.queue_revision, 2); assert.equal(restored.status, 'READY');
  const row = fixture.store.db.prepare('SELECT status,retired_at FROM assets WHERE id=?').get(music.id) as { status: string; retired_at: string | null };
  assert.deepEqual(row, { status: 'READY', retired_at: null });
  assert.equal((fixture.store.db.prepare('SELECT count(*) count FROM asset_events WHERE asset_id=?').get(music.id) as { count: number }).count, 2);
  assert.throws(() => fixture.store.restoreMusicAsset({ assetId: music.id, expectedRevision: 2, idempotencyKey: 'restore:wrong-state' }), isCode('ASSET_STATE_CONFLICT'));
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

for (const mode of ['missing', 'tampered', 'symlink', 'probe'] as const) {
  test(`restore fails closed for ${mode} retired bytes`, async () => {
    const fixture = await testFixture();
    const music = mode === 'probe'
      ? { id: testAsset(fixture.store, 'not-real-mp3', 'music', 1000), file: path.join(fixture.config.generatedDir, 'not-real-mp3.mp3') }
      : await realMusic(fixture.store, `restore-${mode}`);
    fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 0, idempotencyKey: `${mode}:retire` });
    if (mode === 'missing') await fsp.rm(music.file);
    if (mode === 'tampered') await fsp.writeFile(music.file, 'tampered bytes');
    if (mode === 'symlink') {
      const outside = path.join(fixture.root, 'outside.mp3'); await fsp.writeFile(outside, 'outside');
      await fsp.rm(music.file); await fsp.symlink(outside, music.file);
    }
    const expected = mode === 'missing' ? 'ASSET_FILE_MISSING' : mode === 'tampered' ? 'CHECKSUM_MISMATCH' : mode === 'symlink' ? 'INVALID_LOCATOR' : 'PROBE_FAILED';
    assert.throws(() => fixture.store.restoreMusicAsset({ assetId: music.id, expectedRevision: 1, idempotencyKey: `${mode}:restore` }), isCode(expected));
    assert.equal(fixture.store.revision(), 1);
    assert.equal((fixture.store.db.prepare('SELECT status FROM assets WHERE id=?').get(music.id) as { status: string }).status, 'RETIRED');
    fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
  });
}

test('restore rejects swap-to-undecodable-and-restore pathname race', async () => {
  const fixture = await testFixture();
  const music = await realMusic(fixture.store, 'restore-swap-race');
  fixture.store.retireMusicAsset({ assetId: music.id, expectedRevision: 0, idempotencyKey: 'swap:retire' });
  const bin = path.join(fixture.root, 'bin'); await fsp.mkdir(bin);
  const fakeProbe = path.join(bin, 'ffprobe');
  await fsp.writeFile(fakeProbe, `#!/bin/sh
set -eu
saved="$RESTORE_SWAP_TARGET.saved"
mv "$RESTORE_SWAP_TARGET" "$saved"
printf 'not-an-mp3' > "$RESTORE_SWAP_TARGET"
rm "$RESTORE_SWAP_TARGET"
mv "$saved" "$RESTORE_SWAP_TARGET"
printf '%s' '{"format":{"duration":"1.0"},"streams":[{"codec_type":"audio","codec_name":"mp3"}]}'
`);
  await fsp.chmod(fakeProbe, 0o755);
  const oldPath = process.env.PATH; const oldTarget = process.env.RESTORE_SWAP_TARGET;
  process.env.PATH = `${bin}:${oldPath}`; process.env.RESTORE_SWAP_TARGET = music.file;
  try {
    assert.throws(() => fixture.store.restoreMusicAsset({ assetId: music.id, expectedRevision: 1, idempotencyKey: 'swap:restore' }), isCode('ASSET_CHANGED_DURING_VALIDATION'));
  } finally {
    process.env.PATH = oldPath;
    if (oldTarget === undefined) delete process.env.RESTORE_SWAP_TARGET; else process.env.RESTORE_SWAP_TARGET = oldTarget;
  }
  assert.equal(fixture.store.revision(), 1);
  assert.equal((fixture.store.db.prepare('SELECT status FROM assets WHERE id=?').get(music.id) as { status: string }).status, 'RETIRED');
  assert.equal(await sha256File(music.file), (fixture.store.db.prepare('SELECT content_sha256 FROM assets WHERE id=?').get(music.id) as { content_sha256: string }).content_sha256);
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('internal lifecycle HTTP endpoints require auth and strict revision/idempotency bodies', async () => {
  const fixture = await testFixture({ internalToken: 'asset-admin-token-012345678901234567' });
  const music = await realMusic(fixture.store, 'http-lifecycle');
  const server = createServer(fixture.store, fixture.config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/internal/admin/catalog/assets/${music.id}/retire`;
  const request = (token: string, body: unknown) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('wrong-token', { expected_queue_revision: 0, idempotency_key: 'http:bad-auth' })).status, 401);
  const unknown = await request(fixture.config.internalToken, { expected_queue_revision: 0, idempotency_key: 'http:unknown', extra: true });
  assert.equal(unknown.status, 400); assert.equal((await unknown.json() as { error: { code: string } }).error.code, 'UNKNOWN_FIELDS');
  const accepted = await request(fixture.config.internalToken, { expected_queue_revision: 0, idempotency_key: 'http:retire' });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json() as { status: string }).status, 'RETIRED');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('concurrent retire requests serialize on queue revision CAS', async () => {
  const fixture = await testFixture({ internalToken: 'asset-concurrency-token-0123456789012' });
  const first = testAsset(fixture.store, 'concurrent-retire-a', 'music', 1000, 'Concurrency A');
  const second = testAsset(fixture.store, 'concurrent-retire-b', 'music', 1000, 'Concurrency B');
  const server = createServer(fixture.store, fixture.config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const retire = (assetId: string) => fetch(`http://127.0.0.1:${address.port}/internal/admin/catalog/assets/${assetId}/retire`, {
    method: 'POST', headers: { authorization: `Bearer ${fixture.config.internalToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expected_queue_revision: 0, idempotency_key: `concurrent:${assetId}` }),
  });
  const responses = await Promise.all([retire(first), retire(second)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(fixture.store.revision(), 1);
  assert.equal((fixture.store.db.prepare("SELECT count(*) count FROM assets WHERE status='RETIRED'").get() as { count: number }).count, 1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

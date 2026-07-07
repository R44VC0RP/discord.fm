import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../server.js';
import { importHotlines } from '../hotline-importer.js';
import { testAsset, testFixture } from './helpers.js';

const fakeProbe = async () => ({ durationMs: 20_000, codecName: 'mp3', sampleRateHz: 48_000, channels: 1, bitRate: 96_000, mimeType: 'audio/mpeg' });

function hasFfmpeg(): boolean {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeMp3(target: string): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.4', '-q:a', '9', '-y', target], { stdio: 'ignore' });
}

async function voicemail(root: string, name: string, transcript: string | undefined, archived = false): Promise<void> {
  await fsp.writeFile(path.join(root, `${name}.mp3`), Buffer.from(`audio-${name}`));
  await fsp.writeFile(path.join(root, `${name}.json`), JSON.stringify({
    from: '+1-415-555-9999', callSid: 'CA_PRIVATE_SHOULD_NEVER_PROJECT', transcript, archived, receivedAt: new Date().toISOString(),
  }));
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

const AUTH = { authorization: 'Bearer test-token' };

test('admin catalog projection paginates, filters, and never exposes locators or checksums', async () => {
  const fixture = await testFixture();
  const { store } = fixture;
  testAsset(store, 'Alpha Signal', 'music', 120_000, 'Artist One');
  testAsset(store, 'Beta Nocturne', 'music', 90_000, 'Artist Two');
  const quarantined = path.join(store.config.generatedDir, 'quarantined.mp3');
  fs.mkdirSync(store.config.generatedDir, { recursive: true });
  fs.writeFileSync(quarantined, 'bad bytes');
  store.putAsset({
    kind: 'music', status: 'QUARANTINED', checksum: 'c'.repeat(64), sourceLocator: quarantined, playoutLocator: quarantined,
    title: 'Broken Upload', durationMs: 1000, mimeType: 'audio/mpeg', codecName: 'mp3', sampleRateHz: 44_100, channels: 1, bitRate: 96_000,
  });

  const all = store.listCatalogAdmin({});
  assert.equal(all.items.length, 3);
  const serialized = JSON.stringify(all);
  assert.doesNotMatch(serialized, /locator|sha256|checksum|provenance|probe/u);
  const statuses = (all.items as Array<{ status: string }>).map((item) => item.status).sort();
  assert.deepEqual(statuses, ['QUARANTINED', 'READY', 'READY']);

  const filtered = store.listCatalogAdmin({ status: 'QUARANTINED' });
  assert.equal(filtered.items.length, 1);
  assert.equal((filtered.items[0] as { title: string }).title, 'Broken Upload');

  const searched = store.listCatalogAdmin({ search: 'beta' });
  assert.equal(searched.items.length, 1);
  assert.equal((searched.items[0] as { title: string }).title, 'Beta Nocturne');

  const pageOne = store.listCatalogAdmin({ limit: 1 });
  assert.equal(pageOne.items.length, 1);
  assert.ok(pageOne.nextCursor);
  const pageTwo = store.listCatalogAdmin({ limit: 5, cursor: pageOne.nextCursor });
  assert.equal(pageTwo.items.length, 2);
  assert.equal(pageTwo.nextCursor, null);

  store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('register-upload probes, dedupes identical bytes, and rejects undecodable audio', { skip: !hasFfmpeg() }, async (t) => {
  const fixture = await testFixture();
  const { store, config } = fixture;
  const originals = path.join(config.musicDir, 'originals');
  fs.mkdirSync(originals, { recursive: true });
  const server = createServer(store, config);
  const origin = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const register = async (body: Record<string, unknown>) => {
    const response = await fetch(`${origin}/internal/catalog/register-upload`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  const assetId = `ast_${'a'.repeat(32)}`;
  makeMp3(path.join(originals, `${assetId}.mp3`));
  const created = await register({ asset_id: assetId, title: 'Uploaded Song', artist: 'Uploader', tags: ['night', 'ambient'], original_filename: 'weird/../name.mp3' });
  assert.equal(created.status, 201);
  assert.deepEqual({ created: created.body.created, duplicate: created.body.duplicate, asset_id: created.body.asset_id }, { created: true, duplicate: false, asset_id: assetId });

  // Same bytes under a new staged name: catalog keeps the original asset.
  const dupId = `ast_${'b'.repeat(32)}`;
  fs.copyFileSync(path.join(originals, `${assetId}.mp3`), path.join(originals, `${dupId}.mp3`));
  const duplicate = await register({ asset_id: dupId, title: 'Same Bytes' });
  assert.equal(duplicate.status, 200);
  assert.deepEqual({ created: duplicate.body.created, duplicate: duplicate.body.duplicate, asset_id: duplicate.body.asset_id }, { created: false, duplicate: true, asset_id: assetId });

  const badId = `ast_${'c'.repeat(32)}`;
  fs.writeFileSync(path.join(originals, `${badId}.mp3`), 'not an mp3 at all');
  const garbage = await register({ asset_id: badId });
  assert.equal(garbage.status, 422);
  assert.equal((garbage.body.error as { code: string }).code, 'PROBE_FAILED');
  assert.equal((store.db.prepare('SELECT count(*) count FROM assets WHERE id=?').get(badId) as { count: number }).count, 0);

  const missing = await register({ asset_id: `ast_${'d'.repeat(32)}` });
  assert.equal(missing.status, 409);
  assert.equal((missing.body.error as { code: string }).code, 'UPLOAD_FILE_MISSING');

  const malformed = await register({ asset_id: '../../etc/passwd' });
  assert.equal(malformed.status, 400);

  // The registered upload is present in the admin catalog with sanitized metadata.
  const item = store.listCatalogAdmin({ search: 'Uploaded Song' }).items[0] as Record<string, unknown>;
  assert.equal(item.asset_id, assetId);
  assert.deepEqual(item.tags, ['night', 'ambient']);

  store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('asset audio route streams by immutable id with Range support and excludes hotline audio', { skip: !hasFfmpeg() }, async (t) => {
  const fixture = await testFixture();
  const { store, config } = fixture;
  const originals = path.join(config.musicDir, 'originals');
  fs.mkdirSync(originals, { recursive: true });
  const assetId = `ast_${'e'.repeat(32)}`;
  makeMp3(path.join(originals, `${assetId}.mp3`));
  const server = createServer(store, config);
  const origin = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await fetch(`${origin}/internal/catalog/register-upload`, {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ asset_id: assetId, title: 'Streamable' }),
  });
  const size = fs.statSync(path.join(originals, `${assetId}.mp3`)).size;

  const unauthorized = await fetch(`${origin}/internal/catalog/assets/${assetId}/audio`);
  assert.equal(unauthorized.status, 401);

  const full = await fetch(`${origin}/internal/catalog/assets/${assetId}/audio`, { headers: AUTH });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Number(full.headers.get('content-length')), size);
  assert.equal((await full.arrayBuffer()).byteLength, size);

  const partial = await fetch(`${origin}/internal/catalog/assets/${assetId}/audio`, { headers: { ...AUTH, range: 'bytes=0-99' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await partial.arrayBuffer()).byteLength, 100);

  const tail = await fetch(`${origin}/internal/catalog/assets/${assetId}/audio`, { headers: { ...AUTH, range: `bytes=${size - 10}-` } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 10);

  const unsatisfiable = await fetch(`${origin}/internal/catalog/assets/${assetId}/audio`, { headers: { ...AUTH, range: `bytes=${size + 5}-` } });
  assert.equal(unsatisfiable.status, 416);

  const hotlineId = testAsset(store, 'caller audio', 'hotline', 20_000, null as unknown as string);
  const hotline = await fetch(`${origin}/internal/catalog/assets/${hotlineId}/audio`, { headers: AUTH });
  assert.equal(hotline.status, 403);

  const unknown = await fetch(`${origin}/internal/catalog/assets/ast_${'0'.repeat(32)}/audio`, { headers: AUTH });
  assert.equal(unknown.status, 404);

  store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('dj status projection reports mode, budgets, and exactly the seven tools without secrets', async (t) => {
  const fixture = await testFixture({ opencodeUrl: 'http://127.0.0.1:1' });
  const server = createServer(fixture.store, fixture.config);
  const origin = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const response = await fetch(`${origin}/internal/dj/status`, { headers: AUTH });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.mode, 'OFF');
  assert.deepEqual(body.tools, ['list_tracks', 'get_track_history', 'get_queue', 'enqueue_track', 'enqueue_commentary', 'list_hotline_candidates', 'enqueue_hotline_group']);
  assert.equal((body.opencode as { healthy: boolean }).healthy, false);
  assert.ok(body.last_run === null);
  assert.equal((body.daily as { tool_calls: number }).tool_calls, 0);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /test-token|test-password|dj-tool-token/u);
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('hotline review list projects only redacted fields and review actions enforce transitions', async () => {
  const fixture = await testFixture({ hotlineEnabled: true, hotlineImportEnabled: true, badwords: ['forbidden phrase'] });
  const { store } = fixture;
  await voicemail(fixture.config.voicemailsDir, 'vm-2026-07-06T01-00-00', 'This has a forbidden phrase in it.');
  await voicemail(fixture.config.voicemailsDir, 'vm-2026-07-06T02-00-00', 'A friendly question about the overnight signal.');
  await importHotlines(store, fixture.config.voicemailsDir, fakeProbe);

  const review = store.listHotlineReview({});
  assert.equal(review.items.length, 2);
  const serialized = JSON.stringify(review);
  assert.doesNotMatch(serialized, /415-555|CA_PRIVATE|transcript_private|locator/u);
  const flagged = (review.items as Array<Record<string, unknown>>).find((c) => c.status === 'NEEDS_REVIEW');
  const eligible = (review.items as Array<Record<string, unknown>>).find((c) => c.status === 'ELIGIBLE');
  assert.ok(flagged && eligible);
  assert.equal(flagged.dj_visible, false);
  assert.equal(eligible.dj_visible, true);

  // Approve a flagged call: operator override becomes DJ-visible with a new version.
  const approved = store.reviewHotline({ candidateId: String(flagged.candidate_id), action: 'approve', expectedModerationVersion: Number(flagged.moderation_version), idempotencyKey: 'review:1' });
  assert.equal(approved.status, 'ELIGIBLE');
  assert.equal(approved.moderation_version, Number(flagged.moderation_version) + 1);
  assert.equal(store.listHotlineCandidates({}).items.length, 2);

  // A source rescan with unchanged content must not fight the operator decision.
  await importHotlines(store, fixture.config.voicemailsDir, fakeProbe);
  const afterRescan = store.db.prepare('SELECT status,moderation_version,operator_override FROM hotline_candidates WHERE call_id=?').get('vm-2026-07-06T01-00-00') as Record<string, unknown>;
  assert.deepEqual(afterRescan, { status: 'ELIGIBLE', moderation_version: approved.moderation_version, operator_override: 'APPROVED' });

  // Stale version is refused.
  await assert.rejects(async () => store.reviewHotline({ candidateId: String(flagged.candidate_id), action: 'reject', expectedModerationVersion: Number(flagged.moderation_version), idempotencyKey: 'review:2' }), (error: { code?: string }) => error.code === 'MODERATION_VERSION_CONFLICT');

  // Reject with the fresh version sticks across rescans.
  const rejected = store.reviewHotline({ candidateId: String(flagged.candidate_id), action: 'reject', expectedModerationVersion: Number(approved.moderation_version), idempotencyKey: 'review:3' });
  assert.equal(rejected.status, 'REJECTED');
  await importHotlines(store, fixture.config.voicemailsDir, fakeProbe);
  assert.equal((store.db.prepare('SELECT status FROM hotline_candidates WHERE call_id=?').get('vm-2026-07-06T01-00-00') as { status: string }).status, 'REJECTED');
  assert.equal(store.listHotlineCandidates({}).items.length, 1);

  // Changed source content clears the override and re-screens deterministically.
  await voicemail(fixture.config.voicemailsDir, 'vm-2026-07-06T01-00-00', 'Entirely new caller words, no flags now.');
  await importHotlines(store, fixture.config.voicemailsDir, fakeProbe);
  const rescreened = store.db.prepare('SELECT status,operator_override FROM hotline_candidates WHERE call_id=?').get('vm-2026-07-06T01-00-00') as Record<string, unknown>;
  assert.deepEqual(rescreened, { status: 'ELIGIBLE', operator_override: null });

  store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('single-asset lookup returns catalog fields only and 404s on unknown ids', async () => {
  const fixture = await testFixture();
  const { store, config } = fixture;
  const assetId = testAsset(store, 'lookup target', 'music', 90_000, 'Lookup Artist');
  const server = createServer(store, config);
  const origin = await listen(server);
  const unauthorized = await fetch(`${origin}/internal/catalog/assets/${assetId}`);
  assert.equal(unauthorized.status, 401);
  const found = await fetch(`${origin}/internal/catalog/assets/${assetId}`, { headers: AUTH });
  assert.equal(found.status, 200);
  const body = await found.json() as Record<string, unknown>;
  assert.deepEqual({ asset_id: body.asset_id, title: body.title, status: body.status }, { asset_id: assetId, title: 'lookup target', status: 'READY' });
  assert.doesNotMatch(JSON.stringify(body), /locator|sha256|checksum|provenance|probe/u);
  const missing = await fetch(`${origin}/internal/catalog/assets/ast_${'0'.repeat(32)}`, { headers: AUTH });
  assert.equal(missing.status, 404);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('review and moderation changes are atomic across the whole cue group: any claimed/playing sibling blocks all mutation', async () => {
  const fixture = await testFixture({ hotlineEnabled: true, badwords: ['forbidden phrase'] });
  const { store } = fixture;
  await voicemail(fixture.config.voicemailsDir, 'vm-2026-07-06T05-00-00', 'A gentle report from the night desk.');
  await importHotlines(store, fixture.config.voicemailsDir, fakeProbe);
  const candidate = store.db.prepare('SELECT id,moderation_version FROM hotline_candidates WHERE call_id=?').get('vm-2026-07-06T05-00-00') as { id: string; moderation_version: number };
  const nextTrack = testAsset(store, 'group destination', 'music', 180_000, 'Sibling Artist');
  const group = store.enqueueHotlineGroup({
    candidateId: candidate.id, moderationVersion: candidate.moderation_version,
    introScript: 'A caller checked in from the night desk.', outroScript: 'Back to the music.',
    nextTrackAssetId: nextTrack, expectedRevision: store.revision(), idempotencyKey: 'atomic:group',
  });
  const groupId = String(group.group_id);
  const children = store.db.prepare('SELECT id,group_role,state FROM cues WHERE group_id=? ORDER BY group_index').all(groupId) as Array<{ id: string; group_role: string; state: string }>;
  assert.deepEqual(children.map((c) => c.group_role), ['intro', 'call', 'outro', 'destination']);

  const statesSnapshot = () => store.db.prepare('SELECT id,state FROM cues WHERE group_id=? ORDER BY group_index').all(groupId);
  const groupState = () => (store.db.prepare('SELECT state FROM cue_groups WHERE id=?').get(groupId) as { state: string }).state;

  // Every sibling role, when CLAIMED or PLAYING, blocks reject/moderation
  // change with NO partial mutation.
  for (const role of ['intro', 'call', 'outro', 'destination']) {
    for (const activeState of ['CLAIMED', 'PLAYING']) {
      const sibling = children.find((c) => c.group_role === role)!;
      store.db.prepare('UPDATE cues SET state=? WHERE id=?').run(activeState, sibling.id);
      const before = JSON.stringify(statesSnapshot());
      const beforeGroup = groupState();
      const beforeRevision = store.revision();
      await assert.rejects(
        async () => store.reviewHotline({ candidateId: candidate.id, action: 'reject', expectedModerationVersion: candidate.moderation_version, idempotencyKey: `atomic:${role}:${activeState}` }),
        (error: { code?: string }) => error.code === 'CANDIDATE_ACTIVE',
        `${role} ${activeState}`,
      );
      assert.equal(JSON.stringify(statesSnapshot()), before, `${role} ${activeState}: no cue state changed`);
      assert.equal(groupState(), beforeGroup, `${role} ${activeState}: group untouched`);
      assert.equal(store.revision(), beforeRevision, `${role} ${activeState}: revision untouched`);
      assert.equal((store.db.prepare('SELECT status FROM hotline_candidates WHERE id=?').get(candidate.id) as { status: string }).status, 'QUEUED');
      store.db.prepare('UPDATE cues SET state=? WHERE id=?').run('GENERATING', sibling.id);
    }
  }

  // The moderation-import path shares the same gate.
  store.db.prepare("UPDATE cues SET state='PLAYING' WHERE id=?").run(children[0]!.id);
  await assert.rejects(
    async () => store.registerHotline({ callId: 'vm-2026-07-06T05-00-00', assetId: String(store.db.prepare('SELECT asset_id FROM hotline_candidates WHERE id=?').pluck().get(candidate.id)), transcript: 'A different transcript now.', moderationVersion: candidate.moderation_version + 1 }),
    (error: { code?: string }) => error.code === 'CANDIDATE_ACTIVE',
  );
  store.db.prepare("UPDATE cues SET state='GENERATING' WHERE id=?").run(children[0]!.id);

  // Concurrent moderation conflict: a stale expected version cannot mutate.
  await assert.rejects(
    async () => store.reviewHotline({ candidateId: candidate.id, action: 'reject', expectedModerationVersion: candidate.moderation_version + 1, idempotencyKey: 'atomic:stale' }),
    (error: { code?: string }) => error.code === 'MODERATION_VERSION_CONFLICT',
  );
  assert.equal(groupState(), 'GENERATING');

  // With no active sibling the reject cancels the WHOLE group atomically.
  const rejected = store.reviewHotline({ candidateId: candidate.id, action: 'reject', expectedModerationVersion: candidate.moderation_version, idempotencyKey: 'atomic:final' });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(groupState(), 'CANCELED');
  const finalStates = store.db.prepare('SELECT DISTINCT state FROM cues WHERE group_id=?').all(groupId) as Array<{ state: string }>;
  assert.deepEqual(finalStates.map((row) => row.state), ['CANCELED']);

  store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('aired calls are terminal, archived calls restore explicitly, and rejecting a queued call cancels its group', async () => {
  const fixture = await testFixture({ hotlineEnabled: true, badwords: ['forbidden phrase'] });
  const { store } = fixture;
  await voicemail(fixture.config.voicemailsDir, 'vm-2026-07-06T03-00-00', 'A calm story about static.');
  await importHotlines(store, fixture.config.voicemailsDir, fakeProbe);
  const candidate = store.db.prepare('SELECT id,moderation_version FROM hotline_candidates WHERE call_id=?').get('vm-2026-07-06T03-00-00') as { id: string; moderation_version: number };

  // AIRED is sticky: no review action may touch it.
  store.db.prepare("UPDATE hotline_candidates SET status='AIRED',aired_at=?,archive_reason='AIRED' WHERE id=?").run(new Date().toISOString(), candidate.id);
  for (const action of ['approve', 'reject', 'restore'] as const) {
    await assert.rejects(async () => store.reviewHotline({ candidateId: candidate.id, action, expectedModerationVersion: candidate.moderation_version, idempotencyKey: `aired:${action}` }), (error: { code?: string }) => error.code === 'CANDIDATE_AIRED');
  }

  // Interrupted-archived (unaired) restores to review with a new version.
  store.db.prepare("UPDATE hotline_candidates SET status='ARCHIVED',aired_at=NULL,archive_reason='PLAYOUT_INTERRUPTED' WHERE id=?").run(candidate.id);
  const restored = store.reviewHotline({ candidateId: candidate.id, action: 'restore', expectedModerationVersion: candidate.moderation_version, idempotencyKey: 'restore:1' });
  assert.equal(restored.status, 'ELIGIBLE');
  assert.equal(restored.moderation_version, candidate.moderation_version + 1);
  assert.equal(restored.operator_override, 'RESTORED');
  assert.equal((store.db.prepare('SELECT archive_reason FROM hotline_candidates WHERE id=?').get(candidate.id) as { archive_reason: string | null }).archive_reason, null);

  // Restoring a non-archived candidate is an invalid transition.
  await assert.rejects(async () => store.reviewHotline({ candidateId: candidate.id, action: 'restore', expectedModerationVersion: Number(restored.moderation_version), idempotencyKey: 'restore:2' }), (error: { code?: string }) => error.code === 'INVALID_REVIEW_TRANSITION');

  // Queue the restored call in an atomic group, then reject it: the group and
  // generated children cancel, and the candidate cannot be selected again.
  const nextTrack = testAsset(store, 'destination track', 'music', 180_000, 'Group Artist');
  const revision = store.revision();
  const group = store.enqueueHotlineGroup({
    candidateId: candidate.id, moderationVersion: Number(restored.moderation_version),
    introScript: 'A listener left a calm story about static.', outroScript: null,
    nextTrackAssetId: nextTrack, expectedRevision: revision, idempotencyKey: 'group:1',
  });
  assert.equal((store.db.prepare('SELECT status FROM hotline_candidates WHERE id=?').get(candidate.id) as { status: string }).status, 'QUEUED');
  const rejected = store.reviewHotline({ candidateId: candidate.id, action: 'reject', expectedModerationVersion: Number(restored.moderation_version), idempotencyKey: 'reject:queued' });
  assert.equal(rejected.status, 'REJECTED');
  const groupState = store.db.prepare('SELECT state FROM cue_groups WHERE id=?').get(String(group.group_id)) as { state: string };
  assert.equal(groupState.state, 'CANCELED');
  const childStates = store.db.prepare('SELECT DISTINCT state FROM cues WHERE group_id=?').all(String(group.group_id)) as Array<{ state: string }>;
  assert.deepEqual(childStates.map((row) => row.state), ['CANCELED']);
  assert.equal(store.listHotlineCandidates({}).items.length, 0);

  // Idempotent replay returns the original result without another transition.
  const replay = store.reviewHotline({ candidateId: candidate.id, action: 'reject', expectedModerationVersion: Number(restored.moderation_version), idempotencyKey: 'reject:queued' });
  assert.deepEqual(replay, rejected);

  store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

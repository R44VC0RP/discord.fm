import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AutomationConfig } from '../types.js';
import { AutomationStore } from '../store.js';
import { importMusic } from '../importer.js';
import { DomainError } from '../errors.js';
import { createServer } from '../server.js';
import { loadConfig } from '../config.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..');
const migrationsDir = path.join(packageRoot, 'migrations');

function config(root: string, overrides: Partial<AutomationConfig> = {}): AutomationConfig {
  return {
    databasePath: path.join(root, 'state', 'station.db'), migrationsDir, musicDir: path.join(root, 'music'), generatedDir: path.join(root, 'generated'), recordingsDir: path.join(root, 'recordings'), voicemailsDir: path.join(root, 'voicemails'),
    bind: '127.0.0.1', port: 8092, internalToken: 'test-token', allowUnauthenticated: false, maxBodyBytes: 65_536,
    claimLeaseMs: 30_000, maxQueueCues: 100, maxHorizonMs: 7_200_000, lowCueCount: 12, highCueCount: 24,
    lowHorizonMs: 2_700_000, targetHorizonMs: 5_400_000, assetRepeatMs: 21_600_000, artistRepeatMs: 7_200_000,
    crossfadeMs: 3000, badwords: ['forbidden phrase'], hotlineEnabled: true, playoutEnabled: true, djEnabled: false, djShadow: false, aiArchiveEnabled: false,
    generationEnabled: false, hotlineImportEnabled: false, speechBadwords: ['speech-blocked'], elevenLabsKey: '', elevenLabsVoiceId: '', elevenLabsModelId: 'eleven_multilingual_v2', elevenLabsBaseUrl: 'https://api.elevenlabs.io',
    generationPollMs: 2000, generationLeaseMs: 120_000, generatedMaxBytes: 10_000_000, generatedBudgetBytes: 2_147_483_648,
    opencodeUrl: 'http://127.0.0.1:4096', opencodeUsername: 'opencode', opencodePassword: 'test-password', djModel: 'opencode/test', djToolToken: 'dj-tool-token-0123456789abcdef012345', djPollMs: 15_000, djTimeoutMs: 60_000, djLeaseMs: 120_000, djCooldownMs: 300_000,
    djDailyToolLimit: 200, djDailyModelTokenLimit: 200_000, ttsDailyCharacterLimit: 20_000,
    feedDir: path.join(root, 'feed'), rerunAuto: true, rerunAfterLiveMs: 35 * 60_000, rerunGapMs: 35 * 60_000, rerunPollMs: 1000,
    djFakeProviderEnabled: false,
    stationTimeZone: 'America/New_York',
    ...overrides,
  };
}

async function fixture(overrides: Partial<AutomationConfig> = {}): Promise<{ root: string; store: AutomationStore }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anomaly-automation-'));
  await fsp.mkdir(path.join(root, 'music'));
  return { root, store: new AutomationStore(config(root, overrides)) };
}

function checksum(seed: string): string { return crypto.createHash('sha256').update(seed).digest('hex'); }

function asset(store: AutomationStore, seed: string, kind: 'music' | 'spoken' | 'hotline' | 'rerun' | 'station_id' = 'music', durationMs = 180_000, artist = 'Test Artist'): string {
  fs.mkdirSync(store.config.generatedDir, { recursive: true });
  const locator = path.join(store.config.generatedDir, `${seed}.mp3`);
  fs.writeFileSync(locator, seed);
  return store.putAsset({ kind, checksum: checksum(seed), sourceLocator: locator, playoutLocator: locator, title: seed, artist, durationMs, mimeType: 'audio/mpeg', codecName: 'mp3', sampleRateHz: 48_000, channels: 2, bitRate: 128_000 }).assetId;
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error) => error instanceof DomainError && error.code === code);
}

test('migrations are versioned and queue survives a restart', async () => {
  const { root, store } = await fixture();
  const music = asset(store, 'persistent');
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'persist:1' });
  assert.equal(store.ready().migrationVersion, 7);
  store.close();
  const restarted = new AutomationStore(config(root));
  assert.equal(restarted.revision(), 1);
  assert.equal((restarted.queueSnapshot().cues as unknown[]).length, 1);
  assert.equal((restarted.db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]?.journal_mode, 'wal');
  assert.equal(restarted.db.pragma('foreign_keys', { simple: true }), 1);
  restarted.close();
  await fsp.rm(root, { recursive: true, force: true });
});

test('migrations fail closed when the database contains an unshipped applied version', async () => {
  const { root, store } = await fixture();
  store.db.prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)')
    .run(999, '999_removed.sql', '0'.repeat(64), new Date().toISOString());
  store.close();
  assert.throws(() => new AutomationStore(config(root)), /applied migrations absent from this build: 999/u);
  await fsp.rm(root, { recursive: true, force: true });
});

test('online backup is integrity-checked and readable after live writes', async () => {
  const { root, store } = await fixture();
  const music = asset(store, 'backup');
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'backup:enqueue' });
  const backup = await store.backup();
  assert.equal(backup.integrity, 'ok');
  assert.equal(fs.existsSync(backup.path), true);
  const restored = new AutomationStore({ ...config(root), databasePath: backup.path });
  assert.equal(restored.revision(), 1);
  restored.close(); store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('revision checks are fail-closed and idempotency returns the original result', async () => {
  const { root, store } = await fixture();
  const music = asset(store, 'idempotent');
  const input = { assetId: music, expectedRevision: 0, idempotencyKey: 'run:track:1' };
  const first = store.enqueueTrack(input);
  assert.deepEqual(store.enqueueTrack(input), first);
  assert.equal((store.queueSnapshot().cues as unknown[]).length, 1);
  const other = asset(store, 'other', 'music', 180_000, 'Other Artist');
  expectCode(() => store.enqueueTrack({ assetId: other, expectedRevision: 0, idempotencyKey: 'run:track:2' }), 'REVISION_CONFLICT');
  expectCode(() => store.enqueueTrack({ ...input, assetId: other }), 'IDEMPOTENCY_CONFLICT');
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('idempotency maintenance retains fresh retries and prunes expired keys', async () => {
  const { root, store } = await fixture();
  store.db.prepare("INSERT INTO idempotency_keys(scope,key,request_hash,response_json,created_at) VALUES(?,?,?,?,?)")
    .run('old', 'old:key', 'a'.repeat(64), '{}', '2000-01-01T00:00:00.000Z');
  const music = asset(store, 'idempotency-prune');
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'fresh:key' });
  assert.equal((store.db.prepare("SELECT count(*) count FROM idempotency_keys WHERE scope='old'").get() as { count: number }).count, 0);
  assert.equal((store.db.prepare("SELECT count(*) count FROM idempotency_keys WHERE scope='enqueue_track'").get() as { count: number }).count, 1);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('completed history drives asset repeat filtering', async () => {
  const { root, store } = await fixture();
  const music = asset(store, 'repeat');
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'repeat:enqueue' });
  store.presence({ humans: 0, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_one' });
  const claim = store.claim({ expectedRevision: 1, workerId: 'worker_one', idempotencyKey: 'repeat:claim' });
  const claimed = claim.cue as Record<string, unknown>;
  const cueId = String(claimed.cue_id); const token = String(claimed.claim_token);
  store.start(cueId, { expectedRevision: 2, workerId: 'worker_one', claimToken: token, idempotencyKey: 'repeat:start' });
  store.complete(cueId, { expectedRevision: 3, workerId: 'worker_one', claimToken: token, idempotencyKey: 'repeat:complete' });
  assert.equal(store.trackHistory().items.length, 1);
  expectCode(() => store.enqueueTrack({ assetId: music, expectedRevision: 4, idempotencyKey: 'repeat:again' }), 'REPEAT_BLOCKED');
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('queue counts duration, excludes generating inventory, and caps silence at five seconds', async () => {
  const { root, store } = await fixture();
  const music = asset(store, 'duration', 'music', 120_000);
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'duration:track' });
  store.enqueueCommentary({ script: 'A future rendered transition.', expectedRevision: 1, idempotencyKey: 'duration:commentary' });
  store.enqueueManualCue({ type: 'silence', durationMs: 5000, expectedRevision: 2, idempotencyKey: 'duration:silence' });
  const snapshot = store.queueSnapshot();
  assert.equal(snapshot.ready_count, 1);
  assert.equal(snapshot.ready_duration_ms, 120_000);
  assert.equal(snapshot.generating_count, 1);
  expectCode(() => store.enqueueManualCue({ type: 'silence', durationMs: 5001, expectedRevision: 3, idempotencyKey: 'duration:too-long' }), 'SILENCE_LIMIT');
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('queue count and horizon caps reject mutations atomically', async () => {
  const { root, store } = await fixture({ maxQueueCues: 1, maxHorizonMs: 200_000 });
  const first = asset(store, 'cap-first', 'music', 120_000, 'First Artist');
  const second = asset(store, 'cap-second', 'music', 120_000, 'Second Artist');
  store.enqueueTrack({ assetId: first, expectedRevision: 0, idempotencyKey: 'cap:first' });
  expectCode(() => store.enqueueTrack({ assetId: second, expectedRevision: 1, idempotencyKey: 'cap:second' }), 'QUEUE_CAP_EXCEEDED');
  assert.equal(store.revision(), 1);
  store.close(); await fsp.rm(root, { recursive: true, force: true });

  const horizonFixture = await fixture({ maxQueueCues: 10, maxHorizonMs: 200_000 });
  const horizonFirst = asset(horizonFixture.store, 'horizon-first', 'music', 120_000, 'Horizon One');
  const horizonSecond = asset(horizonFixture.store, 'horizon-second', 'music', 100_000, 'Horizon Two');
  horizonFixture.store.enqueueTrack({ assetId: horizonFirst, expectedRevision: 0, idempotencyKey: 'horizon:first' });
  expectCode(() => horizonFixture.store.enqueueTrack({ assetId: horizonSecond, expectedRevision: 1, idempotencyKey: 'horizon:second' }), 'HORIZON_CAP_EXCEEDED');
  assert.equal(horizonFixture.store.revision(), 1);
  horizonFixture.store.close(); await fsp.rm(horizonFixture.root, { recursive: true, force: true });
});

test('rendered commentary duration cannot grow the active queue past its horizon cap', async () => {
  const { root, store } = await fixture({ maxHorizonMs: 200_000 });
  const queued = store.enqueueCommentary({ script: 'A bounded future transition.', expectedRevision: 0, idempotencyKey: 'render-cap:queue' });
  const rendered = asset(store, 'render-cap-long', 'spoken', 250_000);
  const result = store.completeGeneration({ jobId: (queued.generation_job_ids as string[])[0] as string, assetId: rendered, expectedRevision: 1, idempotencyKey: 'render-cap:complete' });
  assert.equal(result.accepted, false); assert.equal(result.failure_code, 'HORIZON_CAP_EXCEEDED');
  assert.equal(store.revision(), 2);
  assert.equal((store.queueSnapshot().cues as unknown[]).length, 0);
  const row = store.db.prepare('SELECT state,failure_code,public_metadata_json FROM cues').get() as { state: string; failure_code: string; public_metadata_json: string };
  assert.equal(row.state, 'FAILED'); assert.equal(row.failure_code, 'HORIZON_CAP_EXCEEDED');
  assert.equal((JSON.parse(row.public_metadata_json) as { title: string }).title, 'render-cap-long');
  assert.equal((store.db.prepare('SELECT state FROM generation_jobs').get() as { state: string }).state, 'FAILED');
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('successful commentary completion publishes safe metadata from its rendered asset', async () => {
  const { root, store } = await fixture();
  const queued = store.enqueueCommentary({ script: 'A rendered station transition.', expectedRevision: 0, idempotencyKey: 'metadata:queue' });
  const rendered = asset(store, 'Rendered Commentary', 'spoken', 12_000, 'Anomaly FM');
  const completed = store.completeGeneration({ jobId: (queued.generation_job_ids as string[])[0] as string, assetId: rendered, expectedRevision: 1, idempotencyKey: 'metadata:complete' });
  assert.equal(completed.state, 'READY');
  const cue = store.db.prepare('SELECT state,public_metadata_json FROM cues WHERE id=?').get(queued.cue_id) as { state: string; public_metadata_json: string };
  assert.equal(cue.state, 'READY');
  assert.deepEqual(JSON.parse(cue.public_metadata_json), { title: 'Rendered Commentary', artist: 'Anomaly FM' });
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('deterministic refill acts only below low watermarks and stops at targets', async () => {
  const { root, store } = await fixture({ lowCueCount: 2, highCueCount: 2, lowHorizonMs: 300_000, targetHorizonMs: 300_000 });
  asset(store, 'refill-one', 'music', 180_000, 'Refill One');
  asset(store, 'refill-two', 'music', 180_000, 'Refill Two');
  const filled = store.refillDeterministic({ expectedRevision: 0, idempotencyKey: 'refill:first' });
  assert.equal((filled.cue_ids as string[]).length, 2);
  assert.equal(store.queueSnapshot().ready_duration_ms, 360_000);
  const noOp = store.refillDeterministic({ expectedRevision: 2, idempotencyKey: 'refill:healthy' });
  assert.deepEqual(noOp.cue_ids, []);
  assert.equal(noOp.queue_revision, 2);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('catalog tag filtering happens before pagination and produces a correct cursor', async () => {
  const { root, store } = await fixture();
  const ids = [asset(store, 'tag-a', 'music', 60_000, 'Tag A'), asset(store, 'tag-b', 'music', 60_000, 'Tag B'), asset(store, 'tag-c', 'music', 60_000, 'Tag C')].sort();
  store.db.prepare("UPDATE assets SET tags_json='[\"other\"]' WHERE id=?").run(ids[0]);
  store.db.prepare("UPDATE assets SET tags_json='[\"wanted\"]' WHERE id IN (?,?)").run(ids[1], ids[2]);
  const first = store.listCatalog({ tags: ['wanted'], limit: 1 });
  assert.equal((first.items[0] as { asset_id: string }).asset_id, ids[1]); assert.equal(first.nextCursor, ids[1]);
  const second = store.listCatalog({ tags: ['wanted'], limit: 1, cursor: first.nextCursor });
  assert.equal((second.items[0] as { asset_id: string }).asset_id, ids[2]); assert.equal(second.nextCursor, null);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('hotline screening redacts PII, blocks configured badwords, and exposes only safe candidates', async () => {
  const { root, store } = await fixture();
  const safeAudio = asset(store, 'safe-call', 'hotline', 30_000);
  const badAudio = asset(store, 'bad-call', 'hotline', 30_000);
  const safe = store.registerHotline({ callId: 'call_safe', assetId: safeAudio, transcript: 'Call me at 415-555-0123 or me@example.com about radio.', moderationVersion: 1 });
  const bad = store.registerHotline({ callId: 'call_bad', assetId: badAudio, transcript: 'This includes a FORBIDDEN phrase.', moderationVersion: 1 });
  assert.equal(safe.status, 'ELIGIBLE'); assert.equal(bad.status, 'NEEDS_REVIEW');
  const candidates = store.listHotlineCandidates().items as Array<Record<string, unknown>>;
  assert.equal(candidates.length, 1);
  assert.match(String(candidates[0]?.transcript), /\[redacted phone\]/u);
  assert.match(String(candidates[0]?.transcript), /\[redacted email\]/u);
  assert.doesNotMatch(JSON.stringify(candidates), /415-555|me@example/u);
  assert.equal((store.db.prepare("SELECT count(*) count FROM hotline_candidates WHERE screen_result='BADWORD'").get() as { count: number }).count, 1);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('hotline group is atomically admitted only after every generated child is ready', async () => {
  const { root, store } = await fixture();
  const call = asset(store, 'group-call', 'hotline', 20_000);
  const next = asset(store, 'group-next', 'music', 180_000, 'Next Artist');
  const introAudio = asset(store, 'group-intro', 'spoken', 8000);
  const outroAudio = asset(store, 'group-outro', 'spoken', 7000);
  const candidate = store.registerHotline({ callId: 'call_group', assetId: call, transcript: 'I enjoy the midnight signal.', moderationVersion: 1 });
  const group = store.enqueueHotlineGroup({ candidateId: String(candidate.candidate_id), moderationVersion: 1, introScript: 'A listener has a thought about the midnight signal.', outroScript: 'Thanks for keeping the dial steady.', nextTrackAssetId: next, expectedRevision: 0, idempotencyKey: 'group:1' });
  assert.equal(group.state, 'GENERATING');
  const rows = store.db.prepare('SELECT id,generation_id,state FROM cues WHERE group_id=? ORDER BY group_index').all(group.group_id) as Array<{ id: string; generation_id: string | null; state: string }>;
  assert.equal(rows.length, 4); assert.ok(rows.every((row) => row.state === 'GENERATING'));
  const jobs = store.db.prepare('SELECT j.id FROM generation_jobs j JOIN cues c ON c.generation_id=j.generation_id WHERE c.group_id=? ORDER BY c.group_index').all(group.group_id) as Array<{ id: string }>;
  const first = store.completeGeneration({ jobId: jobs[0]?.id as string, assetId: introAudio, expectedRevision: 1, idempotencyKey: 'generation:intro' });
  assert.equal(first.admitted, false);
  assert.equal((store.db.prepare("SELECT count(*) count FROM cues WHERE group_id=? AND state='READY'").get(group.group_id) as { count: number }).count, 0);
  assert.deepEqual(store.completeGeneration({ jobId: jobs[0]?.id as string, assetId: introAudio, expectedRevision: 1, idempotencyKey: 'generation:intro' }), first);
  const second = store.completeGeneration({ jobId: jobs[1]?.id as string, assetId: outroAudio, expectedRevision: 2, idempotencyKey: 'generation:outro' });
  assert.equal(second.admitted, true);
  assert.equal((store.db.prepare("SELECT count(*) count FROM cues WHERE group_id=? AND state='READY'").get(group.group_id) as { count: number }).count, 4);
  const generatedMetadata = store.db.prepare("SELECT group_role,public_metadata_json FROM cues WHERE group_id=? AND group_role IN ('intro','outro') ORDER BY group_role").all(group.group_id) as Array<{ group_role: string; public_metadata_json: string }>;
  assert.deepEqual(generatedMetadata.map((row) => [row.group_role, (JSON.parse(row.public_metadata_json) as { title: string }).title]), [['intro', 'group-intro'], ['outro', 'group-outro']]);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('hotline group render overflow fails atomically and restores the unaired candidate', async () => {
  const { root, store } = await fixture({ maxHorizonMs: 300_000 });
  const call = asset(store, 'overflow-call', 'hotline', 20_000);
  const next = asset(store, 'overflow-next', 'music', 180_000, 'Overflow Next');
  const candidate = store.registerHotline({ callId: 'call_overflow', assetId: call, transcript: 'A safe thought about late radio.', moderationVersion: 1 });
  const group = store.enqueueHotlineGroup({ candidateId: String(candidate.candidate_id), moderationVersion: 1, introScript: 'A listener has a late radio thought.', nextTrackAssetId: next, expectedRevision: 0, idempotencyKey: 'overflow:group' });
  const rendered = asset(store, 'overflow-intro', 'spoken', 120_000);
  const result = store.completeGeneration({ jobId: (group.generation_job_ids as string[])[0] as string, assetId: rendered, expectedRevision: 1, idempotencyKey: 'overflow:complete' });
  assert.equal(result.state, 'FAILED'); assert.equal(result.queue_revision, 2);
  assert.equal((store.db.prepare('SELECT state FROM cue_groups WHERE id=?').get(group.group_id) as { state: string }).state, 'FAILED');
  assert.equal((store.db.prepare(`SELECT count(*) count FROM cues WHERE group_id=? AND state IN ('DRAFT','GENERATING','VALIDATING','READY','CLAIMED','PLAYING')`).get(group.group_id) as { count: number }).count, 0);
  assert.equal((store.db.prepare('SELECT status FROM hotline_candidates WHERE id=?').get(candidate.candidate_id) as { status: string }).status, 'ELIGIBLE');
  assert.equal((store.listHotlineCandidates().items as unknown[]).length, 1);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('expired cues reconcile transactionally, free capacity, and force stale writers to refresh', async () => {
  const { root, store } = await fixture({ maxQueueCues: 1 });
  const oldAsset = asset(store, 'expiry-old', 'music', 120_000, 'Expiry Old');
  const newAsset = asset(store, 'expiry-new', 'music', 120_000, 'Expiry New');
  const old = store.enqueueTrack({ assetId: oldAsset, expectedRevision: 0, idempotencyKey: 'expiry:old', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  store.db.prepare("UPDATE cues SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(old.cue_id);
  expectCode(() => store.enqueueTrack({ assetId: newAsset, expectedRevision: 1, idempotencyKey: 'expiry:stale' }), 'REVISION_CONFLICT');
  assert.equal(store.revision(), 2);
  assert.equal((store.db.prepare('SELECT state FROM cues WHERE id=?').get(old.cue_id) as { state: string }).state, 'CANCELED');
  const replacement = store.enqueueTrack({ assetId: newAsset, expectedRevision: 2, idempotencyKey: 'expiry:replacement' });
  assert.equal(replacement.queue_revision, 3);
  assert.equal((store.db.prepare("SELECT count(*) count FROM cue_events WHERE event_type='EXPIRED'").get() as { count: number }).count, 1);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('expiring a generating hotline group cancels jobs and restores candidate eligibility', async () => {
  const { root, store } = await fixture();
  const call = asset(store, 'expiry-call', 'hotline', 20_000);
  const next = asset(store, 'expiry-next', 'music', 180_000, 'Expiry Destination');
  const candidate = store.registerHotline({ callId: 'call_expiry', assetId: call, transcript: 'A safe unplayed call.', moderationVersion: 1 });
  const group = store.enqueueHotlineGroup({ candidateId: String(candidate.candidate_id), moderationVersion: 1, introScript: 'A listener left a safe call.', nextTrackAssetId: next, expectedRevision: 0, idempotencyKey: 'expiry:group', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  store.db.prepare("UPDATE cues SET expires_at='2000-01-01T00:00:00.000Z' WHERE group_id=?").run(group.group_id);
  const candidates = store.listHotlineCandidates().items as unknown[];
  assert.equal(store.revision(), 2); assert.equal(candidates.length, 1);
  assert.equal((store.db.prepare('SELECT state FROM cue_groups WHERE id=?').get(group.group_id) as { state: string }).state, 'CANCELED');
  assert.equal((store.db.prepare('SELECT state FROM generation_jobs').get() as { state: string }).state, 'CANCELED');
  assert.equal((store.db.prepare('SELECT status FROM hotline_candidates WHERE id=?').get(candidate.candidate_id) as { status: string }).status, 'ELIGIBLE');
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('playout claim/start/heartbeat/complete enforces ownership and transitions', async () => {
  const { root, store } = await fixture();
  const music = asset(store, 'lifecycle');
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'life:enqueue' });
  store.presence({ humans: 0, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_life' });
  const result = store.claim({ expectedRevision: 1, workerId: 'worker_life', idempotencyKey: 'life:claim' });
  const cue = result.cue as Record<string, unknown>; const cueId = String(cue.cue_id); const token = String(cue.claim_token);
  expectCode(() => store.start(cueId, { expectedRevision: 2, workerId: 'worker_other', claimToken: token, idempotencyKey: 'life:bad-owner' }), 'CLAIM_OWNERSHIP');
  assert.equal(store.start(cueId, { expectedRevision: 2, workerId: 'worker_life', claimToken: token, idempotencyKey: 'life:start' }).state, 'PLAYING');
  assert.equal(store.heartbeat(cueId, { expectedRevision: 3, workerId: 'worker_life', claimToken: token, idempotencyKey: 'life:heartbeat', offsetMs: 10_000 }).queue_revision, 3);
  assert.equal(store.complete(cueId, { expectedRevision: 3, workerId: 'worker_life', claimToken: token, idempotencyKey: 'life:complete', offsetMs: 180_000 }).state, 'COMPLETED');
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('presence holds a speech boundary without skipping or leapfrogging', async () => {
  const { root, store } = await fixture();
  const spoken = asset(store, 'presence-speech', 'spoken', 10_000);
  store.enqueueManualCue({ type: 'spoken', assetId: spoken, expectedRevision: 0, idempotencyKey: 'presence:enqueue' });
  store.presence({ humans: 1, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_presence' });
  const claim = store.claim({ expectedRevision: 1, workerId: 'worker_presence', idempotencyKey: 'presence:claim' });
  assert.equal(claim.cue, null); assert.equal(claim.held_for_presence, true);
  assert.equal((store.queueSnapshot().cues as Array<Record<string, unknown>>)[0]?.state, 'READY');
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('startup presence is unknown: delayed join blocks every claim and first human snapshot holds speech', async () => {
  const { root, store } = await fixture();
  const spoken = asset(store, 'startup-speech', 'spoken', 10_000);
  store.enqueueManualCue({ type: 'spoken', assetId: spoken, expectedRevision: 0, idempotencyKey: 'startup:enqueue' });
  const unknown = store.claim({ expectedRevision: 1, workerId: 'worker_startup', idempotencyKey: 'startup:unknown' });
  assert.equal(unknown.cue, null); assert.equal(unknown.held_for_presence_unknown, true);
  store.presence({ humans: 2, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_startup' });
  const occupied = store.claim({ expectedRevision: 1, workerId: 'worker_startup', idempotencyKey: 'startup:occupied' });
  assert.equal(occupied.cue, null); assert.equal(occupied.held_for_presence, true);
  store.presenceUnknown({ observedAt: new Date(Date.now() + 2000).toISOString(), workerId: 'worker_reconnect' });
  assert.equal((store.queueSnapshot().presence as { known: number }).known, 0);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('playout refuses READY catalog rows when immutable bytes change', async () => {
  const { root, store } = await fixture();
  const music = asset(store, 'tamper');
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'tamper:enqueue' });
  store.presence({ humans: 0, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_tamper' });
  const locator = (store.db.prepare('SELECT playout_locator FROM assets WHERE id=?').get(music) as { playout_locator: string }).playout_locator;
  fs.writeFileSync(locator, 'changed bytes');
  expectCode(() => store.claim({ expectedRevision: 1, workerId: 'worker_tamper', idempotencyKey: 'tamper:claim' }), 'CHECKSUM_MISMATCH');
  assert.equal(store.revision(), 1);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('asset catalog and claim reject symlink escape and post-catalog symlink replacement', async () => {
  const { root, store } = await fixture();
  fs.mkdirSync(store.config.generatedDir, { recursive: true });
  const outside = path.join(root, 'outside.mp3');
  fs.writeFileSync(outside, 'outside bytes');
  const link = path.join(store.config.generatedDir, 'outside-link.mp3');
  fs.symlinkSync(outside, link);
  expectCode(() => store.putAsset({ kind: 'music', checksum: checksum('outside bytes'), sourceLocator: link, playoutLocator: link, title: 'escape', durationMs: 1000, mimeType: 'audio/mpeg', codecName: 'mp3', sampleRateHz: 48_000, channels: 2, bitRate: 96_000 }), 'INVALID_LOCATOR');

  const music = asset(store, 'symlink-race', 'music', 120_000, 'Symlink Artist');
  store.enqueueTrack({ assetId: music, expectedRevision: 0, idempotencyKey: 'symlink:enqueue' });
  store.presence({ humans: 0, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_symlink' });
  const locator = (store.db.prepare('SELECT playout_locator FROM assets WHERE id=?').get(music) as { playout_locator: string }).playout_locator;
  fs.unlinkSync(locator); fs.symlinkSync(outside, locator);
  expectCode(() => store.claim({ expectedRevision: 1, workerId: 'worker_symlink', idempotencyKey: 'symlink:claim' }), 'INVALID_LOCATOR');
  assert.equal(store.revision(), 1);
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('music importer probes and hashes in place idempotently', async () => {
  const { root, store } = await fixture();
  const file = path.join(root, 'music', 'Example.mp3');
  await fsp.writeFile(file, 'fake mp3 bytes');
  const probe = async () => ({ durationMs: 123_000, codecName: 'mp3', sampleRateHz: 48_000, channels: 2, bitRate: 96_000, mimeType: 'audio/mpeg', title: 'Imported', artist: 'Artist' });
  const first = await importMusic(store, path.join(root, 'music'), probe);
  const second = await importMusic(store, path.join(root, 'music'), probe);
  assert.deepEqual({ discovered: first.discovered, created: first.created, existing: first.existing, failed: first.failed.length }, { discovered: 1, created: 1, existing: 0, failed: 0 });
  assert.equal(second.created, 0); assert.equal(second.existing, 1);
  assert.equal(await fsp.readFile(file, 'utf8'), 'fake mp3 bytes');
  const row = store.db.prepare('SELECT source_locator,content_sha256 FROM assets').get() as { source_locator: string; content_sha256: string };
  assert.equal(row.source_locator, fs.realpathSync(file)); assert.equal(row.content_sha256, checksum('fake mp3 bytes'));
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('HTTP API requires bearer auth and returns structured validation errors', async () => {
  const { root, store } = await fixture();
  const server = createServer(store, config(root));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const unauthorized = await fetch(`${origin}/internal/queue/snapshot`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json() as { error: { code: string } }).error.code, 'UNAUTHORIZED');
  const invalid = await fetch(`${origin}/internal/queue/commentary`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ script: 'hello', expected_queue_revision: 0, idempotency_key: 'http:1', surprise: true }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'UNKNOWN_FIELDS');
  const health = await fetch(`${origin}/readyz`);
  assert.equal(health.status, 200);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close(); await fsp.rm(root, { recursive: true, force: true });
});

test('deploy preflight assumptions protect every durable root', () => {
  assert.equal(fs.statSync(path.join(repoRoot, 'scripts', 'deploy-preflight.sh')).isFile(), true);
  execFileSync('sh', [path.join(repoRoot, 'scripts', 'deploy-preflight.sh'), '--check-local'], { cwd: repoRoot, stdio: 'pipe' });
  const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  for (const root of ['state/*', 'generated/*', 'music/originals/*', 'music/ready/*']) assert.match(agents, new RegExp(root.replace(/[/*]/g, (v) => `\\${v}`), 'u'));
});

test('all automation behavior flags default literally false', () => {
  const names = ['AUTOMATION_PLAYOUT_ENABLED', 'AUTOMATION_DJ_ENABLED', 'AUTOMATION_DJ_SHADOW', 'AUTOMATION_HOTLINE_ENABLED', 'AUTOMATION_HOTLINE_IMPORT_ENABLED', 'AUTOMATION_GENERATION_ENABLED', 'AUTOMATION_AI_ARCHIVE_ENABLED', 'AUTOMATION_DJ_FAKE_PROVIDER_ENABLED'] as const;
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const defaults = loadConfig();
    assert.deepEqual([defaults.playoutEnabled, defaults.djEnabled, defaults.djShadow, defaults.hotlineEnabled, defaults.hotlineImportEnabled, defaults.generationEnabled, defaults.aiArchiveEnabled, defaults.djFakeProviderEnabled], [false, false, false, false, false, false, false, false]);
  } finally {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const example = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  for (const name of names) {
    assert.ok(compose.includes(`${name}: \${${name}:-false}`));
    assert.match(example, new RegExp(`^${name}=false(?:\\s|$)`, 'mu'));
  }
});

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AutomationStore } from '../store.js';
import { RerunScheduler } from '../rerun-scheduler.js';
import { testConfig, testFixture } from './helpers.js';
import { DomainError } from '../errors.js';

const probe = async () => ({ durationMs: 60_000, codecName: 'mp3', sampleRateHz: 48_000, channels: 2, bitRate: 96_000, mimeType: 'audio/mpeg' });

test('rerun scheduler migrates once, paces, cycles, resumes, queues, and exports rollback state', async () => {
  const fixture = await testFixture({ rerunAfterLiveMs: 10_000, rerunGapMs: 10_000, rerunPollMs: 1000 });
  const files = ['session-2026-01-01T00-00-00.mp3', 'session-2026-01-02T00-00-00.mp3'];
  await Promise.all(files.map((file) => fsp.writeFile(path.join(fixture.config.recordingsDir, file), file)));
  await fsp.writeFile(path.join(fixture.config.feedDir, 'rerun-state.json'), JSON.stringify({ played: [files[0]] }));
  const scheduler = new RerunScheduler(fixture.store, fixture.config, probe);
  await scheduler.initialize();
  assert.equal((fixture.store.queueSnapshot().cues as unknown[]).length, 0, 'unknown presence must not schedule');
  const observed = new Date(Date.now() + 1000).toISOString();
  fixture.store.presence({ humans: 0, observedAt: observed, workerId: 'worker_rerun' });
  await scheduler.tick();
  assert.equal((fixture.store.queueSnapshot().cues as unknown[]).length, 0, 'post-live gate must apply to first known empty observation');
  const state = fixture.store.rerunState(); state.lastLiveEndedAt = new Date(Date.now() - 20_000).toISOString();
  fixture.store.db.prepare("UPDATE scheduler_state SET value_json=? WHERE key='rerun_v1'").run(JSON.stringify(state));
  await scheduler.tick();
  let cue = (fixture.store.queueSnapshot().cues as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(cue.type, 'rerun'); assert.match((cue.public_metadata as { title: string }).title, /Jan 1 \| 7:00 PM/u);
  assert.equal(fixture.store.queueSnapshot().ready_count, 0, 'deterministic filler must not satisfy DJ watermarks');

  let revision = fixture.store.revision();
  let claim = fixture.store.claim({ expectedRevision: revision++, workerId: 'worker_rerun', idempotencyKey: 'rerun:claim:1' });
  let claimed = claim.cue as Record<string, unknown>;
  fixture.store.start(String(claimed.cue_id), { expectedRevision: revision++, workerId: 'worker_rerun', claimToken: String(claimed.claim_token), idempotencyKey: 'rerun:start:1' });
  fixture.store.heartbeat(String(claimed.cue_id), { expectedRevision: revision, workerId: 'worker_rerun', claimToken: String(claimed.claim_token), idempotencyKey: 'rerun:heart:1', offsetMs: 12_000 });
  fixture.store.interrupt(String(claimed.cue_id), { expectedRevision: revision++, workerId: 'worker_rerun', claimToken: String(claimed.claim_token), idempotencyKey: 'rerun:interrupt:1', reason: 'BOT_RESTART', offsetMs: 12_000 });
  cue = (fixture.store.queueSnapshot().cues as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(cue.state, 'READY'); assert.equal(cue.last_offset_ms, 12_000);

  fixture.store.close();
  const restarted = new AutomationStore(testConfig(fixture.root, { rerunAfterLiveMs: 10_000, rerunGapMs: 10_000 }));
  const resumedScheduler = new RerunScheduler(restarted, restarted.config, probe);
  await resumedScheduler.initialize();
  revision = restarted.revision();
  claim = restarted.claim({ expectedRevision: revision++, workerId: 'worker_restart', idempotencyKey: 'rerun:claim:resume' });
  claimed = claim.cue as Record<string, unknown>;
  assert.equal(claimed.last_offset_ms, 12_000);
  restarted.start(String(claimed.cue_id), { expectedRevision: revision++, workerId: 'worker_restart', claimToken: String(claimed.claim_token), idempotencyKey: 'rerun:start:resume' });
  restarted.complete(String(claimed.cue_id), { expectedRevision: revision++, workerId: 'worker_restart', claimToken: String(claimed.claim_token), idempotencyKey: 'rerun:complete:resume', offsetMs: 60_000 });
  await resumedScheduler.tick();
  assert.equal((restarted.queueSnapshot().cues as unknown[]).length, 0, 'inter-rerun gap must hold');

  // Manual queue bypasses both pacing and the exhausted-cycle wait.
  await resumedScheduler.queue(files[0]!);
  cue = (restarted.queueSnapshot().cues as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal((restarted.db.prepare('SELECT source FROM cues WHERE id=?').get(cue.cue_id) as { source: string }).source, 'admin_rerun');
  revision = restarted.revision();
  claim = restarted.claim({ expectedRevision: revision++, workerId: 'worker_skip', idempotencyKey: 'rerun:claim:skip' });
  claimed = claim.cue as Record<string, unknown>;
  restarted.start(String(claimed.cue_id), { expectedRevision: revision++, workerId: 'worker_skip', claimToken: String(claimed.claim_token), idempotencyKey: 'rerun:start:skip' });
  restarted.complete(String(claimed.cue_id), { expectedRevision: revision, workerId: 'worker_skip', claimToken: String(claimed.claim_token), idempotencyKey: 'rerun:skip', offsetMs: 1000 });
  await resumedScheduler.tick();
  const rollback = JSON.parse(await fsp.readFile(path.join(fixture.config.feedDir, 'rerun-state.automation-export.json'), 'utf8')) as { played: string[] };
  assert.deepEqual(rollback.played.sort(), files);

  // Legacy changes after migration cannot rewind the authoritative cycle.
  await fsp.writeFile(path.join(fixture.config.feedDir, 'rerun-state.json'), JSON.stringify({ played: [] }));
  await resumedScheduler.initialize();
  assert.deepEqual(restarted.rerunState().played.sort(), files);
  restarted.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('persistent rerun auto control is versioned/idempotent, survives restart, and manual queue bypasses OFF', async () => {
  const fixture = await testFixture({ rerunAfterLiveMs: 0, rerunGapMs: 0, rerunPollMs: 1000 });
  const files = ['session-2026-02-01T00-00-00.mp3', 'session-2026-02-02T00-00-00.mp3'];
  await Promise.all(files.map((file) => fsp.writeFile(path.join(fixture.config.recordingsDir, file), file)));
  const scheduler = new RerunScheduler(fixture.store, fixture.config, probe);
  await scheduler.initialize();

  assert.deepEqual(fixture.store.rerunAutoSetting(), { enabled: true, version: 1 }, 'migration defaults ON');
  const off = await scheduler.setAuto(false, 1, 'rerun:auto:off');
  assert.equal(off.auto, false); assert.equal(off.control_version, 2);
  const replay = await scheduler.setAuto(false, 1, 'rerun:auto:off');
  assert.equal((replay.mutation as { version: number }).version, 2, 'same logical mutation replays its durable result');
  assert.throws(() => fixture.store.setRerunAuto({ enabled: true, expectedVersion: 1, idempotencyKey: 'rerun:auto:stale' }),
    (error: unknown) => error instanceof DomainError && error.code === 'RERUN_VERSION_CONFLICT');

  fixture.store.presence({ humans: 0, observedAt: new Date(Date.now() + 1000).toISOString(), workerId: 'worker_toggle' });
  await scheduler.tick();
  assert.equal((fixture.store.queueSnapshot().cues as unknown[]).length, 0, 'OFF blocks deterministic filler');

  await scheduler.queue(files[0]!);
  let cue = (fixture.store.queueSnapshot().cues as Array<Record<string, unknown>>)[0]!;
  assert.equal(cue.type, 'rerun');
  assert.equal((fixture.store.db.prepare('SELECT source FROM cues WHERE id=?').get(cue.cue_id) as { source: string }).source, 'admin_rerun', 'explicit operator queue bypasses OFF');
  let revision = fixture.store.revision();
  let claim = fixture.store.claim({ expectedRevision: revision++, workerId: 'worker_manual', idempotencyKey: 'manual:claim' });
  let claimed = claim.cue as Record<string, unknown>;
  fixture.store.start(String(claimed.cue_id), { expectedRevision: revision++, workerId: 'worker_manual', claimToken: String(claimed.claim_token), idempotencyKey: 'manual:start' });
  fixture.store.complete(String(claimed.cue_id), { expectedRevision: revision, workerId: 'worker_manual', claimToken: String(claimed.claim_token), idempotencyKey: 'manual:complete', offsetMs: 60_000 });

  const ungated = fixture.store.rerunState();
  ungated.lastLiveEndedAt = new Date(Date.now() - 10_000).toISOString();
  ungated.lastFinishedAt = new Date(Date.now() - 10_000).toISOString();
  fixture.store.db.prepare("UPDATE scheduler_state SET value_json=? WHERE key='rerun_v1'").run(JSON.stringify(ungated));
  const beforeCycle = fixture.store.rerunState();
  await scheduler.setAuto(true, 2, 'rerun:auto:on');
  cue = (fixture.store.queueSnapshot().cues as Array<Record<string, unknown>>).find((item) => item.type === 'rerun' && item.state === 'READY')!;
  assert.ok(cue, 're-enable resumes deterministic rotation');
  const disabledReady = await scheduler.setAuto(false, 3, 'rerun:auto:cancel-ready');
  assert.equal((disabledReady.mutation as { canceled_ready: boolean }).canceled_ready, true, 'OFF withdraws unclaimed filler competing with DJ music');
  assert.deepEqual(fixture.store.rerunState().played, beforeCycle.played, 'toggle does not reset or repeat the cycle');

  await scheduler.setAuto(true, 4, 'rerun:auto:on-again');
  revision = fixture.store.revision();
  claim = fixture.store.claim({ expectedRevision: revision++, workerId: 'worker_playing', idempotencyKey: 'auto:claim' });
  claimed = claim.cue as Record<string, unknown>;
  fixture.store.start(String(claimed.cue_id), { expectedRevision: revision, workerId: 'worker_playing', claimToken: String(claimed.claim_token), idempotencyKey: 'auto:start' });
  const disabledPlaying = await scheduler.setAuto(false, 5, 'rerun:auto:while-playing');
  assert.equal((disabledPlaying.mutation as { canceled_ready: boolean }).canceled_ready, false);
  assert.equal((fixture.store.db.prepare('SELECT state FROM cues WHERE id=?').get(claimed.cue_id) as { state: string }).state, 'PLAYING', 'OFF never interrupts playing rerun');

  fixture.store.close();
  const restarted = new AutomationStore(testConfig(fixture.root, { rerunAfterLiveMs: 0, rerunGapMs: 0 }));
  assert.deepEqual(restarted.rerunAutoSetting(), { enabled: false, version: 6 }, 'durable setting wins after restart');
  assert.deepEqual(restarted.rerunState().played, beforeCycle.played);
  restarted.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AutomationStore } from '../store.js';
import { RerunScheduler } from '../rerun-scheduler.js';
import { testConfig, testFixture } from './helpers.js';

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

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BYTES_PER_FRAME, Mixer, type ProgramFrameSource } from '../src/mixer.js';
import { PlayoutController } from '../src/playout.js';
import { AutomationStore } from '../../automation/src/store.js';
import { createServer } from '../../automation/src/server.js';
import { importMusic } from '../../automation/src/importer.js';
import type { AutomationConfig } from '../../automation/src/types.js';
import { ProgramSource, verifyProgramAsset } from '../src/program.js';
import { RerunScheduler } from '../../automation/src/rerun-scheduler.js';
import { testConfig } from '../../automation/src/test/helpers.js';

class Tone implements ProgramFrameSource {
  constructor(private readonly value: number) {}
  readFrame(): Buffer { const frame = Buffer.alloc(BYTES_PER_FRAME); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(this.value, i); return frame; }
}
class CountingTone implements ProgramFrameSource {
  frames = 0;
  constructor(private readonly value: number) {}
  readFrame(): Buffer { this.frames += 1; return toneFrame(this.value); }
}
class FiniteTone implements ProgramFrameSource {
  frames = 0;
  constructor(private remaining: number, private readonly value: number) {}
  get finished(): boolean { return this.remaining <= 0; }
  readFrame(): Buffer | null { if (this.remaining <= 0) return null; this.remaining -= 1; this.frames += 1; return toneFrame(this.value); }
}
class PositionedTone extends Tone {
  constructor(value: number, public positionMs: number) { super(value); }
}
class OneFrameTone implements ProgramFrameSource {
  private done = false;
  get finished(): boolean { return this.done; }
  readFrame(): Buffer | null { if (this.done) return null; this.done = true; return new Tone(1000).readFrame(); }
}

function sample(frame: Buffer): number { return frame.readInt16LE(0); }
function toneFrame(value: number): Buffer { const frame = Buffer.alloc(BYTES_PER_FRAME); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(value, i); return frame; }
function write(mixer: Mixer, n: number): void {
  const privateMixer = mixer as unknown as { writeFrame(): void };
  for (let i = 0; i < n; i += 1) privateMixer.writeFrame();
}
async function pumpMixerUntil(mixer: Mixer, condition: () => boolean, maxFrames = 10_000): Promise<void> {
  for (let index = 0; index < maxFrames; index += 1) {
    write(mixer, 1);
    if (condition()) return;
    if (index % 5 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`mixer condition not met within ${maxFrames} frames`);
}
function silenceGroup(store: AutomationStore, prefix: string, durations = [80, 100]): string[] {
  const ids: string[] = [];
  for (const [index, durationMs] of durations.entries()) {
    const result = store.enqueueManualCue({ type: 'silence', durationMs, expectedRevision: store.revision(), idempotencyKey: `${prefix}:cue:${index}` }) as { cue_id: string };
    ids.push(result.cue_id);
  }
  const groupId = `grp_${prefix.replaceAll(/[^a-z0-9]/giu, '')}`; const timestamp = new Date().toISOString();
  store.db.prepare("INSERT INTO cue_groups(id,kind,state,source,created_at,updated_at) VALUES(?, 'TEST_SEQUENCE', 'READY', 'manual', ?, ?)").run(groupId, timestamp, timestamp);
  ids.forEach((cueId, index) => store.db.prepare('UPDATE cues SET group_id=?,group_index=? WHERE id=?').run(groupId, index, cueId));
  return ids;
}

test('automation bus ducks for 1.2s and recovers for 3s without stopping its source', () => {
  const mixer = new Mixer(); const out: Buffer[] = [];
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.configureAutomation({ baseGain: 1, duckGain: 0.1, stepDown: 1 / 60, stepUp: 1 / 150 });
  assert.equal(mixer.setProgramSource(new Tone(10_000)), true);
  write(mixer, 1); assert.equal(sample(out.at(-1)!), 10_000);
  mixer.setAutomationDucked(true); write(mixer, 60);
  assert.ok(Math.abs(sample(out.at(-1)!) - 1000) <= 2);
  mixer.setAutomationDucked(false); write(mixer, 150);
  assert.ok(Math.abs(sample(out.at(-1)!) - 10_000) <= 2);
});

test('a source attached while live begins at the duck target', () => {
  const mixer = new Mixer(); const out: Buffer[] = [];
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.configureAutomation({ baseGain: 1, duckGain: 0.1, stepDown: 1 / 60, stepUp: 1 / 150 });
  mixer.setAutomationDucked(true);
  mixer.setProgramSource(new Tone(10_000)); write(mixer, 1);
  assert.ok(Math.abs(sample(out[0]!) - 1000) <= 2);
});

test('station ident smoothly ducks automation music to 20%, advances it, and recovers', () => {
  const mixer = new Mixer(); const out: Buffer[] = []; const program = new CountingTone(10_000);
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.configureAutomation({ baseGain: 1, duckGain: 0.1, stepDown: 1 / 60, stepUp: 1 / 150 });
  mixer.setProgramSource(program, false);
  write(mixer, 1);
  assert.equal(mixer.tryPlayAnnouncement(Buffer.alloc(BYTES_PER_FRAME * 30)), true);
  write(mixer, 30);
  assert.ok(Math.abs(sample(out[14]!) - 2000) <= 2, `underlay=${sample(out[14]!)}`);
  assert.equal(program.frames, 31, 'cue progression must not pause under an ident');
  write(mixer, 14);
  assert.ok(Math.abs(sample(out.at(-1)!) - 10_000) <= 2);
  const values = out.map(sample);
  assert.ok(values.slice(1).every((value, index) => Math.abs(value - values[index]!) <= 601), 'duck envelope must have no click-sized step');
});

test('live-human master duck composes safely with an in-progress station ident', () => {
  const mixer = new Mixer(); const out: Buffer[] = [];
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.configureAutomation({ baseGain: 1, duckGain: 0.1, stepDown: 1, stepUp: 1 });
  mixer.setAutomationDucked(true);
  mixer.setProgramSource(new Tone(10_000), false);
  mixer.pushUser('host', Buffer.concat(Array.from({ length: 20 }, () => toneFrame(5000))));
  assert.equal(mixer.tryPlayAnnouncement(Buffer.alloc(BYTES_PER_FRAME * 20)), true);
  write(mixer, 14);
  // Human remains full-level: 5000 + (10000 * live .1 * ident .2).
  assert.ok(Math.abs(sample(out.at(-1)!) - 5200) <= 2, `composed=${sample(out.at(-1)!)}`);
  assert.ok(out.every((frame) => Math.abs(sample(frame)) < 32767));
});

test('station overlay admission rejects automation spoken/hotline and pending speech', () => {
  for (const type of ['spoken', 'hotline'] as const) {
    const mixer = new Mixer();
    const controller = new PlayoutController(mixer, { enabled: true, url: 'http://127.0.0.1:1', token: 'test', assetRoots: [], crossfadeMs: 3000 });
    const internal = controller as unknown as { presenceKnown: boolean; humans: number; active: unknown; nextType: string | null };
    internal.presenceKnown = true; internal.humans = 0;
    internal.active = { cue: { cue_id: `cue_${type}`, type, planned_duration_ms: 1000, claim_token: 'token', claim_expires_at: new Date(Date.now() + 10_000).toISOString() }, source: new Tone(1000), startedAt: Date.now(), leaseExpiresAt: Date.now() + 10_000 };
    assert.equal(controller.canAirStationOverlay(), false, type);
  }
  const mixer = new Mixer();
  const controller = new PlayoutController(mixer, { enabled: true, url: 'http://127.0.0.1:1', token: 'test', assetRoots: [], crossfadeMs: 3000 });
  const internal = controller as unknown as { presenceKnown: boolean; humans: number; active: unknown; nextType: string | null };
  internal.presenceKnown = true; internal.humans = 0;
  internal.active = { cue: { cue_id: 'cue_music', type: 'music', planned_duration_ms: 1000, claim_token: 'token', claim_expires_at: new Date(Date.now() + 10_000).toISOString() }, source: new Tone(1000), startedAt: Date.now(), leaseExpiresAt: Date.now() + 10_000 };
  internal.nextType = 'spoken';
  assert.equal(controller.canAirStationOverlay(), false);

  // Defense in depth: even a low-level forced overlap never ducks speech twice.
  const forced = new Mixer(); const out: Buffer[] = [];
  forced.setSink((frame) => out.push(Buffer.from(frame)));
  forced.configureAutomation({ baseGain: 1, duckGain: 0.1, stepDown: 1, stepUp: 1 });
  forced.setProgramSource(new Tone(10_000), true);
  forced.playAnnouncement(Buffer.alloc(BYTES_PER_FRAME * 20)); write(forced, 14);
  assert.equal(sample(out.at(-1)!), 10_000);
});

test('legacy rerun announcement duck and recovery remain unchanged without automation', () => {
  const mixer = new Mixer(); const out: Buffer[] = [];
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.setDeckSource(new Tone(10_000)); write(mixer, 1);
  mixer.playAnnouncement(Buffer.alloc(BYTES_PER_FRAME * 20)); write(mixer, 20);
  assert.ok(Math.abs(sample(out[14]!) - 2000) <= 2);
  write(mixer, 14);
  assert.ok(Math.abs(sample(out.at(-1)!) - 10_000) <= 2);
});

test('equal-power music crossfade has no silent frame and stays below clipping', () => {
  const mixer = new Mixer(); const out: Buffer[] = [];
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.configureAutomation({ baseGain: 1, duckGain: 0.1, stepDown: 1, stepUp: 1 });
  mixer.setProgramSource(new Tone(12_000));
  assert.equal(mixer.crossfadeProgramSource(new Tone(12_000), 3000), true);
  write(mixer, 150);
  const values = out.map(sample);
  assert.ok(values.every((value) => value !== 0));
  assert.ok(Math.max(...values.map(Math.abs)) < 32767);
  assert.ok(Math.abs(values[75] ?? 0) > 12_000, 'equal-power midpoint retains energy');
});

test('90,044ms music transition produces a full 6s equal-power audible overlap', () => {
  const mixer = new Mixer(); const out: Buffer[] = [];
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const outgoing = new FiniteTone(Math.ceil(90_044 / 20), 10_000);
  const incoming = new FiniteTone(Math.ceil(90_044 / 20), 10_000);
  mixer.setProgramSource(outgoing);
  // Decoder exists but cannot advance or become audible before attachment.
  write(mixer, Math.ceil((90_044 - 6250) / 20));
  assert.equal(incoming.frames, 0);
  assert.equal(mixer.crossfadeProgramSource(incoming, 6000), true);
  const start = out.length; write(mixer, 300);
  assert.equal(outgoing.frames - Math.ceil((90_044 - 6250) / 20), 300);
  assert.equal(incoming.frames, 300);
  const overlap = out.slice(start).map(sample);
  assert.equal(overlap.length * 20, 6000);
  assert.ok(overlap.every((value) => value !== 0));
  assert.ok(Math.abs(overlap[149]!) > 13_500, `midpoint=${overlap[149]}`);
  assert.ok(Math.max(...overlap.map(Math.abs)) < 32767);
  assert.ok(overlap.slice(1).every((value, index) => Math.abs(value - overlap[index]!) < 500), 'equal-power envelope must not click');
});

test('one-shot crossfade deadline fires ~250ms early and cancels at protected boundaries', async () => {
  const make = (nextType: 'music' | 'spoken', reserved = false) => {
    const mixer = new Mixer(); const controller = new PlayoutController(mixer, { enabled: true, url: 'http://127.0.0.1:1', token: 'test', assetRoots: [], crossfadeMs: 6000, crossfadeLeadMs: 250 });
    const source = new PositionedTone(1000, 83_790); let claims = 0;
    const internal = controller as unknown as { active: unknown; nextType: string; nextTransitionMs: number; stationOverlayReserved: boolean; scheduleCrossfadeDeadline(): void; claimAndStart(crossfade: boolean): Promise<void>; snapshot(): Promise<void>; loseLease(reason: string): Promise<void>; interrupt(): Promise<void>; crossfadeTimer: NodeJS.Timeout | null };
    internal.active = { cue: { cue_id: 'cue_90s', type: 'music', planned_duration_ms: 90_044, claim_token: 'token', claim_expires_at: new Date(Date.now() + 30_000).toISOString() }, source, startedAt: Date.now(), leaseExpiresAt: Date.now() + 30_000 };
    internal.nextType = nextType; internal.nextTransitionMs = 6000; internal.stationOverlayReserved = reserved;
    internal.snapshot = async () => {};
    internal.claimAndStart = async (crossfade) => { assert.equal(crossfade, true); claims += 1; };
    return { controller, internal, source, get claims() { return claims; } };
  };
  const due = make('music'); due.internal.scheduleCrossfadeDeadline(); due.internal.scheduleCrossfadeDeadline();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(due.claims, 1, 'remaining 6254ms should trigger once after about 4ms'); due.internal.active = null; due.controller.stop();

  const overlayRace = make('music');
  overlayRace.internal.snapshot = async () => { overlayRace.internal.stationOverlayReserved = true; };
  overlayRace.internal.scheduleCrossfadeDeadline(); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(overlayRace.claims, 0, 'an ident reserved during discovery keeps a hard boundary');
  overlayRace.internal.active = null; overlayRace.controller.stop();

  const speech = make('spoken'); speech.internal.scheduleCrossfadeDeadline();
  assert.equal(speech.internal.crossfadeTimer, null, 'music→speech is a hard boundary'); speech.internal.active = null; speech.controller.stop();

  const reserved = make('music', true); reserved.internal.scheduleCrossfadeDeadline();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reserved.claims, 0, 'ident reservation blocks prefetch/claim'); reserved.internal.active = null; reserved.controller.stop();

  const stopped = make('music'); stopped.internal.scheduleCrossfadeDeadline(); stopped.internal.active = null; stopped.controller.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped.claims, 0, 'stop cancels deadline');

  const leaseLost = make('music'); leaseLost.source.positionMs = 83_000; leaseLost.internal.scheduleCrossfadeDeadline();
  leaseLost.internal.interrupt = async () => {}; await leaseLost.internal.loseLease('TEST_LEASE_LOST');
  assert.equal(leaseLost.internal.crossfadeTimer, null); assert.equal(leaseLost.claims, 0);

  const failed = make('music'); let failedCalls = 0; failed.internal.claimAndStart = async () => { failedCalls += 1; throw new Error('injected claim failure'); };
  failed.internal.scheduleCrossfadeDeadline(); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(failedCalls, 1); assert.equal(failed.internal.crossfadeTimer, null);
  failed.internal.active = null; failed.controller.stop();
});

test('stored 3s transition remains authoritative after default changes to 6s', () => {
  const controller = new PlayoutController(new Mixer(), { enabled: true, url: 'http://127.0.0.1:1', token: 'test', assetRoots: [], crossfadeMs: 6000 });
  const internal = controller as unknown as { crossfadeMsForCue(cue: unknown): number };
  assert.equal(internal.crossfadeMsForCue({ transition: { kind: 'crossfade', duration_ms: 3000 } }), 3000);
  assert.equal(internal.crossfadeMsForCue({ transition: null }), 6000);
  controller.stop();
});

test('asset verification rejects checksum tampering and symlink escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'anomaly-program-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, 'assets'); await mkdir(assets);
  const file = join(assets, 'cue.mp3'); await writeFile(file, 'immutable audio');
  const digest = crypto.createHash('sha256').update('immutable audio').digest('hex');
  assert.match((await verifyProgramAsset(file, digest, [assets])).path, /\/assets\/cue\.mp3$/u);
  await writeFile(file, 'changed audio');
  await assert.rejects(() => verifyProgramAsset(file, digest, [assets]), /checksum/u);
  const outside = join(root, 'outside.mp3'); await writeFile(outside, 'outside');
  await symlink(outside, join(assets, 'escape.mp3'));
  const outsideDigest = crypto.createHash('sha256').update('outside').digest('hex');
  await assert.rejects(() => verifyProgramAsset(join(assets, 'escape.mp3'), outsideDigest, [assets]), /symlink/u);
});

test('controller observes claim/start/complete and exposes no locator or checksum', async (t) => {
  const http = await import('node:http');
  const events: string[] = [];
  let revision = 0;
  let claimed = false;
  const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${req.url}`;
    events.push(route);
    for await (const _chunk of req) { /* consume request */ }
    let body: object;
    if (route === 'GET /internal/playout/snapshot') body = { queue_revision: revision, ready_count: 1, cues: [{ state: 'READY', type: 'silence' }] };
    else if (route === 'POST /internal/playout/claim') {
      if (claimed) body = { queue_revision: revision, cue: null };
      else { claimed = true; revision = 1; body = { queue_revision: revision, cue: { cue_id: 'cue_silence', type: 'silence', planned_duration_ms: 20, claim_token: 'claim_token', claim_expires_at: new Date(Date.now() + 20_000).toISOString(), public_metadata: { title: 'Quiet' } } }; }
    }
    else if (route.includes('/start')) { revision = 2; body = { queue_revision: revision }; }
    else if (route.includes('/complete')) { revision = 3; body = { queue_revision: revision }; }
    else body = { queue_revision: revision };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {});
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'test', assetRoots: [], crossfadeMs: 3000 });
  const internal = controller as unknown as { tick(): Promise<void> };
  await controller.setPresence(0);
  await internal.tick();
  write(mixer, 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(events.some((event) => event.includes('/claim')));
  assert.ok(events.some((event) => event.includes('/start')));
  assert.ok(events.some((event) => event.includes('/complete')));
  const projection = controller.publicState();
  assert.doesNotMatch(JSON.stringify(projection), /locator|checksum|claim_token/u);
});

test('controller speaks the real automation playout API worker-id contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'anomaly-playout-api-'));
  const automationRoot = join(process.cwd(), '..', 'automation');
  const cfg: AutomationConfig = {
    databasePath: join(root, 'state.db'), migrationsDir: join(automationRoot, 'migrations'), musicDir: root, generatedDir: root, recordingsDir: root, voicemailsDir: root,
    bind: '127.0.0.1', port: 0, internalToken: 'integration-token', allowUnauthenticated: false, maxBodyBytes: 65536, claimLeaseMs: 30_000,
    maxQueueCues: 100, maxHorizonMs: 7_200_000, lowCueCount: 12, highCueCount: 24, lowHorizonMs: 2_700_000, targetHorizonMs: 5_400_000,
    assetRepeatMs: 1, artistRepeatMs: 1, crossfadeMs: 3000, badwords: [], hotlineEnabled: false, playoutEnabled: true, djEnabled: false, djShadow: false, aiArchiveEnabled: false,
  };
  const store = new AutomationStore(cfg);
  store.enqueueManualCue({ type: 'silence', durationMs: 20, expectedRevision: 0, idempotencyKey: 'integration:silence' });
  const server = createServer(store, cfg);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); });
  const address = server.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {});
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'integration-token', assetRoots: [], crossfadeMs: 3000 });
  await controller.setPresence(0);
  await (controller as unknown as { tick(): Promise<void> }).tick();
  write(mixer, 1);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const cue = store.db.prepare('SELECT state FROM cues').get() as { state: string };
  const worker = store.db.prepare("SELECT actor FROM cue_events WHERE event_type='CLAIMED'").get() as { actor: string };
  assert.equal(cue.state, 'COMPLETED');
  assert.match(worker.actor, /^bot_[a-z0-9_]{32}$/u);
});

test('dropped committed claim response replays the identical request and preserves group order', async (t) => {
  const http = await import('node:http'); const root = await mkdtemp(join(tmpdir(), 'anomaly-claim-loss-'));
  await Promise.all(['music', 'generated', 'recordings', 'voicemails', 'feed'].map((dir) => mkdir(join(root, dir))));
  const cfg = testConfig(root, { playoutEnabled: true, claimLeaseMs: 30_000 }); const store = new AutomationStore(cfg);
  const cueIds = silenceGroup(store, 'loss');
  const backend = createServer(store, cfg); await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendAddress = backend.address() as import('node:net').AddressInfo;
  const claimBodies: Array<Record<string, unknown>> = []; let dropped = false;
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); const route = req.url ?? '/';
    if (route === '/internal/playout/claim') claimBodies.push(JSON.parse(body.toString()) as Record<string, unknown>);
    const upstream = await fetch(`http://127.0.0.1:${backendAddress.port}${route}`, { method: req.method, headers: { authorization: String(req.headers.authorization ?? ''), ...(body.length ? { 'content-type': 'application/json' } : {}) }, body: body.length ? body : undefined });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (route === '/internal/playout/claim' && !dropped) { dropped = true; req.socket.destroy(); return; }
    res.statusCode = upstream.status; res.setHeader('content-type', 'application/json'); res.end(bytes);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)); const proxyAddress = proxy.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${proxyAddress.port}`, token: cfg.internalToken, assetRoots: [], crossfadeMs: 500, pollMs: 10, claimAmbiguityMs: 5000 });
  await controller.setPresence(0); mixer.start(); controller.start();
  t.after(async () => { controller.stop(); mixer.stop(); await (controller as unknown as { serial: Promise<void> }).serial; await new Promise<void>((resolve) => proxy.close(() => resolve())); await new Promise<void>((resolve) => backend.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); });
  await waitFor(() => cueIds.every((id) => (store.db.prepare('SELECT state FROM cues WHERE id=?').get(id) as { state: string }).state === 'COMPLETED'), 10_000);
  assert.ok(claimBodies.length >= 3, `claim calls=${claimBodies.length}`);
  assert.deepEqual(claimBodies[1], claimBodies[0], 'ambiguous claim must replay byte-equivalent logical request');
  const events = store.db.prepare("SELECT cue_id,event_type FROM cue_events WHERE event_type IN ('CLAIMED','STARTED','COMPLETED') ORDER BY id").all() as Array<{ cue_id: string; event_type: string }>;
  const completedFirst = events.findIndex((event) => event.cue_id === cueIds[0] && event.event_type === 'COMPLETED');
  const claimedSecond = events.findIndex((event) => event.cue_id === cueIds[1] && event.event_type === 'CLAIMED');
  assert.ok(completedFirst >= 0 && claimedSecond > completedFirst, JSON.stringify(events));
  assert.equal(events.filter((event) => event.event_type === 'CLAIMED').length, 2);
});

test('restart after unrecoverable claim ambiguity holds cue2 until old lease reconciliation', async (t) => {
  const http = await import('node:http'); const root = await mkdtemp(join(tmpdir(), 'anomaly-claim-restart-'));
  await Promise.all(['music', 'generated', 'recordings', 'voicemails', 'feed'].map((dir) => mkdir(join(root, dir))));
  const cfg = testConfig(root, { playoutEnabled: true, claimLeaseMs: 30_000 }); const store = new AutomationStore(cfg);
  const cueIds = silenceGroup(store, 'restart');
  const backend = createServer(store, cfg); await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendAddress = backend.address() as import('node:net').AddressInfo; let dropped = false;
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks); const route = req.url ?? '/';
    const upstream = await fetch(`http://127.0.0.1:${backendAddress.port}${route}`, { method: req.method, headers: { authorization: String(req.headers.authorization ?? ''), ...(body.length ? { 'content-type': 'application/json' } : {}) }, body: body.length ? body : undefined });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (route === '/internal/playout/claim' && !dropped) { dropped = true; req.socket.destroy(); return; }
    res.statusCode = upstream.status; res.setHeader('content-type', 'application/json'); res.end(bytes);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)); const proxyAddress = proxy.address() as import('node:net').AddressInfo;
  const firstMixer = new Mixer(); firstMixer.setSink(() => {}); firstMixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const first = new PlayoutController(firstMixer, { enabled: true, url: `http://127.0.0.1:${proxyAddress.port}`, token: cfg.internalToken, assetRoots: [], crossfadeMs: 500, claimAmbiguityMs: 5000 });
  await first.setPresence(0); await (first as unknown as { tick(): Promise<void> }).tick();
  assert.equal((store.db.prepare("SELECT count(*) count FROM cues WHERE state='CLAIMED'").get() as { count: number }).count, 1);
  first.stop(); await (first as unknown as { serial: Promise<void> }).serial;

  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const restarted = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${backendAddress.port}`, token: cfg.internalToken, assetRoots: [], crossfadeMs: 500, pollMs: 10 });
  await restarted.setPresence(0); await (restarted as unknown as { tick(): Promise<void> }).tick();
  assert.equal((store.db.prepare("SELECT count(*) count FROM cue_events WHERE event_type='CLAIMED'").get() as { count: number }).count, 1, 'new worker must not leapfrog old claim');
  store.db.prepare("UPDATE cues SET claim_expires_at='2000-01-01T00:00:00.000Z' WHERE state='CLAIMED'").run(); store.reconcile();
  mixer.start(); restarted.start();
  t.after(async () => { restarted.stop(); mixer.stop(); await (restarted as unknown as { serial: Promise<void> }).serial; await new Promise<void>((resolve) => proxy.close(() => resolve())); await new Promise<void>((resolve) => backend.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); });
  await waitFor(() => cueIds.every((id) => (store.db.prepare('SELECT state FROM cues WHERE id=?').get(id) as { state: string }).state === 'COMPLETED'), 10_000);
  const starts = store.db.prepare("SELECT cue_id FROM cue_events WHERE event_type='STARTED' ORDER BY id").all() as Array<{ cue_id: string }>;
  assert.deepEqual(starts.map((row) => row.cue_id), cueIds);
});

test('claim ambiguity deadline reconciles the owned claim without issuing a fresh mutation', async (t) => {
  const http = await import('node:http'); const root = await mkdtemp(join(tmpdir(), 'anomaly-claim-deadline-'));
  await Promise.all(['music', 'generated', 'recordings', 'voicemails', 'feed'].map((dir) => mkdir(join(root, dir))));
  const cfg = testConfig(root, { playoutEnabled: true, claimLeaseMs: 30_000 }); const store = new AutomationStore(cfg);
  const cue = store.enqueueManualCue({ type: 'silence', durationMs: 100, expectedRevision: 0, idempotencyKey: 'deadline:cue' }) as { cue_id: string };
  const backend = createServer(store, cfg); await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendAddress = backend.address() as import('node:net').AddressInfo; let dropped = false; let ownedCalls = 0;
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks); const route = req.url ?? '/';
    if (route.startsWith('/internal/playout/owned-claim')) ownedCalls += 1;
    const upstream = await fetch(`http://127.0.0.1:${backendAddress.port}${route}`, { method: req.method, headers: { authorization: String(req.headers.authorization ?? ''), ...(body.length ? { 'content-type': 'application/json' } : {}) }, body: body.length ? body : undefined });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (route === '/internal/playout/claim' && !dropped) { dropped = true; req.socket.destroy(); return; }
    res.statusCode = upstream.status; res.setHeader('content-type', 'application/json'); res.end(bytes);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)); const proxyAddress = proxy.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${proxyAddress.port}`, token: cfg.internalToken, assetRoots: [], crossfadeMs: 500, pollMs: 10, claimAmbiguityMs: 50 });
  await controller.setPresence(0); mixer.start(); controller.start();
  t.after(async () => { controller.stop(); mixer.stop(); await (controller as unknown as { serial: Promise<void> }).serial; await new Promise<void>((resolve) => proxy.close(() => resolve())); await new Promise<void>((resolve) => backend.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); });
  await waitFor(() => (store.db.prepare('SELECT state FROM cues WHERE id=?').get(cue.cue_id) as { state: string }).state === 'COMPLETED', 5000);
  assert.equal(ownedCalls, 1);
  assert.equal((store.db.prepare("SELECT count(*) count FROM cue_events WHERE event_type='CLAIMED'").get() as { count: number }).count, 1);
});

test('heartbeat retains only transient failures and drops both crossfade leases on permanent rejection/expiry', async (t) => {
  const http = await import('node:http');
  let mode: 'transient' | 'network' | 'revision' | 'expired' | 'auth' | 'bad' | 'malformed' = 'transient'; let interrupts = 0; let revisionAttempts = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    if (req.url?.includes('/heartbeat')) {
      if (mode === 'network') { req.socket.destroy(); return; }
      if (mode === 'transient') { res.statusCode = 503; res.end(JSON.stringify({ error: { code: 'TEMPORARY', message: 'retry' } })); }
      else if (mode === 'revision' && revisionAttempts++ === 0) { res.statusCode = 409; res.end(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'refresh' } })); }
      else if (mode === 'revision') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: 0, claim_expires_at: new Date(Date.now() + 20_000).toISOString() })); }
      else if (mode === 'auth') { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } })); }
      else if (mode === 'bad') { res.statusCode = 400; res.end(JSON.stringify({ error: { code: 'INVALID_OFFSET', message: 'bad' } })); }
      else if (mode === 'malformed') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: 0 })); }
      else { res.statusCode = 409; res.end(JSON.stringify({ error: { code: 'CLAIM_EXPIRED', message: 'expired' } })); }
      return;
    }
    if (req.url?.includes('/interrupt')) interrupts += 1;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'test', assetRoots: [], crossfadeMs: 3000 });
  const internal = controller as unknown as { active: unknown; incoming: unknown; heartbeat(): Promise<void> };
  const install = (expired = false) => {
    const source = new Tone(1000); const next = new Tone(1000); mixer.setProgramSource(source); mixer.crossfadeProgramSource(next, 3000);
    const until = Date.now() + (expired ? -1 : 20_000);
    const cue = { cue_id: 'cue_lease', type: 'music' as const, planned_duration_ms: 10_000, claim_token: 'token', claim_expires_at: new Date(until).toISOString() };
    internal.active = { cue, source, startedAt: Date.now(), leaseExpiresAt: until };
    internal.incoming = { cue: { ...cue, cue_id: 'cue_next' }, source: next, startedAt: Date.now(), leaseExpiresAt: until };
  };
  install();
  await internal.heartbeat();
  assert.equal(mixer.automationActive, true, '5xx must not revoke a valid lease');
  mode = 'network'; await internal.heartbeat();
  assert.equal(mixer.automationActive, true, 'network errors must not revoke a valid lease');
  mode = 'revision'; revisionAttempts = 0; await internal.heartbeat();
  assert.equal(mixer.automationActive, true, 'revision conflict refreshes and retries before stopping');
  mode = 'auth'; await internal.heartbeat();
  assert.equal(mixer.automationActive, false);
  assert.equal(interrupts, 2);
  install(); mode = 'bad'; await internal.heartbeat();
  assert.equal(mixer.automationActive, false, '400 validation rejection fails closed');
  install(); mode = 'malformed'; await internal.heartbeat();
  assert.equal(mixer.automationActive, false, 'malformed successful response fails closed');
  install(); mode = 'expired'; await internal.heartbeat();
  assert.equal(mixer.automationActive, false, '409 claim expiry fails closed');
  install(true); mode = 'transient'; await internal.heartbeat();
  assert.equal(mixer.automationActive, false, 'local lease expiry fails closed before a request');
});

test('ProgramSource decodes and tears down a real ffmpeg child', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'anomaly-real-ffmpeg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'tone.mp3');
  try { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', file]); }
  catch { t.skip('ffmpeg unavailable'); return; }
  const source = new ProgramSource(file);
  await source.start();
  assert.ok(source.readFrame());
  source.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(source.stalled, false);
});

test('ProgramSource prebuffer timeout tears down a hung decoder process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'anomaly-hung-decoder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, 'hung-decoder.js');
  // One process keeps its inherited stdout pipe open forever. Unlike the old
  // shell/sleep loop, SIGTERM cannot leave a descendant holding that pipe.
  await writeFile(fake, '#!/usr/bin/env node\nsetInterval(() => {}, 2_147_483_647);\n'); await chmod(fake, 0o755);
  const source = new ProgramSource('/unused.mp3', 0, fake, 30);
  await assert.rejects(() => source.start(), /prebuffer timed out/u);
  assert.equal(source.teardownInitiated, true);
  const deadline = Date.now() + 1000;
  while (!source.terminated && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(source.terminated, true);
});

test('controller mirrors repeated real mixer crossfade promotions atomically', async (t) => {
  const http = await import('node:http');
  const completed: string[] = []; const interrupted: string[] = []; let claimed = false;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    if (req.url?.endsWith('/complete')) completed.push(req.url.split('/').at(-2)!);
    if (req.url?.endsWith('/interrupt')) interrupted.push(req.url.split('/').at(-2)!);
    let body: object = { queue_revision: completed.length + (claimed ? 1 : 0) };
    if (req.url === '/internal/playout/snapshot') body = { queue_revision: completed.length, ready_count: claimed ? 0 : 1, cues: claimed ? [] : [{ state: 'READY', type: 'silence' }] };
    else if (req.url === '/internal/playout/claim') {
      if (claimed) body = { queue_revision: completed.length + 1, cue: null };
      else {
        claimed = true;
        body = { queue_revision: completed.length + 1, cue: { cue_id: 'cue_c', type: 'silence', planned_duration_ms: 1000, claim_token: 'token_c', claim_expires_at: new Date(Date.now() + 20_000).toISOString() } };
      }
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'test', assetRoots: [], crossfadeMs: 40 });
  const a = new Tone(1000); const b = new Tone(2000);
  assert.equal(mixer.setProgramSource(a), true);
  assert.equal(mixer.crossfadeProgramSource(b, 40), true);
  const until = Date.now() + 20_000;
  const cue = { type: 'music' as const, planned_duration_ms: 10_000, claim_token: 'token', claim_expires_at: new Date(until).toISOString() };
  const internal = controller as unknown as { active: { cue: { cue_id: string } } | null; incoming: { cue: { cue_id: string } } | null; claimAndStart(crossfade: boolean): Promise<void> };
  internal.active = { cue: { ...cue, cue_id: 'cue_a' }, source: a, startedAt: Date.now(), leaseExpiresAt: until } as never;
  internal.incoming = { cue: { ...cue, cue_id: 'cue_b' }, source: b, startedAt: Date.now(), leaseExpiresAt: until } as never;

  write(mixer, 2);
  await waitFor(() => internal.active?.cue.cue_id === 'cue_b' && internal.incoming === null);
  await waitFor(() => completed.length === 1);
  assert.deepEqual(completed, ['cue_a']);

  await internal.claimAndStart(true);
  assert.equal(internal.active?.cue.cue_id, 'cue_b');
  assert.equal(internal.incoming?.cue.cue_id, 'cue_c');
  write(mixer, 25); // controller clamps stored/default transition to 500ms minimum
  await waitFor(() => internal.active?.cue.cue_id === 'cue_c' && internal.incoming === null);
  await waitFor(() => completed.length === 2);
  assert.deepEqual(completed, ['cue_a', 'cue_b']);

  write(mixer, 50);
  await waitFor(() => internal.active === null && internal.incoming === null);
  await waitFor(() => completed.length === 3);
  assert.deepEqual(completed, ['cue_a', 'cue_b', 'cue_c']);
  assert.deepEqual(interrupted, []);
  assert.equal(mixer.automationActive, false);
});

test('real A-B-C decoder lifecycle completes every cue and permits the next claim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'anomaly-real-lifecycle-'));
  const musicDir = join(root, 'music');
  await mkdir(musicDir);
  const canonicalMusicDir = await realpath(musicDir);
  try {
    for (const [name, frequency] of [['A', 330], ['B', 440], ['C', 550]] as const) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=0.24`, '-ar', '48000', '-ac', '2', '-b:a', '96k', '-y', join(musicDir, `${name}.mp3`)]);
    }
  } catch { await rm(root, { recursive: true, force: true }); t.skip('ffmpeg unavailable'); return; }
  const automationRoot = join(process.cwd(), '..', 'automation');
  const cfg: AutomationConfig = {
    databasePath: join(root, 'state.db'), migrationsDir: join(automationRoot, 'migrations'), musicDir: canonicalMusicDir, generatedDir: root, recordingsDir: root, voicemailsDir: root,
    bind: '127.0.0.1', port: 0, internalToken: 'integration-token', allowUnauthenticated: false, maxBodyBytes: 65536, claimLeaseMs: 30_000,
    maxQueueCues: 100, maxHorizonMs: 7_200_000, lowCueCount: 12, highCueCount: 24, lowHorizonMs: 2_700_000, targetHorizonMs: 5_400_000,
    assetRepeatMs: 1, artistRepeatMs: 1, crossfadeMs: 500, badwords: [], hotlineEnabled: false, playoutEnabled: true, djEnabled: false, djShadow: false, aiArchiveEnabled: false,
  };
  const store = new AutomationStore(cfg);
  const imported = await importMusic(store, canonicalMusicDir);
  assert.equal(imported.created, 3);
  const assets = store.db.prepare('SELECT id FROM assets ORDER BY title').all() as Array<{ id: string }>;
  for (const [index, asset] of assets.entries()) store.enqueueTrack({ assetId: asset.id, expectedRevision: index, idempotencyKey: `real:${index}`, transitionMs: 500 });
  const originalCueIds = (store.db.prepare('SELECT id FROM cues ORDER BY queue_position').all() as Array<{ id: string }>).map((row) => row.id);
  const server = createServer(store, cfg);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const address = server.address() as import('node:net').AddressInfo;
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'integration-token', assetRoots: [canonicalMusicDir], crossfadeMs: 60, pollMs: 10 });
  await controller.setPresence(0); mixer.start(); controller.start();
  t.after(async () => {
    controller.stop(); mixer.stop();
    await (controller as unknown as { serial: Promise<void> }).serial;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close(); await rm(root, { recursive: true, force: true });
  });

  await waitFor(() => {
    const states = store.db.prepare(`SELECT state FROM cues WHERE id IN (${originalCueIds.map(() => '?').join(',')})`).all(...originalCueIds) as Array<{ state: string }>;
    return states.length === 3 && states.every((row) => row.state === 'COMPLETED');
  }, 25_000); // below the 30s claim lease; allows valid decoder recovery after host suspension
  const internal = controller as unknown as { active: unknown; incoming: unknown };
  await waitFor(() => internal.active === null && internal.incoming === null && !mixer.automationActive);
  assert.equal((store.db.prepare("SELECT count(*) count FROM cue_events WHERE event_type='COMPLETED'").get() as { count: number }).count, 3);

  const next = store.enqueueManualCue({ type: 'silence', durationMs: 40, expectedRevision: store.ready().queueRevision, idempotencyKey: 'real:next' }) as { cue_id: string };
  await waitFor(() => (store.db.prepare('SELECT state FROM cues WHERE id=?').get(next.cue_id) as { state: string }).state === 'COMPLETED');
  await waitFor(() => internal.active === null && internal.incoming === null && !mixer.automationActive);
  assert.equal((store.db.prepare("SELECT count(*) count FROM cue_events WHERE cue_id=? AND event_type='COMPLETED'").get(next.cue_id) as { count: number }).count, 1);
});

test('real automation + ffmpeg starts a stored 6s fade early enough on 90,044ms tracks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'anomaly-real-90s-crossfade-'));
  await Promise.all(['music', 'generated', 'recordings', 'voicemails', 'feed'].map((dir) => mkdir(join(root, dir))));
  const musicDir = await realpath(join(root, 'music'));
  try {
    for (const [name, frequency] of [['A', 330], ['B', 550]] as const) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=90.044`, '-ar', '48000', '-ac', '2', '-b:a', '96k', '-y', join(musicDir, `${name}.mp3`)]);
    }
  } catch { await rm(root, { recursive: true, force: true }); t.skip('ffmpeg unavailable'); return; }
  const cfg = testConfig(root, { playoutEnabled: true, crossfadeMs: 6000, assetRepeatMs: 0, artistRepeatMs: 0, claimLeaseMs: 30_000 });
  const store = new AutomationStore(cfg); await importMusic(store, musicDir);
  store.db.prepare('UPDATE assets SET duration_ms=90044').run();
  const assets = store.db.prepare('SELECT id FROM assets ORDER BY title').all() as Array<{ id: string }>;
  assets.forEach((asset, index) => store.enqueueTrack({ assetId: asset.id, expectedRevision: index, idempotencyKey: `real90:${index}`, transitionMs: 6000 }));
  const cueIds = (store.db.prepare('SELECT id FROM cues ORDER BY queue_position').all() as Array<{ id: string }>).map((row) => row.id);
  const server = createServer(store, cfg); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: cfg.internalToken, assetRoots: [musicDir], crossfadeMs: 6000, crossfadeLeadMs: 250, pollMs: 1000 });
  const internal = controller as unknown as { active: { cue: { cue_id: string }; source: { positionMs: number } } | null; incoming: { cue: { cue_id: string }; source: { positionMs: number } } | null; tick(): Promise<void>; serial: Promise<void> };
  t.after(async () => { controller.stop(); await internal.serial; await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); });
  await controller.setPresence(0); await internal.tick();
  assert.equal(internal.active?.cue.cue_id, cueIds[0]); assert.equal(internal.incoming, null);
  await pumpMixerUntil(mixer, () => Number(internal.active?.source.positionMs ?? 0) >= 83_790, 6000);
  assert.equal(internal.incoming, null, 'next decoder must not advance before deadline attachment');
  await internal.tick(); // one normal snapshot discovers B and arms the one-shot deadline
  const progression = setInterval(() => write(mixer, 1), 20);
  try { await waitFor(() => internal.incoming?.cue.cue_id === cueIds[1], 5000); } finally { clearInterval(progression); }
  const outgoing = internal.active!; const incoming = internal.incoming!;
  const remainingAtAttach = 90_044 - outgoing.source.positionMs;
  assert.ok(remainingAtAttach >= 5800 && remainingAtAttach <= 6250, `remaining at attach=${remainingAtAttach}`);
  let dualFrames = 0; const overlapSamples: number[] = []; mixer.setSink((frame) => overlapSamples.push(sample(frame)));
  for (let index = 0; index < 320 && internal.active?.cue.cue_id === cueIds[0]; index += 1) {
    const beforeA = outgoing.source.positionMs; const beforeB = incoming.source.positionMs;
    write(mixer, 1);
    if (outgoing.source.positionMs > beforeA && incoming.source.positionMs > beforeB) dualFrames += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await waitFor(() => internal.active?.cue.cue_id === cueIds[1], 2000);
  const audibleOverlapMs = dualFrames * 20;
  assert.ok(audibleOverlapMs >= 5800 && audibleOverlapMs <= 6200, `audible overlap=${audibleOverlapMs}ms`);
  assert.ok(overlapSamples.every((value) => Number.isFinite(value)), 'mixed frames remain valid');
  // Accelerated frame pumping can briefly outrun ffmpeg under host contention;
  // extra event-loop yields test lifecycle completion, not decoder CPU speed.
  await pumpMixerUntil(mixer, () => internal.active === null, 12_000);
  await waitFor(() => cueIds.every((id) => (store.db.prepare('SELECT state FROM cues WHERE id=?').get(id) as { state: string }).state === 'COMPLETED'), 5000);
  const lifecycle = store.db.prepare('SELECT id,started_at,completed_at FROM cues ORDER BY queue_position').all() as Array<{ id: string; started_at: string; completed_at: string }>;
  assert.ok(Date.parse(lifecycle[1]!.started_at) <= Date.parse(lifecycle[0]!.completed_at), JSON.stringify(lifecycle));
  assert.deepEqual((store.db.prepare("SELECT cue_id FROM cue_events WHERE event_type='COMPLETED' ORDER BY id").all() as Array<{ cue_id: string }>).map((row) => row.cue_id), cueIds);
});

test('DJ enqueue racing a deterministic rerun claim refreshes CAS once without claim churn', async (t) => {
  const http = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'anomaly-cas-rerun-'));
  await Promise.all(['music', 'generated', 'recordings', 'voicemails', 'feed'].map((dir) => mkdir(join(root, dir))));
  const musicDir = await realpath(join(root, 'music')); const recordingsDir = await realpath(join(root, 'recordings'));
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.35', '-ar', '48000', '-ac', '2', '-b:a', '96k', '-y', join(musicDir, 'dj-race.mp3')]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.30', '-ar', '48000', '-ac', '2', '-b:a', '96k', '-y', join(recordingsDir, 'session-2026-07-07T00-00-00.mp3')]);
  } catch { await rm(root, { recursive: true, force: true }); t.skip('ffmpeg unavailable'); return; }
  const cfg = testConfig(root, { playoutEnabled: true, rerunAfterLiveMs: 0, rerunGapMs: 0, assetRepeatMs: 0, artistRepeatMs: 0, claimLeaseMs: 30_000 });
  const store = new AutomationStore(cfg); await importMusic(store, musicDir);
  const scheduler = new RerunScheduler(store, cfg);
  await scheduler.initialize();
  const backend = createServer(store, cfg, scheduler);
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendAddress = backend.address() as import('node:net').AddressInfo;
  const musicAsset = (store.db.prepare("SELECT id FROM assets WHERE kind='music'").get() as { id: string }).id;
  let injected = false; let claimRequests = 0;
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const requestBody = Buffer.concat(chunks); const route = req.url ?? '/';
    if (route === '/internal/playout/claim') {
      claimRequests += 1;
      if (!injected) {
        injected = true;
        store.enqueueTrack({ assetId: musicAsset, expectedRevision: store.revision(), idempotencyKey: 'race:dj-enqueue', source: 'dj_tool' });
      }
    }
    const upstream = await fetch(`http://127.0.0.1:${backendAddress.port}${route}`, {
      method: req.method, headers: { authorization: String(req.headers.authorization ?? ''), ...(requestBody.length ? { 'content-type': 'application/json' } : {}) },
      body: requestBody.length ? requestBody : undefined,
    });
    res.statusCode = upstream.status; res.setHeader('content-type', 'application/json'); res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${proxyAddress.port}`, token: cfg.internalToken, assetRoots: [musicDir, recordingsDir], crossfadeMs: 500, pollMs: 10 });
  await controller.setPresence(0); await scheduler.tick();
  assert.equal((store.db.prepare("SELECT count(*) count FROM cues WHERE type='rerun' AND state='READY'").get() as { count: number }).count, 1);
  mixer.start(); controller.start();
  t.after(async () => {
    controller.stop(); mixer.stop(); await (controller as unknown as { serial: Promise<void> }).serial;
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    store.close(); await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => {
    const rows = store.db.prepare("SELECT type,state FROM cues WHERE type IN ('music','rerun')").all() as Array<{ type: string; state: string }>;
    return rows.length === 2 && rows.every((row) => row.state === 'COMPLETED');
  }, 25_000);
  await waitFor(() => !mixer.automationActive);
  assert.deepEqual(controller.conflictStats, { retries: 1, recoveries: 1, exhausted: 0 });
  assert.ok(claimRequests <= 8, `HTTP polling must remain bounded around two short cues: ${claimRequests}`);
  const claims = store.db.prepare("SELECT cue_id FROM cue_events WHERE event_type='CLAIMED' ORDER BY id").all() as Array<{ cue_id: string }>;
  assert.equal(claims.length, 2); assert.equal(new Set(claims.map((row) => row.cue_id)).size, 2);
  assert.deepEqual((store.db.prepare("SELECT type FROM cues ORDER BY started_at").all() as Array<{ type: string }>).map((row) => row.type), ['music', 'rerun']);
});

test('transient complete failure settles real short A-B playout without heartbeat or audit churn', async (t) => {
  const http = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'anomaly-complete-retry-'));
  const musicDir = join(root, 'music'); await mkdir(musicDir);
  const canonicalMusicDir = await realpath(musicDir);
  try {
    for (const [name, frequency, duration] of [['A', 330, 1.20], ['B', 550, 1.00]] as const) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`, '-ar', '48000', '-ac', '2', '-b:a', '96k', '-y', join(musicDir, `${name}.mp3`)]);
    }
  } catch { await rm(root, { recursive: true, force: true }); t.skip('ffmpeg unavailable'); return; }
  const automationRoot = join(process.cwd(), '..', 'automation');
  const cfg: AutomationConfig = {
    databasePath: join(root, 'state.db'), migrationsDir: join(automationRoot, 'migrations'), musicDir: canonicalMusicDir, generatedDir: root, recordingsDir: root, voicemailsDir: root,
    bind: '127.0.0.1', port: 0, internalToken: 'integration-token', allowUnauthenticated: false, maxBodyBytes: 65536, claimLeaseMs: 30_000,
    maxQueueCues: 100, maxHorizonMs: 7_200_000, lowCueCount: 12, highCueCount: 24, lowHorizonMs: 2_700_000, targetHorizonMs: 5_400_000,
    assetRepeatMs: 1, artistRepeatMs: 1, crossfadeMs: 500, badwords: [], hotlineEnabled: false, playoutEnabled: true, djEnabled: false, djShadow: false, aiArchiveEnabled: false,
  };
  const store = new AutomationStore(cfg); await importMusic(store, canonicalMusicDir);
  const assets = store.db.prepare('SELECT id FROM assets ORDER BY title').all() as Array<{ id: string }>;
  for (const [index, asset] of assets.entries()) store.enqueueTrack({ assetId: asset.id, expectedRevision: index, idempotencyKey: `retry:${index}`, transitionMs: 500 });
  const cueIds = (store.db.prepare('SELECT id FROM cues ORDER BY queue_position').all() as Array<{ id: string }>).map((row) => row.id);
  const backend = createServer(store, cfg);
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendAddress = backend.address() as import('node:net').AddressInfo;
  let failedFirstComplete = false; let claimRequests = 0; let interruptRequests = 0;
  const heartbeatByCue = new Map<string, number>(); const completionBodies: Array<Record<string, unknown>> = [];
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); const route = req.url ?? '/';
    if (route === '/internal/playout/claim') claimRequests += 1;
    if (route.endsWith('/interrupt')) interruptRequests += 1;
    const heartbeat = route.match(/^\/internal\/playout\/([^/]+)\/heartbeat$/u);
    if (heartbeat) heartbeatByCue.set(heartbeat[1]!, (heartbeatByCue.get(heartbeat[1]!) ?? 0) + 1);
    if (route.endsWith('/complete')) {
      completionBodies.push(JSON.parse(body.toString()) as Record<string, unknown>);
      if (!failedFirstComplete) {
        failedFirstComplete = true;
        // Fail exactly once as soon as the first completion arrives. The old
        // 700ms hold made this test manufacture an overlap that is not
        // guaranteed when a loaded host misses the tiny crossfade poll window.
        res.statusCode = 503; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'TEMPORARY', message: 'injected once' } })); return;
      }
    }
    const upstream = await fetch(`http://127.0.0.1:${backendAddress.port}${route}`, { method: req.method, headers: { authorization: String(req.headers.authorization ?? ''), ...(body.length ? { 'content-type': 'application/json' } : {}) }, body: body.length ? body : undefined });
    res.statusCode = upstream.status; res.setHeader('content-type', 'application/json'); res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${proxyAddress.port}`, token: 'integration-token', assetRoots: [canonicalMusicDir], crossfadeMs: 200, pollMs: 10 });
  const internal = controller as unknown as { active: { cue: { cue_id: string } } | null; incoming: unknown; pendingSettlements: Map<string, unknown>; heartbeat(): Promise<void>; serial: Promise<void> };
  await controller.setPresence(0); mixer.start(); controller.start();
  t.after(async () => {
    controller.stop(); mixer.stop(); await internal.serial;
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    store.close(); await rm(root, { recursive: true, force: true });
  });

  await waitFor(() => failedFirstComplete, 5000);
  await internal.heartbeat();
  assert.equal(heartbeatByCue.get(cueIds[0]!) ?? 0, 0, 'drained predecessor must not be heartbeated');
  await waitFor(() => cueIds.every((id) => (store.db.prepare('SELECT state FROM cues WHERE id=?').get(id) as { state: string }).state === 'COMPLETED'), 25_000);
  await waitFor(() => internal.pendingSettlements.size === 0 && internal.active === null && internal.incoming === null && !mixer.automationActive);
  controller.stop(); mixer.stop(); await internal.serial;
  assert.equal((store.db.prepare("SELECT count(*) count FROM cue_events WHERE event_type='COMPLETED'").get() as { count: number }).count, 2);
  const claimedEvents = store.db.prepare("SELECT cue_id,queue_revision FROM cue_events WHERE event_type='CLAIMED' ORDER BY id").all() as Array<{ cue_id: string; queue_revision: number }>;
  assert.deepEqual([...new Set(claimedEvents.map((event) => event.cue_id))].sort(), [...cueIds].sort(), JSON.stringify(claimedEvents));
  // A >5s host/event-loop suspension legitimately triggers DECODER_STALLED,
  // making resumable music READY once. That recovery may add one claim and one
  // interrupt, but must never duplicate completion or churn unboundedly.
  assert.ok(claimedEvents.length <= 3, JSON.stringify(claimedEvents));
  assert.ok(interruptRequests <= 1, `unexpected interrupt churn: ${interruptRequests}`);
  assert.ok(claimRequests < 10, `unexpected claim churn: ${claimRequests}`);
  const firstCueBodies = completionBodies.filter((body) => body.claim_token === completionBodies[0]?.claim_token);
  assert.ok(firstCueBodies.length >= 2);
  assert.equal(new Set(firstCueBodies.map((body) => body.idempotency_key)).size, 1, 'logical retry must retain its idempotency key');
});

test('completion retry preserves idempotency across network ambiguity and refreshes revision conflicts', async (t) => {
  const http = await import('node:http');
  for (const mode of ['network', 'revision'] as const) await t.test(mode, async (st) => {
    let attempts = 0; let snapshotRevision = 7; const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.url === '/internal/playout/snapshot') {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: snapshotRevision, ready_count: 0, cues: [] })); return;
      }
      if (req.url?.endsWith('/complete')) {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>); attempts += 1;
        if (attempts === 1 && mode === 'network') { req.socket.destroy(); return; }
        if (attempts === 1) {
          snapshotRevision = 8; res.statusCode = 409; res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'refresh' } })); return;
        }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: snapshotRevision + 1, state: 'COMPLETED' })); return;
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: snapshotRevision, cue: null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    st.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address() as import('node:net').AddressInfo;
    const mixer = new Mixer(); mixer.setSink(() => {});
    const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'test', assetRoots: [], crossfadeMs: 40 });
    const source = new OneFrameTone(); mixer.setProgramSource(source);
    const until = Date.now() + 20_000;
    const internal = controller as unknown as { active: unknown; incoming: unknown; pendingSettlements: Map<string, unknown>; serial: Promise<void> };
    internal.active = { cue: { cue_id: `cue_${mode}`, type: 'music', planned_duration_ms: 20, claim_token: `token_${mode}`, claim_expires_at: new Date(until).toISOString() }, source, startedAt: Date.now(), leaseExpiresAt: until };
    write(mixer, 1);
    await waitFor(() => attempts === 2 && internal.pendingSettlements.size === 0, 3000);
    assert.equal(internal.active, null);
    assert.equal(mixer.automationActive, false);
    assert.equal(new Set(bodies.map((body) => body.idempotency_key)).size, 1);
    if (mode === 'network') assert.equal(bodies[0]?.expected_queue_revision, bodies[1]?.expected_queue_revision);
    else assert.notEqual(bodies[0]?.expected_queue_revision, bodies[1]?.expected_queue_revision);
    controller.stop(); await internal.serial;
  });
});

test('stop aborts and abandons an in-flight completion without hanging', async (t) => {
  const http = await import('node:http'); let completionStarted = false;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    if (req.url?.endsWith('/complete')) { completionStarted = true; return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: 0, ready_count: 0, cues: [], cue: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {});
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'test', assetRoots: [], crossfadeMs: 40 });
  const source = new OneFrameTone(); mixer.setProgramSource(source);
  const until = Date.now() + 20_000;
  const internal = controller as unknown as { active: unknown; pendingSettlements: Map<string, unknown>; serial: Promise<void> };
  internal.active = { cue: { cue_id: 'cue_stop', type: 'music', planned_duration_ms: 20, claim_token: 'token_stop', claim_expires_at: new Date(until).toISOString() }, source, startedAt: Date.now(), leaseExpiresAt: until };
  write(mixer, 1);
  await waitFor(() => completionStarted);
  controller.stop();
  await Promise.race([
    internal.serial,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stop settlement abort timed out')), 500)),
  ]);
  assert.equal(internal.pendingSettlements.size, 0);
  assert.equal(internal.active, null);
  assert.equal(mixer.automationActive, false);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, 'condition was not met before deadline');
}

test('a drained incoming crossfade source is detached instead of being promoted', async () => {
  const mixer = new Mixer(); const out: Buffer[] = []; let incomingEnded = 0;
  mixer.setSink((frame) => out.push(Buffer.from(frame)));
  mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  mixer.onProgramIncomingEnded = () => { incomingEnded += 1; };
  mixer.setProgramSource(new Tone(10_000));
  mixer.crossfadeProgramSource(new OneFrameTone(), 3000);
  write(mixer, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(incomingEnded, 1);
  assert.equal(mixer.automationActive, true);
  assert.ok(out.every((frame) => Math.abs(sample(frame)) >= 9_999), 'current deck stays full-level');
});

test('controller completes an incoming cue that drains before crossfade promotion', async (t) => {
  const http = await import('node:http'); let completes = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    if (req.url?.includes('/complete')) completes += 1;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_revision: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as import('node:net').AddressInfo;
  const mixer = new Mixer(); mixer.setSink(() => {}); mixer.configureAutomation({ baseGain: 1, duckGain: .1, stepDown: 1, stepUp: 1 });
  const controller = new PlayoutController(mixer, { enabled: true, url: `http://127.0.0.1:${address.port}`, token: 'test', assetRoots: [], crossfadeMs: 3000 });
  const current = new Tone(1000); const incoming = new OneFrameTone(); mixer.setProgramSource(current); mixer.crossfadeProgramSource(incoming, 3000);
  const until = Date.now() + 20_000;
  const cue = { type: 'music' as const, planned_duration_ms: 10_000, claim_token: 'token', claim_expires_at: new Date(until).toISOString() };
  const internal = controller as unknown as { active: unknown; incoming: unknown };
  internal.active = { cue: { ...cue, cue_id: 'cue_current' }, source: current, startedAt: Date.now(), leaseExpiresAt: until };
  internal.incoming = { cue: { ...cue, cue_id: 'cue_short' }, source: incoming, startedAt: Date.now(), leaseExpiresAt: until };
  write(mixer, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(completes, 1);
  assert.equal(mixer.automationActive, true);
  assert.equal((controller as unknown as { incoming: unknown }).incoming, null);
});

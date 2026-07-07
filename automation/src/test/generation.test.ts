import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DomainError } from '../errors.js';
import { promisify } from 'node:util';
import { ElevenLabsRenderer, GenerationWorker, type SpeechRenderer } from '../generation.js';
import { testFixture } from './helpers.js';

const probe = { durationMs: 12_000, codecName: 'mp3', sampleRateHz: 48_000, channels: 2, bitRate: 128_000, mimeType: 'audio/mpeg', loudnessLufs: -18 };
const execFileAsync = promisify(execFile);

test('mocked ElevenLabs response is canonicalized and loudness-probed with no real API call', async () => {
  const fixture = await testFixture({ elevenLabsKey: 'not-a-real-key', elevenLabsVoiceId: 'test-voice' });
  const providerMp3 = path.join(fixture.root, 'provider.mp3');
  const output = path.join(fixture.config.generatedDir, 'canonical.tmp.mp3');
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', providerMp3]);
  const bytes = await fsp.readFile(providerMp3);
  const fakeFetch = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'audio/mpeg', 'x-request-id': 'mock-eleven-request' } });
  const rendered = await new ElevenLabsRenderer(fixture.config, fakeFetch as typeof fetch).render('Safe mocked speech.', output, AbortSignal.timeout(30_000));
  assert.equal(rendered.probe.sampleRateHz, 48_000); assert.equal(rendered.probe.channels, 2); assert.equal(rendered.probe.codecName, 'mp3');
  assert.ok(Number.isFinite(rendered.probe.loudnessLufs)); assert.equal(rendered.providerRequestId, 'mock-eleven-request');
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('mocked ElevenLabs HTTP failure is typed and writes no output', async () => {
  const fixture = await testFixture({ elevenLabsKey: 'not-a-real-key', elevenLabsVoiceId: 'test-voice' });
  const output = path.join(fixture.config.generatedDir, 'failed.tmp.mp3');
  const fakeFetch = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(() => new ElevenLabsRenderer(fixture.config, fakeFetch as typeof fetch).render('Safe mocked speech.', output, AbortSignal.timeout(5000)), (error) => error instanceof DomainError && error.code === 'TTS_HTTP_ERROR');
  await assert.rejects(() => fsp.stat(output), { code: 'ENOENT' });
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('generation worker atomically publishes immutable READY speech and safe metadata', async () => {
  const fixture = await testFixture({ generationEnabled: true });
  const queued = fixture.store.enqueueCommentary({ script: 'A safe generated transition.', expectedRevision: 0, idempotencyKey: 'gen:queue' });
  const renderer: SpeechRenderer = { render: async (_script, output) => { await fsp.writeFile(output, Buffer.alloc(2048, 7)); return { probe, providerRequestId: 'request_test_1' }; } };
  const worker = new GenerationWorker(fixture.store, fixture.config, renderer);
  await worker.tick();
  const cue = fixture.store.db.prepare('SELECT state,asset_id,public_metadata_json FROM cues WHERE id=?').get(queued.cue_id) as { state: string; asset_id: string; public_metadata_json: string };
  assert.equal(cue.state, 'READY'); assert.ok(cue.asset_id);
  assert.deepEqual(JSON.parse(cue.public_metadata_json), { title: 'Anomaly FM commentary', artist: 'Anomaly FM' });
  const asset = fixture.store.db.prepare('SELECT status,loudness_lufs,playout_locator FROM assets WHERE id=?').get(cue.asset_id) as { status: string; loudness_lufs: number; playout_locator: string };
  assert.equal(asset.status, 'READY'); assert.equal(asset.loudness_lufs, -18);
  assert.match(asset.playout_locator, /\/generated\/ready\/[a-f0-9]{64}\.mp3$/u);
  assert.equal((await fsp.readdir(path.join(fixture.config.generatedDir, '.staging'))).length, 0);
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('generation retries transient failures, leaves no partial READY file, then succeeds', async () => {
  const fixture = await testFixture({ generationEnabled: true });
  fixture.store.enqueueCommentary({ script: 'Retry this safe transition.', expectedRevision: 0, idempotencyKey: 'retry:queue' });
  let attempts = 0;
  const renderer: SpeechRenderer = {
    render: async (_script, output) => {
      attempts++;
      await fsp.writeFile(output, Buffer.alloc(1200, attempts));
      if (attempts < 3) throw new DomainError('TTS_HTTP_ERROR', 'mock provider unavailable', 502);
      return { probe };
    },
  };
  const worker = new GenerationWorker(fixture.store, fixture.config, renderer);
  await worker.tick();
  assert.equal((await fsp.readdir(path.join(fixture.config.generatedDir, 'ready'))).length, 0);
  fixture.store.db.prepare("UPDATE generation_jobs SET claim_expires_at='2000-01-01T00:00:00.000Z'").run();
  await worker.tick();
  assert.equal((await fsp.readdir(path.join(fixture.config.generatedDir, 'ready'))).length, 0);
  fixture.store.db.prepare("UPDATE generation_jobs SET claim_expires_at='2000-01-01T00:00:00.000Z'").run();
  await worker.tick();
  assert.equal(attempts, 3);
  assert.equal((fixture.store.db.prepare('SELECT state FROM cues').get() as { state: string }).state, 'READY');
  assert.equal((await fsp.readdir(path.join(fixture.config.generatedDir, 'ready'))).length, 1);
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('generation terminal failure fails its cue after bounded attempts with no partials', async () => {
  const fixture = await testFixture({ generationEnabled: true });
  fixture.store.enqueueCommentary({ script: 'This render will fail safely.', expectedRevision: 0, idempotencyKey: 'fail:queue' });
  const renderer: SpeechRenderer = { render: async (_script, output) => { await fsp.writeFile(output, Buffer.alloc(1500)); throw new DomainError('TTS_HTTP_ERROR', 'mock outage', 502); } };
  const worker = new GenerationWorker(fixture.store, fixture.config, renderer);
  for (let attempt = 0; attempt < 3; attempt++) {
    await worker.tick();
    fixture.store.db.prepare("UPDATE generation_jobs SET claim_expires_at='2000-01-01T00:00:00.000Z'").run();
  }
  const cue = fixture.store.db.prepare('SELECT state,failure_code FROM cues').get() as { state: string; failure_code: string };
  assert.equal(cue.state, 'FAILED'); assert.equal(cue.failure_code, 'TTS_HTTP_ERROR');
  assert.equal((await fsp.readdir(path.join(fixture.config.generatedDir, 'ready'))).length, 0);
  assert.equal((await fsp.readdir(path.join(fixture.config.generatedDir, '.staging'))).length, 0);
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('daily TTS character budget defers work without consuming attempts or calling provider', async () => {
  const fixture = await testFixture({ generationEnabled: true, ttsDailyCharacterLimit: 10 });
  fixture.store.enqueueCommentary({ script: 'This script is longer than ten characters.', expectedRevision: 0, idempotencyKey: 'tts-budget:queue' });
  let calls = 0;
  const renderer: SpeechRenderer = { render: async () => { calls++; throw new Error('must not render'); } };
  const worker = new GenerationWorker(fixture.store, fixture.config, renderer);
  await worker.tick();
  assert.equal(calls, 0);
  const job = fixture.store.db.prepare('SELECT state,attempt,claim_expires_at,failure_code FROM generation_jobs').get() as { state: string; attempt: number; claim_expires_at: string; failure_code: string };
  assert.equal(job.state, 'PENDING'); assert.equal(job.attempt, 0); assert.equal(job.failure_code, 'TTS_DAILY_BUDGET');
  assert.ok(new Date(job.claim_expires_at).getTime() > Date.now());
  assert.equal((fixture.store.db.prepare('SELECT count(*) count FROM usage_events').get() as { count: number }).count, 0);
  assert.equal((fixture.store.db.prepare('SELECT state FROM cues').get() as { state: string }).state, 'GENERATING');
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('mocked generated actual duration still trips atomic queue horizon admission', async () => {
  const fixture = await testFixture({ generationEnabled: true, maxHorizonMs: 200_000 });
  fixture.store.enqueueCommentary({ script: 'An unexpectedly long transition.', expectedRevision: 0, idempotencyKey: 'long:queue' });
  const renderer: SpeechRenderer = { render: async (_script, output) => { await fsp.writeFile(output, Buffer.alloc(2048, 3)); return { probe: { ...probe, durationMs: 250_000 } }; } };
  const worker = new GenerationWorker(fixture.store, fixture.config, renderer);
  await worker.tick();
  const cue = fixture.store.db.prepare('SELECT state,failure_code FROM cues').get() as { state: string; failure_code: string };
  assert.equal(cue.state, 'FAILED'); assert.equal(cue.failure_code, 'HORIZON_CAP_EXCEEDED');
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

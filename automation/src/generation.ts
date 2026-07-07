import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AutomationConfig, ProbeResult } from './types.js';
import type { AutomationStore, ClaimedGenerationJob } from './store.js';
import { ffprobe, sha256File } from './importer.js';
import { DomainError } from './errors.js';

export interface RenderResult {
  probe: ProbeResult;
  providerRequestId?: string;
}

export interface SpeechRenderer {
  render(script: string, outputPath: string, signal: AbortSignal): Promise<RenderResult>;
}

export class ElevenLabsRenderer implements SpeechRenderer {
  constructor(private readonly config: AutomationConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async render(script: string, outputPath: string, signal: AbortSignal): Promise<RenderResult> {
    const rawPath = `${outputPath}.provider`;
    try {
      const response = await this.fetchImpl(`${this.config.elevenLabsBaseUrl}/v1/text-to-speech/${encodeURIComponent(this.config.elevenLabsVoiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': this.config.elevenLabsKey, accept: 'audio/mpeg', 'content-type': 'application/json' },
        body: JSON.stringify({ text: script, model_id: this.config.elevenLabsModelId }),
        signal,
      });
      if (!response.ok || !response.body) throw new DomainError('TTS_HTTP_ERROR', `ElevenLabs returned HTTP ${response.status}`, 502);
      await writeBoundedResponse(response, rawPath, this.config.generatedMaxBytes);
      await runProcess('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', rawPath,
        '-map_metadata', '-1', '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', outputPath,
      ], 60_000, signal);
      const probe = await ffprobe(outputPath);
      if (probe.durationMs < 300 || probe.durationMs > 180_000) throw new DomainError('GENERATED_DURATION_INVALID', 'generated speech duration is outside 0.3–180 seconds', 422);
      if (probe.sampleRateHz !== 48_000 || probe.channels !== 2 || probe.codecName !== 'mp3') throw new DomainError('GENERATED_FORMAT_INVALID', 'generated speech is not canonical 48 kHz stereo MP3', 422);
      const loudness = await measureLoudness(outputPath, signal);
      if (!Number.isFinite(loudness) || loudness < -40 || loudness > -5) throw new DomainError('GENERATED_LOUDNESS_INVALID', 'generated speech loudness is outside -40 to -5 LUFS', 422);
      const stat = await fsp.stat(outputPath);
      if (!stat.isFile() || stat.size < 1024 || stat.size > this.config.generatedMaxBytes) throw new DomainError('GENERATED_SIZE_INVALID', 'generated speech file size is invalid', 422);
      return { probe: { ...probe, loudnessLufs: loudness }, providerRequestId: response.headers.get('request-id') || response.headers.get('x-request-id') || undefined };
    } finally {
      await fsp.rm(rawPath, { force: true });
    }
  }
}

export class GenerationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly workerId = `generation_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

  constructor(private readonly store: AutomationStore, private readonly config: AutomationConfig, private readonly renderer: SpeechRenderer) {}

  start(): void {
    if (!this.config.generationEnabled || this.timer) return;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => { void this.tick().finally(schedule); }, this.config.generationPollMs);
      this.timer.unref();
    };
    void this.tick().finally(schedule);
  }

  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (!this.config.generationEnabled || this.running || this.stopped) return;
    const job = this.store.claimGenerationJob(this.workerId);
    if (!job) return;
    this.running = true;
    try { await this.process(job); }
    finally { this.running = false; }
  }

  private async process(job: ClaimedGenerationJob): Promise<void> {
    const stagingDir = path.join(this.config.generatedDir, '.staging');
    const readyDir = path.join(this.config.generatedDir, 'ready');
    await fsp.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(readyDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(stagingDir, `${job.jobId}-${job.attempt}-${crypto.randomUUID()}.tmp.mp3`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.config.generationLeaseMs - 1000, 110_000));
    try {
      const ttsBudget = this.store.reserveTtsCharacters(job.jobId, job.script.length);
      if (!ttsBudget.accepted) {
        this.store.deferGenerationJob(job.jobId, 'TTS_DAILY_BUDGET', 'daily TTS character budget exhausted', ttsBudget.retryAt);
        return;
      }
      const usedBytes = await directoryBytes(readyDir);
      if (usedBytes >= this.config.generatedBudgetBytes) throw new DomainError('GENERATED_BUDGET_EXCEEDED', 'generated asset hard budget is exhausted', 507);
      const rendered = await this.renderer.render(job.script, tempPath, controller.signal);
      if (rendered.providerRequestId) this.store.recordGenerationProviderRequest(job.jobId, rendered.providerRequestId);
      const stat = await fsp.stat(tempPath);
      if (!stat.isFile() || stat.size < 1024 || stat.size > this.config.generatedMaxBytes) throw new DomainError('GENERATED_SIZE_INVALID', 'rendered output file size is invalid', 422);
      if (usedBytes + stat.size > this.config.generatedBudgetBytes) throw new DomainError('GENERATED_BUDGET_EXCEEDED', 'generated asset would exceed the hard budget', 507);
      const checksum = await sha256File(tempPath);
      const readyPath = path.join(readyDir, `${checksum}.mp3`);
      try {
        await fsp.link(tempPath, readyPath);
        await fsp.chmod(readyPath, 0o444);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await sha256File(readyPath) !== checksum) throw new DomainError('GENERATED_IMMUTABLE_CONFLICT', 'existing generated asset checksum mismatch', 409);
      }
      const labels = generationLabels(job.kind);
      const asset = this.store.putAsset({
        kind: job.kind.includes('station') ? 'station_id' : 'spoken', checksum,
        sourceLocator: readyPath, playoutLocator: readyPath, title: labels.title, artist: 'Anomaly FM', tags: labels.tags,
        durationMs: rendered.probe.durationMs, codecName: rendered.probe.codecName, sampleRateHz: rendered.probe.sampleRateHz,
        channels: rendered.probe.channels, bitRate: rendered.probe.bitRate, mimeType: rendered.probe.mimeType,
        loudnessLufs: rendered.probe.loudnessLufs, raw: rendered.probe.raw,
        provenance: { source: 'elevenlabs_generation', generation_id: job.generationId },
      });
      for (let retry = 0; retry < 3; retry++) {
        try {
          this.store.completeGeneration({ jobId: job.jobId, assetId: asset.assetId, expectedRevision: this.store.revision(), idempotencyKey: `${job.jobId}:complete` });
          return;
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'REVISION_CONFLICT' || retry === 2) throw error;
        }
      }
    } catch (error) {
      const code = error instanceof DomainError ? error.code : controller.signal.aborted ? 'GENERATION_TIMEOUT' : 'GENERATION_ERROR';
      const detail = error instanceof Error ? error.message.slice(0, 500) : 'generation failed';
      this.store.failGenerationJob(job.jobId, code, detail, isRetryableGenerationError(code));
    } finally {
      clearTimeout(timer);
      await fsp.rm(tempPath, { force: true });
    }
  }
}

function generationLabels(kind: string): { title: string; tags: string[] } {
  if (kind === 'hotline_intro') return { title: 'Listener hotline introduction', tags: ['hotline', 'intro'] };
  if (kind === 'hotline_outro') return { title: 'Listener hotline transition', tags: ['hotline', 'outro'] };
  if (kind.includes('station')) return { title: 'Anomaly FM station ID', tags: ['station-id'] };
  return { title: 'Anomaly FM commentary', tags: ['commentary'] };
}

function isRetryableGenerationError(code: string): boolean {
  return ['TTS_HTTP_ERROR', 'GENERATION_TIMEOUT', 'GENERATION_ERROR'].includes(code);
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    total += (await fsp.stat(path.join(directory, entry.name))).size;
  }
  return total;
}

async function writeBoundedResponse(response: Response, outputPath: string, maxBytes: number): Promise<void> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new DomainError('TTS_RESPONSE_TOO_LARGE', 'TTS response exceeds size limit', 413);
  const handle = await fsp.open(outputPath, 'wx', 0o600);
  let size = 0;
  try {
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new DomainError('TTS_RESPONSE_TOO_LARGE', 'TTS response exceeds size limit', 413);
      await handle.write(value);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fsp.rm(outputPath, { force: true });
    throw error;
  }
  await handle.close();
}

async function runProcess(command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 100_000) stderr += chunk; });
    const kill = () => child.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', kill);
      if (signal.aborted || timedOut) reject(new DomainError('GENERATION_TIMEOUT', `${command} aborted`, 504));
      else if (code !== 0) reject(new DomainError('GENERATED_AUDIO_INVALID', `${command} exited ${code}: ${stderr.slice(-1000)}`, 422));
      else resolve(stderr);
    });
  });
}

async function measureLoudness(filePath: string, signal: AbortSignal): Promise<number> {
  const output = await runProcess('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-filter_complex', 'ebur128=framelog=verbose', '-f', 'null', '-'], 30_000, signal);
  const matches = [...output.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s+LUFS/gu)];
  return Number(matches.at(-1)?.[1]);
}

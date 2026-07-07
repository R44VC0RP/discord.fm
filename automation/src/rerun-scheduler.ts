import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AutomationConfig, ProbeResult } from './types.js';
import type { AutomationStore, RerunSchedulerState } from './store.js';
import { ffprobe, sha256File } from './importer.js';

type Probe = (file: string) => Promise<ProbeResult & { title?: string | null; artist?: string | null }>;

/** Deterministic filler owner. It never asks OpenCode to select a recording. */
export class RerunScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly assets = new Map<string, string>();

  constructor(private readonly store: AutomationStore, private readonly config: AutomationConfig, private readonly probe: Probe = ffprobe) {}

  async initialize(): Promise<void> {
    if (!this.config.playoutEnabled) return;
    const legacy = await this.readLegacyState();
    this.store.initializeRerunState(legacy);
    await this.tick();
  }

  start(): void {
    if (!this.config.playoutEnabled || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.rerunPollMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.running || !this.config.playoutEnabled) return;
    this.running = true;
    try {
      const files = await this.files();
      let state = this.store.reconcileRerunFiles(files);
      await this.exportRollback(state);
      const presence = this.store.queueSnapshot().presence as { humans?: number; known?: number } | undefined;
      if (!presence?.known || Number(presence.humans) > 0 || state.activeCueId) return;

      const manual = state.queue[0] ?? null;
      if (!manual) {
        if (!state.auto) return;
        // Reruns are filler: admitted manual/DJ programming always drains first.
        const active = this.store.db.prepare(`SELECT count(*) count FROM cues WHERE state IN ('READY','CLAIMED','PLAYING')`).get() as { count: number };
        if (active.count > 0) return;
        const nowMs = Date.now();
        if (state.lastLiveEndedAt && nowMs < Date.parse(state.lastLiveEndedAt) + this.config.rerunAfterLiveMs) return;
        if (state.lastFinishedAt && nowMs < Date.parse(state.lastFinishedAt) + this.config.rerunGapMs) return;
      }

      let selected = manual ?? files.find((file) => !state.played.includes(file)) ?? null;
      if (!selected && files.length > 0) {
        state = this.store.resetRerunCycle();
        selected = files[0] as string;
      }
      if (!selected) return;
      const assetId = await this.ensureAsset(selected);
      this.store.admitRerun(selected, assetId, Boolean(manual));
      await this.exportRollback(this.store.rerunState());
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ level: 'warn', event: 'rerun_scheduler_failed', error: error instanceof Error ? error.message : String(error) })}\n`);
    } finally { this.running = false; }
  }

  async state(): Promise<Record<string, unknown>> { const files = await this.files(); return this.store.rerunControlSnapshot(files); }
  async queue(file: string): Promise<Record<string, unknown>> { this.store.queueRerun(file); await this.tick(); return this.state(); }
  async unqueue(index: number): Promise<Record<string, unknown>> { this.store.unqueueRerun(index); return this.state(); }
  async setAuto(enabled: boolean, expectedVersion: number, idempotencyKey: string): Promise<Record<string, unknown>> {
    const mutation = this.store.setRerunAuto({ enabled, expectedVersion, idempotencyKey });
    await this.tick();
    return { ...(await this.state()), mutation };
  }

  private async files(): Promise<string[]> {
    try { return (await fsp.readdir(this.config.recordingsDir)).filter((name) => /^session-[\w.-]+\.mp3$/u.test(name)).sort(); }
    catch { return []; }
  }

  private async ensureAsset(file: string): Promise<string> {
    const cached = this.assets.get(file); if (cached) return cached;
    const locator = path.join(path.resolve(this.config.recordingsDir), file);
    const [probe, checksum] = await Promise.all([this.probe(locator), sha256File(locator)]);
    let title = recordingLabel(file, this.config.stationTimeZone);
    try {
      const meta = JSON.parse(await fsp.readFile(locator.replace(/(-part\d+)?\.mp3$/u, '.json'), 'utf8')) as { members?: string[] };
      if (meta.members?.length) title = `${title} | ${meta.members.join(', ')}`;
    } catch { /* recording metadata is optional */ }
    const result = this.store.putAsset({ kind: 'rerun', checksum, sourceLocator: locator, playoutLocator: locator,
      title: title.slice(0, 256), artist: 'Anomaly FM archive', durationMs: probe.durationMs, mimeType: probe.mimeType,
      codecName: probe.codecName, sampleRateHz: probe.sampleRateHz, channels: probe.channels, bitRate: probe.bitRate,
      provenance: { source: 'recording_import', recording_file: file } });
    this.assets.set(file, result.assetId); return result.assetId;
  }

  private async readLegacyState(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.config.feedDir, 'rerun-state.json'), 'utf8')) as { played?: unknown };
      return Array.isArray(parsed.played) ? parsed.played.filter((v): v is string => typeof v === 'string') : [];
    } catch { return []; }
  }

  private async exportRollback(state: RerunSchedulerState): Promise<void> {
    if (!this.config.feedDir) return;
    await fsp.mkdir(this.config.feedDir, { recursive: true });
    const target = path.join(this.config.feedDir, 'rerun-state.automation-export.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify({ played: [...state.played].sort() }, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, target);
  }
}

function recordingLabel(file: string, timeZone: string): string {
  const match = file.match(/^session-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/u);
  if (!match) return file.replace(/\.mp3$/u, '');
  const when = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!));
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(when);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(when);
  return `${date} | ${time}`;
}

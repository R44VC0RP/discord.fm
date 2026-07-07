import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AutomationStore } from './store.js';
import { ffprobe, sha256File, type Probe } from './importer.js';

export interface HotlineImportResult {
  discovered: number;
  imported: number;
  eligible: number;
  ineligible: number;
  aired: number;
  archived: number;
  failed: Array<{ file: string; error: string }>;
}

export async function importHotlines(store: AutomationStore, voicemailDir: string, probe: Probe = ffprobe): Promise<HotlineImportResult> {
  const entries = await fsp.readdir(voicemailDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries.filter((entry) => entry.isFile() && /^vm-[\w.-]+\.json$/u.test(entry.name)).map((entry) => entry.name).sort();
  const result: HotlineImportResult = { discovered: files.length, imported: 0, eligible: 0, ineligible: 0, aired: 0, archived: 0, failed: [] };
  for (const file of files) {
    try {
      const jsonPath = path.join(voicemailDir, file);
      const stat = await fsp.stat(jsonPath);
      if (stat.size > 64 * 1024) throw new Error('voicemail metadata exceeds 64 KiB');
      const meta = JSON.parse(await fsp.readFile(jsonPath, 'utf8')) as Record<string, unknown>;
      const base = file.slice(0, -5);
      const audioPath = path.join(voicemailDir, `${base}.mp3`);
      const [checksum, audio] = await Promise.all([sha256File(audioPath), probe(audioPath)]);
      const asset = store.putAsset({
        kind: 'hotline', checksum, sourceLocator: audioPath, playoutLocator: audioPath,
        title: 'Listener hotline', artist: null, tags: ['hotline'], durationMs: audio.durationMs,
        codecName: audio.codecName, sampleRateHz: audio.sampleRateHz, channels: audio.channels,
        bitRate: audio.bitRate, mimeType: audio.mimeType, raw: audio.raw,
        provenance: { source: 'existing_voicemail_import', original_filename: `${base}.mp3` },
      });
      const transcript = typeof meta.transcript === 'string' ? meta.transcript.slice(0, 12_000) : '';
      const archived = meta.archived === true;
      const prior = store.db.prepare('SELECT asset_id,transcript_private,moderation_version,status,archive_reason FROM hotline_candidates WHERE call_id=?').get(base) as { asset_id: string; transcript_private: string; moderation_version: number; status: string; archive_reason: string | null } | undefined;
      if (prior?.status === 'AIRED') { result.aired++; continue; }
      if (prior?.status === 'ARCHIVED') { result.archived++; continue; }
      const unchanged = prior && prior.asset_id === asset.assetId && prior.transcript_private === transcript.trim()
        && (archived ? prior.status === 'ARCHIVED' : prior.status !== 'ARCHIVED');
      const moderationVersion = prior ? prior.moderation_version + (unchanged ? 0 : 1) : 1;
      const registered = store.registerHotline({ callId: base, assetId: asset.assetId, transcript, moderationVersion, archived });
      result.imported++;
      registered.status === 'ELIGIBLE' ? result.eligible++ : result.ineligible++;
    } catch (error) {
      result.failed.push({ file, error: error instanceof Error ? error.message.slice(0, 500) : 'hotline import failed' });
    }
  }
  return result;
}

export class HotlineScanner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly store: AutomationStore, private readonly voicemailDir: string, private readonly intervalMs = 30_000) {}

  start(): void {
    if (this.timer) return;
    const scan = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const result = await importHotlines(this.store, this.voicemailDir);
        if (result.failed.length) process.stderr.write(`${JSON.stringify({ level: 'warn', event: 'hotline_import_partial', ...result })}\n`);
      } finally { this.running = false; }
    };
    void scan();
    this.timer = setInterval(() => { void scan(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

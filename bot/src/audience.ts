/**
 * Hourly audience log: web + YouTube listener counts sampled at the top of
 * each hour into feed/audience.jsonl (public, like status.json). Powers the
 * control room's 7-day chart and any future weekly recaps.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ListenerBreakdown } from './listeners.js';

export interface AudienceSample {
  /** ISO timestamp of the sample. */
  t: string;
  web: number | null;
  youtube: number | null;
  total: number | null;
  /** Humans in the voice channel (live show indicator). */
  humans: number;
  /** A rerun was airing at sample time. */
  rerun: boolean;
}

const RETENTION_DAYS = 120; // ~2.9k lines; trivial to keep around

export class AudienceLog {
  private samples: AudienceSample[] = [];
  private readonly file: string;

  constructor(
    feedDir: string,
    private readonly getListeners: () => Promise<ListenerBreakdown>,
    private readonly getSnapshot: () => { humans: number; rerun?: string | null },
  ) {
    this.file = join(feedDir, 'audience.jsonl');
  }

  async start(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8');
      this.samples = text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AudienceSample);
    } catch {
      this.samples = [];
    }
    // Catch-up sample if the bot was down across the last hour mark.
    const last = this.samples.at(-1);
    if (!last || Date.now() - Date.parse(last.t) > 65 * 60_000) void this.sample();
    this.scheduleNextHour();
    console.log(`[audience] hourly log -> ${this.file} (${this.samples.length} samples)`);
  }

  /** Samples land at :00:10 so minute-zero listener churn settles. */
  private scheduleNextHour(): void {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 10, 0);
    if (next.getTime() <= now.getTime()) next.setHours(next.getHours() + 1);
    setTimeout(() => {
      void this.sample().finally(() => this.scheduleNextHour());
    }, next.getTime() - now.getTime());
  }

  private async sample(): Promise<void> {
    try {
      const listeners = await this.getListeners();
      const snapshot = this.getSnapshot();
      this.samples.push({
        t: new Date().toISOString(),
        web: listeners.web,
        youtube: listeners.youtube,
        total: listeners.total,
        humans: snapshot.humans,
        rerun: Boolean(snapshot.rerun),
      });
      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
      this.samples = this.samples.filter((s) => Date.parse(s.t) >= cutoff);
      await writeFile(this.file, this.samples.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
    } catch (error) {
      console.warn('[audience] sample failed:', error instanceof Error ? error.message : error);
    }
  }

  recent(hours: number): AudienceSample[] {
    const cutoff = Date.now() - hours * 3_600_000;
    return this.samples.filter((s) => Date.parse(s.t) >= cutoff);
  }
}

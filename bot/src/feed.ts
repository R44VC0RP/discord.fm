/**
 * Channel activity feed, served as static files through Icecast's webroot
 * (fileserve). Writes:
 *   - feed.xml    RSS 2.0: joins/leaves with occupancy counts
 *   - status.json current state for programmatic use (website widgets)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FeedEvent {
  name: string;
  action: 'joined' | 'left';
  humans: number;
  at: number;
}

export interface PresenceSnapshot {
  live: boolean;
  humans: number;
  members: string[];
  /** Discord user IDs parallel to members (consumed by the recorder). */
  memberIds?: string[];
  /** Label of the recording currently replaying, if any. */
  rerun?: string | null;
}

export function onAirLine(snapshot: PresenceSnapshot): string {
  if (snapshot.humans > 0) return `ON AIR — ${snapshot.members.join(', ')}`;
  if (snapshot.rerun) return `RERUN — ${snapshot.rerun}`;
  return snapshot.live ? 'INTERMISSION — music through the static' : 'OFF AIR — static';
}

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export class ActivityFeed {
  private events: FeedEvent[] = [];
  private snapshot: PresenceSnapshot = { live: false, humans: 0, members: [] };
  private listeners: { web: number | null; youtube: number | null; total: number | null } | null = null;
  private enabled: boolean;

  constructor(
    private readonly dir: string,
    private readonly opts: { station: string; link: string; maxItems: number },
  ) {
    this.enabled = dir !== '';
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    try {
      await mkdir(this.dir, { recursive: true });
      await this.flush();
      console.log(`[feed] writing to ${this.dir} (feed.xml, status.json)`);
    } catch (error) {
      this.enabled = false;
      console.warn(
        '[feed] disabled, cannot write to dir:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  async record(name: string, action: 'joined' | 'left', snapshot: PresenceSnapshot): Promise<void> {
    if (!this.enabled) return;
    this.snapshot = snapshot;
    this.events.unshift({ name, action, humans: snapshot.humans, at: Date.now() });
    if (this.events.length > this.opts.maxItems) this.events.length = this.opts.maxItems;
    await this.flush();
  }

  async update(snapshot: PresenceSnapshot): Promise<void> {
    if (!this.enabled) return;
    this.snapshot = snapshot;
    await this.flush();
  }

  /** Periodic audience counts (web already excludes internal consumers). */
  async setListeners(breakdown: { web: number | null; youtube: number | null; total: number | null }): Promise<void> {
    if (!this.enabled || JSON.stringify(this.listeners) === JSON.stringify(breakdown)) return;
    this.listeners = breakdown;
    await this.flush();
  }

  private async flush(): Promise<void> {
    try {
      await Promise.all([
        writeFile(join(this.dir, 'feed.xml'), this.rss(), 'utf8'),
        writeFile(join(this.dir, 'status.json'), this.json(), 'utf8'),
        // Single line consumed by the TV encoder's drawtext (reload=1).
        writeFile(join(this.dir, 'onair.txt'), onAirLine(this.snapshot) + '\n', 'utf8'),
      ]);
    } catch (error) {
      console.warn('[feed] write failed:', error instanceof Error ? error.message : error);
    }
  }

  private rss(): string {
    const items = this.events
      .map((event) => {
        const title = `${event.name} ${event.action} — ${event.humans} in channel`;
        return [
          '    <item>',
          `      <title>${esc(title)}</title>`,
          `      <description>${esc(title)}</description>`,
          `      <pubDate>${new Date(event.at).toUTCString()}</pubDate>`,
          `      <guid isPermaLink="false">${event.at}-${esc(event.name)}-${event.action}</guid>`,
          '    </item>',
        ].join('\n');
      })
      .join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0">',
      '  <channel>',
      `    <title>${esc(this.opts.station)} — channel activity</title>`,
      `    <link>${esc(this.opts.link)}</link>`,
      `    <description>Voice channel joins and leaves for ${esc(this.opts.station)}</description>`,
      `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
      items,
      '  </channel>',
      '</rss>',
      '',
    ].join('\n');
  }

  private json(): string {
    return JSON.stringify(
      {
        station: this.opts.station,
        live: this.snapshot.live,
        humans: this.snapshot.humans,
        members: this.snapshot.members,
        memberIds: this.snapshot.memberIds ?? [],
        rerun: this.snapshot.rerun ?? null,
        // Combined audience (web stream + youtube); player shows this number.
        listeners: this.listeners?.total ?? null,
        sources: { web: this.listeners?.web ?? null, youtube: this.listeners?.youtube ?? null },
        updated: new Date().toISOString(),
      },
      null,
      2,
    );
  }
}

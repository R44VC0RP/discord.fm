/**
 * Hotline inbox helpers for the Discord-side experience: the "new message"
 * notification and the !list / !play / !air text commands.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

export interface HotlineItem {
  file: string;
  from: string;
  durationSeconds: number | null;
  transcript: string | null;
}

/** Inbox (non-archived), newest first — same ordering the control room shows. */
export async function listInbox(): Promise<HotlineItem[]> {
  const dir = config.voicemail.dir;
  const names = (await readdir(dir).catch(() => []))
    .filter((n) => n.startsWith('vm-') && n.endsWith('.mp3'))
    .sort()
    .reverse();
  const items: HotlineItem[] = [];
  for (const name of names) {
    let meta: { archived?: boolean; from?: string; durationSeconds?: number; transcript?: string } | null = null;
    try {
      meta = JSON.parse(await readFile(join(dir, name.replace(/\.mp3$/, '.json')), 'utf8'));
    } catch {
      // mid-write or missing metadata; still listable
    }
    if (meta?.archived) continue;
    items.push({
      file: name,
      from: meta?.from ?? 'unknown',
      durationSeconds: meta?.durationSeconds ?? null,
      transcript: meta?.transcript?.trim() || null,
    });
  }
  return items;
}

/** "Jul 2 · 7:14 PM · •••-1234 (32s)" in the station timezone. */
export function hotlineLabel(item: HotlineItem): string {
  const match = item.file.match(/^vm-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  let when = item.file.replace(/\.mp3$/, '');
  if (match) {
    const d = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!));
    const tz = config.station.timeZone;
    const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
    when = `${date} · ${time}`;
  }
  const digits = item.from.replace(/\D/g, '');
  const masked = digits.length >= 4 ? `•••-${digits.slice(-4)}` : item.from;
  const duration = item.durationSeconds ? ` (${item.durationSeconds}s)` : '';
  return `${when} · ${masked}${duration}`;
}

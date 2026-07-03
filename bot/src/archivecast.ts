/**
 * Archive caster: every finished session recording gets rendered to a
 * branded mp4 (via the admin app's renderer, cached in recordings/mp4/) and
 * posted to the archive channel, @-mentioning everyone who was on air.
 *
 * The archive-quality mp4 is always rendered (it also powers the control
 * room download button). If it exceeds the guild's upload cap, a second
 * size-budgeted "discord" variant is rendered and posted instead.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client, Guild } from 'discord.js';
import { config } from './config.js';

const POLL_MS = 30_000;
const RENDER_POLL_MS = 5_000;
const RENDER_TIMEOUT_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;

interface SessionMeta {
  startedAt?: string;
  durationSeconds?: number;
  members?: string[];
  memberIds?: string[];
  files?: string[];
}

interface PostState {
  /** session json base name -> ISO timestamp or "failed" */
  posted: Record<string, string>;
}

function uploadLimitBytes(guild: Guild): number {
  // Discord upload caps by boost tier (2024+ base is 10MB).
  if (guild.premiumTier >= 3) return 100 * 1024 * 1024;
  if (guild.premiumTier >= 2) return 50 * 1024 * 1024;
  return 10 * 1024 * 1024;
}

const fmtDur = (s: number) => `${Math.floor(s / 60)}m${String(Math.round(s) % 60).padStart(2, '0')}s`;

export class ArchiveCaster {
  private state: PostState = { posted: {} };
  private attempts = new Map<string, number>();
  private readonly stateFile: string;
  private busy = false;

  constructor(
    private readonly client: Client,
    private readonly channelId: string,
    private readonly recordingsDir: string,
    stateDir: string,
  ) {
    this.stateFile = join(stateDir, 'archive-posts.json');
  }

  async start(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, 'utf8')) as PostState;
      if (!this.state.posted) this.state = { posted: {} };
    } catch {
      // First run: mark the existing archive as posted so we never spam
      // history — only sessions finishing after this ship get announced.
      this.state = { posted: {} };
      for (const name of await this.sessionJsons()) this.state.posted[name] = 'preexisting';
      await this.save();
    }
    setInterval(() => void this.tick(), POLL_MS);
    console.log(`[archivecast] watching ${this.recordingsDir} -> channel ${this.channelId}`);
  }

  private async sessionJsons(): Promise<string[]> {
    const names = await readdir(this.recordingsDir).catch(() => [] as string[]);
    return names.filter((n) => n.startsWith('session-') && n.endsWith('.json')).sort();
  }

  private async save(): Promise<void> {
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8').catch((error) =>
      console.warn('[archivecast] state save failed:', error instanceof Error ? error.message : error),
    );
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const pending = (await this.sessionJsons()).filter((n) => !this.state.posted[n]);
    if (pending.length === 0) return;
    this.busy = true;
    try {
      await this.process(pending[0]!);
    } catch (error) {
      const name = pending[0]!;
      const tries = (this.attempts.get(name) ?? 0) + 1;
      this.attempts.set(name, tries);
      console.warn(`[archivecast] ${name} attempt ${tries} failed:`, error instanceof Error ? error.message : error);
      if (tries >= MAX_ATTEMPTS) {
        this.state.posted[name] = 'failed';
        await this.save();
      }
    } finally {
      this.busy = false;
    }
  }

  private async process(jsonName: string): Promise<void> {
    const meta = JSON.parse(await readFile(join(this.recordingsDir, jsonName), 'utf8')) as SessionMeta;
    const files = (meta.files ?? [jsonName.replace(/\.json$/, '.mp3')]).filter((f) =>
      existsSync(join(this.recordingsDir, f)),
    );
    if (files.length === 0) {
      // Recording already retention-deleted; nothing to post.
      this.state.posted[jsonName] = 'gone';
      await this.save();
      return;
    }

    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel?.isSendable() || channel.isDMBased()) throw new Error(`channel ${this.channelId} not sendable`);
    const limit = uploadLimitBytes(channel.guild) - 512 * 1024; // safety margin

    // Resolve mentions (humans only; old metas without ids fall back to names).
    const mentions: string[] = [];
    for (const id of meta.memberIds ?? []) {
      const user = await this.client.users.fetch(id).catch(() => null);
      if (user && !user.bot) mentions.push(id);
    }
    const who = mentions.length
      ? mentions.map((id) => `<@${id}>`).join(' & ')
      : (meta.members?.join(', ') || 'the anomaly');

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const attachment = await this.renderFitting(file, limit);
      const content =
        i === 0
          ? `📼 ${who} just finished their session — ${fmtDur(meta.durationSeconds ?? 0)} on ${config.station.name}`
          : `📼 …part ${i + 1}`;
      await channel.send({
        content,
        files: [{ attachment, name: `anomalyfm-${file.replace(/\.mp3$/, '.mp4')}` }],
        allowedMentions: { users: i === 0 ? mentions : [] },
      });
    }

    this.state.posted[jsonName] = new Date().toISOString();
    await this.save();
    console.log(`[archivecast] posted ${jsonName} (${files.length} file${files.length === 1 ? '' : 's'})`);
  }

  /** Archive-quality render first (also feeds the control room cache); the
   *  budgeted discord variant only when that one is too big to upload. */
  private async renderFitting(file: string, limit: number): Promise<string> {
    const plain = await this.renderViaAdmin(file, '');
    const size = (await stat(plain)).size;
    if (size <= limit) return plain;
    console.log(`[archivecast] ${file} mp4 is ${(size / 1048576).toFixed(1)}MB > cap; rendering discord variant`);
    return this.renderViaAdmin(file, `?variant=discord&budget=${limit}`);
  }

  private async renderViaAdmin(file: string, query: string): Promise<string> {
    const base = `${config.archive.adminApi}/api/recordings/${encodeURIComponent(file)}/mp4`;
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    // Kick off (retry through 429 busy — the admin renders one at a time).
    for (;;) {
      const res = await fetch(base + query, { method: 'POST', signal: AbortSignal.timeout(10_000) });
      if (res.status !== 429) {
        if (!res.ok) throw new Error(`render start failed: ${res.status}`);
        break;
      }
      if (Date.now() > deadline) throw new Error('render queue timeout (admin busy)');
      await new Promise((r) => setTimeout(r, 15_000));
    }
    for (;;) {
      const res = await fetch(`${base}/status${query}`, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { status: string; error?: string };
      if (body.status === 'ready') break;
      if (body.status === 'error') throw new Error(`render failed: ${body.error ?? 'unknown'}`);
      if (Date.now() > deadline) throw new Error('render timeout');
      await new Promise((r) => setTimeout(r, RENDER_POLL_MS));
    }
    const variant = query.includes('variant=discord') ? 'discord' : '';
    const out = join(
      this.recordingsDir,
      'mp4',
      file.replace(/\.mp3$/, variant ? `.${variant}.mp4` : '.mp4'),
    );
    if (!existsSync(out)) throw new Error(`rendered file missing: ${out}`);
    return out;
  }
}

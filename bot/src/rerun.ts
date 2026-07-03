/**
 * Rerun engine v2: replays past session recordings while the channel is
 * empty, paced so the station never feels repetitive.
 *
 * Pacing rules:
 *  - After live ends (humans -> 0): wait RERUN_AFTER_LIVE_MIN before any
 *    rerun starts.
 *  - Between reruns: wait RERUN_GAP_MIN of music bed before the next one.
 *  - Rotation: play the OLDEST not-yet-played recording first, and never
 *    repeat one until every other recording has aired. The rotation state
 *    persists across restarts (feed/rerun-state.json).
 *  - A rerun interrupted by live pauses (position saved) and resumes first
 *    once the post-live wait passes.
 *  - Admin-cued items (queue) play before everything and bypass the wait.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BYTES_PER_FRAME, FRAME_MS, type MusicFrameSource } from './mixer.js';

/**
 * Human-friendly on-air label for a session recording:
 * "Jul 2 | 6:54 PM | David, vogel, Frank" (station timezone).
 * Falls back to the bare filename when parsing fails.
 */
export async function sessionLabel(dir: string, fileName: string, timeZone: string): Promise<string> {
  const name = basename(fileName);
  const match = name.match(/^session-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return name.replace(/\.mp3$/, '');

  const when = new Date(
    Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!),
  );
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(when);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(when);

  let who = '';
  try {
    const metaFile = join(dir, name.replace(/(-part\d+)?\.mp3$/, '.json'));
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as { members?: string[] };
    if (meta.members?.length) who = meta.members.join(', ');
  } catch {
    // metadata missing (in-flight or deleted); date/time still reads fine
  }

  const part = name.match(/-part(\d+)\.mp3$/);
  return `${date} | ${time}${who ? ` | ${who}` : ''}${part ? ` (part ${part[1]})` : ''}`;
}

const MAX_BUFFERED_BYTES = BYTES_PER_FRAME * 50;
const RESUME_BELOW_BYTES = BYTES_PER_FRAME * 25;

/** Plays a single file once (no loop); reports when fully drained. */
class RerunDeck implements MusicFrameSource {
  private child: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private paused = false;
  private stopping = false;
  private childExited = false;
  private endedFired = false;
  private framesRead = 0;

  onEnded?: () => void;

  constructor(
    readonly file: string,
    private readonly offsetSeconds: number,
  ) {}

  /** Seconds of the file consumed so far (including the resume offset). */
  get position(): number {
    return this.offsetSeconds + (this.framesRead * FRAME_MS) / 1000;
  }

  start(): void {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (this.offsetSeconds > 0) args.push('-ss', String(this.offsetSeconds));
    args.push('-i', this.file, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    child.stdout!.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (!this.paused && this.buffered > MAX_BUFFERED_BYTES) {
        this.paused = true;
        child.stdout!.pause();
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      for (const line of text.split('\n')) if (line.trim()) console.warn('[rerun:ffmpeg]', line.trim());
    });
    child.on('error', (error) => console.error('[rerun] spawn failed:', error.message));
    child.on('close', () => {
      this.childExited = true;
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  readFrame(): Buffer | null {
    if (this.buffered < BYTES_PER_FRAME) {
      if (this.childExited && !this.endedFired && !this.stopping) {
        this.endedFired = true;
        queueMicrotask(() => this.onEnded?.());
      }
      return null;
    }
    const frame = Buffer.allocUnsafe(BYTES_PER_FRAME);
    let offset = 0;
    while (offset < BYTES_PER_FRAME) {
      const head = this.chunks[0]!;
      const take = Math.min(head.length, BYTES_PER_FRAME - offset);
      head.copy(frame, offset, 0, take);
      offset += take;
      this.buffered -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.framesRead += 1;
    if (this.paused && this.buffered < RESUME_BELOW_BYTES) {
      this.paused = false;
      this.child?.stdout?.resume();
    }
    return frame;
  }
}

interface DeckHost {
  setDeckSource(source: MusicFrameSource | null): void;
}

export interface RerunManagerOptions {
  auto: boolean;
  /** Wait after live ends before any rerun. */
  afterLiveMs: number;
  /** Wait between consecutive reruns. */
  gapMs: number;
  /** Rotation persistence (empty disables persistence). */
  stateFile: string;
  /** Station timezone for on-air session labels. */
  timeZone: string;
}

export interface RerunState {
  playing: string | null;
  position: number | null;
  paused: { file: string; offset: number } | null;
  queue: string[];
  auto: boolean;
  /** What plays next when the wait elapses (null when live or nothing to play). */
  nextUp: string | null;
  /** Seconds until the next rerun may start (null when not applicable). */
  waitSeconds: number | null;
  cycle: { played: number; total: number };
}

export class RerunManager {
  private queue: string[] = [];
  private deck: RerunDeck | null = null;
  private pausedState: { file: string; offset: number } | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private humans = -1; // unknown until first presence event
  private nextAllowedAt = 0;
  private played = new Set<string>();
  auto: boolean;

  /** Called when playback starts/stops so the feed/player can reflect it. */
  onChange?: () => void;

  constructor(
    private readonly mixer: DeckHost,
    private readonly recordingsDir: string,
    private readonly opts: RerunManagerOptions,
  ) {
    this.auto = opts.auto;
    if (opts.stateFile) {
      try {
        const saved = JSON.parse(readFileSync(opts.stateFile, 'utf8')) as { played?: string[] };
        for (const name of saved.played ?? []) this.played.add(name);
        console.log(`[rerun] rotation restored (${this.played.size} played this cycle)`);
      } catch {
        // first run
      }
    }
  }

  private currentLabel: string | null = null;

  get nowPlayingLabel(): string | null {
    if (!this.deck) return null;
    return this.currentLabel ?? basename(this.deck.file).replace(/\.mp3$/, '');
  }

  async state(): Promise<RerunState> {
    const files = await this.listRecordings();
    const idleAndWaiting =
      !this.deck && this.humans === 0 && (this.queue.length > 0 || this.pausedState !== null || this.auto);
    return {
      playing: this.deck ? basename(this.deck.file) : null,
      position: this.deck ? Math.round(this.deck.position) : null,
      paused: this.pausedState,
      queue: [...this.queue],
      auto: this.auto,
      nextUp: idleAndWaiting
        ? (this.queue[0] ?? this.pausedState?.file ?? this.pickOldestUnplayed(files))
        : null,
      waitSeconds: idleAndWaiting ? Math.max(0, Math.ceil((this.nextAllowedAt - Date.now()) / 1000)) : null,
      cycle: { played: this.played.size, total: files.length },
    };
  }

  /** Admin cue: plays before rotation and bypasses the pacing wait. */
  enqueue(file: string): void {
    this.queue.push(file);
    if (!this.deck && this.humans === 0) {
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      void this.startNext();
    }
  }

  unqueue(index: number): void {
    this.queue.splice(index, 1);
  }

  setAuto(enabled: boolean): void {
    this.auto = enabled;
    if (enabled) this.armStart();
  }

  /** Skip the current rerun; the gap wait applies before the next one. */
  skip(): void {
    if (this.deck) {
      this.markPlayed(this.deck.file);
      this.stopDeck();
      this.nextAllowedAt = Date.now() + this.opts.gapMs;
      this.armStart();
    }
    this.pausedState = null;
    this.onChange?.();
  }

  onPresence(humans: number): void {
    const previous = this.humans;
    this.humans = humans;
    if (humans > 0) {
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      if (this.deck) {
        this.pausedState = { file: this.deck.file, offset: Math.max(0, this.deck.position - 2) };
        console.log(`[rerun] paused ${basename(this.deck.file)} at ${Math.round(this.deck.position)}s (live)`);
        this.stopDeck();
        this.onChange?.();
      }
      return;
    }
    // Channel just emptied (or first observation): the post-live wait starts.
    if (previous !== 0) {
      this.nextAllowedAt = Date.now() + this.opts.afterLiveMs;
      console.log(`[rerun] channel empty; reruns unlocked in ${Math.round(this.opts.afterLiveMs / 60000)}m`);
    }
    this.armStart();
  }

  private armStart(): void {
    if (this.humans !== 0 || this.deck || this.startTimer) return;
    if (!this.pausedState && this.queue.length === 0 && !this.auto) return;
    const delay = Math.max(0, this.nextAllowedAt - Date.now());
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.startNext();
    }, delay);
  }

  private async startNext(): Promise<void> {
    if (this.humans !== 0 || this.deck) return;

    let file: string | null = null;
    let offset = 0;
    if (this.queue.length > 0) {
      file = this.queue.shift()!;
    } else if (this.pausedState) {
      file = this.pausedState.file;
      offset = this.pausedState.offset;
      this.pausedState = null;
    } else if (this.auto) {
      file = this.pickOldestUnplayed(await this.listRecordings());
    }
    if (!file) return;

    const path = join(this.recordingsDir, basename(file));
    const deck = new RerunDeck(path, offset);
    deck.onEnded = () => {
      this.markPlayed(deck.file);
      this.stopDeck();
      this.nextAllowedAt = Date.now() + this.opts.gapMs;
      console.log(`[rerun] finished ${basename(path)}; next rerun unlocked in ${Math.round(this.opts.gapMs / 60000)}m`);
      this.onChange?.();
      this.armStart();
    };
    this.currentLabel = await sessionLabel(this.recordingsDir, basename(file), this.opts.timeZone);
    this.deck = deck;
    deck.start();
    this.mixer.setDeckSource(deck);
    console.log(`[rerun] playing ${basename(path)} ("${this.currentLabel}")${offset ? ` from ${Math.round(offset)}s` : ''}`);
    this.onChange?.();
  }

  private stopDeck(): void {
    this.mixer.setDeckSource(null);
    this.deck?.stop();
    this.deck = null;
    this.currentLabel = null;
  }

  private async listRecordings(): Promise<string[]> {
    try {
      const files = (await readdir(this.recordingsDir))
        .filter((name) => name.startsWith('session-') && name.endsWith('.mp3'))
        .sort(); // timestamped names sort chronologically, oldest first
      // Retention may have deleted files this cycle already counted.
      const existing = new Set(files);
      for (const name of this.played) if (!existing.has(name)) this.played.delete(name);
      return files;
    } catch {
      return [];
    }
  }

  /** Oldest recording not yet played this cycle; cycle resets when exhausted. */
  private pickOldestUnplayed(files: string[]): string | null {
    if (files.length === 0) return null;
    let unplayed = files.filter((name) => !this.played.has(name));
    if (unplayed.length === 0) {
      console.log('[rerun] cycle complete: every recording has aired; starting over from the oldest');
      this.played.clear();
      this.persist();
      unplayed = files;
    }
    return unplayed[0]!;
  }

  private markPlayed(filePath: string): void {
    this.played.add(basename(filePath));
    this.persist();
  }

  /** Writes are chained so concurrent persists can't land out of order. */
  private persistChain: Promise<void> = Promise.resolve();
  private persist(): void {
    if (!this.opts.stateFile) return;
    const data = JSON.stringify({ played: [...this.played] }, null, 2);
    this.persistChain = this.persistChain
      .then(() => writeFile(this.opts.stateFile, data, 'utf8'))
      .catch((error: unknown) => {
        console.warn('[rerun] failed to persist rotation:', error instanceof Error ? error.message : error);
      });
  }
}

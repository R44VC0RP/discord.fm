/**
 * Looping background-music source.
 *
 * A persistent ffmpeg process decodes the track to 48kHz stereo s16le PCM and
 * loops it forever (-stream_loop -1). We pull one 20ms frame per mixer tick
 * and pause the pipe once ~1s is buffered, so a multi-hour file costs a few
 * hundred KB of memory instead of gigabytes of decoded PCM.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { BYTES_PER_FRAME } from './mixer.js';

const MAX_BUFFERED_BYTES = BYTES_PER_FRAME * 50; // ~1s
const RESUME_BELOW_BYTES = BYTES_PER_FRAME * 25; // ~0.5s
const RESPAWN_DELAY_MS = 2000;

export class MusicSource {
  private child: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private paused = false;
  private stopping = false;
  private respawnTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  start(): void {
    this.stopping = false;
    this.spawnChild();
  }

  stop(): void {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  /** Returns one frame of PCM, or null on underrun (mixer plays without music). */
  readFrame(): Buffer | null {
    if (this.buffered < BYTES_PER_FRAME) return null;

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

    if (this.paused && this.buffered < RESUME_BELOW_BYTES) {
      this.paused = false;
      this.child?.stdout?.resume();
    }
    return frame;
  }

  private spawnChild(): void {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-stream_loop', '-1',
        '-i', this.file,
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.chunks = [];
    this.buffered = 0;
    this.paused = false;

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
      for (const line of text.split('\n')) {
        if (line.trim()) console.warn(`[music:ffmpeg] ${line.trim()}`);
      }
    });

    child.on('error', (error) => {
      console.error('[music] failed to spawn ffmpeg:', error.message);
    });

    child.on('close', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      console.warn(`[music] decoder exited (code=${code}); respawning in ${RESPAWN_DELAY_MS}ms`);
      this.respawnTimer = setTimeout(() => this.spawnChild(), RESPAWN_DELAY_MS);
    });
  }
}

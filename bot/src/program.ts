/**
 * Finite automation sources and the narrow asset verification boundary.
 *
 * Automation owns locators, but the bot treats them as hostile even on the
 * private network.  A locator is never assembled from cue metadata.
 */
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BYTES_PER_FRAME, FRAME_MS, type ProgramFrameSource } from './mixer.js';

const MAX_BUFFERED_BYTES = BYTES_PER_FRAME * 50;
const RESUME_BELOW_BYTES = BYTES_PER_FRAME * 25;
const KILL_GRACE_MS = 1500;

export interface VerifiedAsset {
  path: string;
  checksum: string;
}

/** Fail closed for symlinks, special files, roots, and checksum changes. */
export async function verifyProgramAsset(locator: string, checksum: string, allowedRoots: string[]): Promise<VerifiedAsset> {
  if (!/^[a-f0-9]{64}$/iu.test(checksum) || !path.isAbsolute(locator)) throw new Error('invalid automation asset claim');
  const lexicalCandidate = path.resolve(locator);
  const roots = (await Promise.all(allowedRoots.filter(Boolean).map(async (configured) => {
    try { return { lexical: path.resolve(configured), canonical: await realpath(configured) }; }
    catch { return null; }
  }))).filter((root): root is { lexical: string; canonical: string } => root !== null);
  const matched = roots.find((item) => {
    const relative = path.relative(item.lexical, lexicalCandidate);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  });
  if (!matched) throw new Error('automation asset is outside allowed roots');
  // macOS has /var -> /private/var; translate into the canonical root before
  // walking components so a benign system alias does not look like an escape.
  const root = matched.canonical;
  const candidate = path.join(root, path.relative(matched.lexical, lexicalCandidate));

  // lstat every component, not merely the final entry, so a directory symlink
  // cannot redirect a seemingly-valid child after catalog validation.
  let cursor = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    cursor = path.join(cursor, part);
    const entry = await fs.promises.lstat(cursor);
    if (entry.isSymbolicLink()) throw new Error('automation asset contains a symlink');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await open(candidate, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('automation asset is not a regular file');
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest('hex') !== checksum.toLowerCase()) throw new Error('automation asset checksum mismatch');
  } finally {
    await handle.close();
  }
  // A final canonical containment check catches filesystem races before the
  // decoder is spawned. Assets are read-only bind mounts in production.
  const canonical = await realpath(candidate);
  const finalRelative = path.relative(root, canonical);
  if ((finalRelative === '..' || finalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(finalRelative)) || !(await stat(canonical)).isFile()) {
    throw new Error('automation asset changed during validation');
  }
  return { path: canonical, checksum: checksum.toLowerCase() };
}

/** A bounded, observable one-shot ffmpeg decoder. */
export class ProgramSource implements ProgramFrameSource {
  private child: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private paused = false;
  private stopped = false;
  private exited = false;
  private frames = 0;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private lastDataAt = Date.now();
  private failed = false;
  onError?: (error: Error) => void;

  constructor(
    readonly file: string,
    readonly offsetMs = 0,
    private readonly decoderCommand = 'ffmpeg',
    private readonly prebufferTimeoutMs = 6000,
  ) {}

  get positionMs(): number { return this.offsetMs + this.frames * FRAME_MS; }
  get finished(): boolean { return this.exited && this.buffered < BYTES_PER_FRAME; }
  /** Decoder has neither data nor a terminal state long enough to be unsafe. */
  get stalled(): boolean { return !this.stopped && !this.finished && (this.failed || (this.buffered < BYTES_PER_FRAME && Date.now() - this.lastDataAt > 5000)); }
  /** Testable terminal state; close may follow SIGTERM asynchronously. */
  get terminated(): boolean { return this.stopped && (this.child === null || this.exited); }
  /** Exposes initiation separately from the asynchronous child close. */
  get teardownInitiated(): boolean { return this.stopped; }

  start(): Promise<void> {
    if (this.child) return Promise.resolve();
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (this.offsetMs > 0) args.push('-ss', (this.offsetMs / 1000).toFixed(3));
    args.push('-i', this.file, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
    const child = spawn(this.decoderCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.rejectStart(new Error('automation decoder prebuffer timed out')), this.prebufferTimeoutMs);
      this.readyResolve = () => { clearTimeout(timeout); resolve(); };
      this.readyReject = (error) => { clearTimeout(timeout); reject(error); };
      child.stdout!.on('data', (chunk: Buffer) => {
        this.lastDataAt = Date.now();
        this.chunks.push(chunk); this.buffered += chunk.length;
        if (this.buffered >= BYTES_PER_FRAME) {
          this.readyResolve?.(); this.readyResolve = null; this.readyReject = null;
        }
        if (!this.paused && this.buffered > MAX_BUFFERED_BYTES) { this.paused = true; child.stdout!.pause(); }
      });
      // ffmpeg can write diagnostics after stdout is paused. Always consume it
      // so a full stderr pipe cannot keep the child alive indefinitely.
      child.stderr?.on('data', () => {});
      child.on('error', (error) => this.fail(error));
      child.stdout?.on('error', (error) => this.fail(error));
      child.stderr?.on('error', (error) => this.fail(error));
      child.on('close', (code) => {
        if (this.killTimer) clearTimeout(this.killTimer);
        this.killTimer = null;
        this.exited = true;
        if (!this.stopped && code !== 0) this.fail(new Error(`automation decoder exited (code=${code})`));
        this.child = null;
        if (!this.stopped && this.readyReject && this.buffered < BYTES_PER_FRAME) {
          this.rejectStart(new Error(`automation decoder exited before audio (code=${code})`));
        }
      });
    });
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    // Resume first: a paused pipe can otherwise delay normal child teardown.
    child?.stdout?.resume();
    child?.stderr?.resume();
    if (child && !child.killed) {
      child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (!this.exited) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      this.killTimer.unref();
    }
    this.chunks = []; this.buffered = 0;
  }

  readFrame(): Buffer | null {
    if (this.buffered < BYTES_PER_FRAME) return null;
    const frame = Buffer.allocUnsafe(BYTES_PER_FRAME);
    let at = 0;
    while (at < BYTES_PER_FRAME) {
      const first = this.chunks[0]!;
      const take = Math.min(first.length, BYTES_PER_FRAME - at);
      first.copy(frame, at, 0, take); at += take; this.buffered -= take;
      if (take === first.length) this.chunks.shift(); else this.chunks[0] = first.subarray(take);
    }
    this.frames += 1;
    if (this.paused && this.buffered < RESUME_BELOW_BYTES) { this.paused = false; this.child?.stdout?.resume(); }
    return frame;
  }

  private fail(error: Error): void {
    this.failed = true;
    if (this.readyReject) { this.rejectStart(error); return; }
    if (!this.stopped) this.onError?.(error);
  }

  /** Rejecting prebuffer is also a resource-lifecycle event, not just a promise. */
  private rejectStart(error: Error): void {
    const reject = this.readyReject;
    this.readyResolve = null; this.readyReject = null;
    this.stop();
    reject?.(error);
  }
}

/** Intentional quiet is still a finite source, so the bed cannot leak through. */
export class SilenceSource implements ProgramFrameSource {
  private remaining: number;
  constructor(durationMs: number) { this.remaining = Math.max(1, Math.ceil(durationMs / FRAME_MS)); }
  get finished(): boolean { return this.remaining <= 0; }
  readFrame(): Buffer | null {
    if (this.remaining <= 0) return null;
    this.remaining -= 1;
    return Buffer.alloc(BYTES_PER_FRAME);
  }
  stop(): void { this.remaining = 0; }
}

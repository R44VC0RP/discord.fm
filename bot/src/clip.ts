/**
 * /clip: rolling tape of the aired mp3 (exactly what listeners heard,
 * crackle and all) + offline mp4 render with the station clip art and a
 * live waveform, ready to post anywhere.
 *
 * Memory math: 96kbps mono = 12KB/s, so a 300s+slack buffer is ~3.7MB.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';

export const CLIP_MIN_S = 5;
export const CLIP_MAX_S = 300;

/** Rolling buffer of encoded mp3 chunks, sliced by byte-rate on demand. */
export class ClipBuffer {
  private chunks: Buffer[] = [];
  private total = 0;
  readonly bytesPerSec: number;
  private readonly maxBytes: number;

  constructor(bitrate: string, maxSeconds: number) {
    const kbps = Number.parseInt(bitrate, 10) || 96;
    this.bytesPerSec = (kbps * 1000) / 8;
    this.maxBytes = Math.ceil((maxSeconds + 10) * this.bytesPerSec);
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      this.total -= this.chunks.shift()!.length;
    }
  }

  bufferedSeconds(): number {
    return this.total / this.bytesPerSec;
  }

  /**
   * Last N seconds of tape. The cut lands mid-frame; ffmpeg resyncs on the
   * next mp3 header (~24ms slop nobody can hear).
   */
  lastSeconds(seconds: number): Buffer {
    const need = Math.ceil(seconds * this.bytesPerSec);
    const parts: Buffer[] = [];
    let got = 0;
    for (let i = this.chunks.length - 1; i >= 0 && got < need; i--) {
      parts.unshift(this.chunks[i]!);
      got += this.chunks[i]!.length;
    }
    const all = Buffer.concat(parts);
    return all.length > need ? all.subarray(all.length - need) : all;
  }
}

let rendering = false;
export function clipRenderBusy(): boolean {
  return rendering;
}

export interface ClipResult {
  path: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
}

/**
 * Renders audio -> branded mp4: clip art background, showwaves in the same
 * slot as the TV encoder, blinking on-air box + label line. Capped-CRF so
 * short clips stay small and 300s clips still fit Discord's 10MB.
 */
export async function renderClip(mp3: Buffer, durationS: number, label: string): Promise<ClipResult> {
  if (rendering) throw new Error('another clip is already rendering');
  rendering = true;

  const artPath = join(config.web.dir, 'clip.png');
  const fontPath = join(config.web.dir, 'fonts', 'PixelifySans.ttf');
  const dir = await mkdtemp(join(tmpdir(), 'clip-'));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const audioPath = join(dir, 'clip.mp3');
    const labelPath = join(dir, 'label.txt');
    const outPath = join(dir, 'clip.mp4');
    await writeFile(audioPath, mp3);
    await writeFile(labelPath, label, 'utf8');

    // Fit ~8.5MB total: aac mono 96k + capped-CRF video sized to duration.
    const audioBps = 96_000;
    const budgetBits = 8.5 * 1024 * 1024 * 8;
    const maxVideoBps = Math.round(
      Math.min(1_500_000, Math.max(150_000, budgetBits / durationS - audioBps)),
    );

    const fps = 24;
    const filter =
      '[0:a]asplit=2[aout][awave];' +
      `[awave]showwaves=s=520x150:mode=cline:rate=${fps}:colors=0x3e968f[waves];` +
      '[1:v][waves]overlay=96:470[v1];' +
      "[v1]drawbox=x=96:y=658:w=16:h=16:color=0x3e968f:t=fill:enable='lt(mod(t,1.7),0.85)'[v2];" +
      `[v2]drawtext=textfile=${labelPath}:fontfile=${fontPath}:fontsize=30:fontcolor=0x17140f:x=126:y=648[vout]`;

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', audioPath,
      '-loop', '1', '-framerate', String(fps), '-i', artPath,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-maxrate', String(maxVideoBps), '-bufsize', String(maxVideoBps * 2),
      '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
      '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '1',
      // -shortest alone hangs on ffmpeg 5.x (Debian): the looped image input
      // never EOFs, so video generation runs forever. The explicit -t stops it.
      '-t', (durationS + 0.3).toFixed(2),
      '-shortest', '-movflags', '+faststart',
      '-y', outPath,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => {
        stderr = (stderr + text).slice(-2000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`));
      });
      // Renders run ~10x realtime; a hung ffmpeg should not wedge /clip forever.
      setTimeout(() => child.kill('SIGKILL'), 120_000).unref();
    });

    const { size } = await stat(outPath);
    return { path: outPath, sizeBytes: size, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    rendering = false;
  }
}

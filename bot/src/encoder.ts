/**
 * ffmpeg encoder: mixed PCM in via stdin -> radio filter chain -> MP3 -> Icecast.
 *
 * The "am" preset collapses to mono, band-limits to the AM broadcast range,
 * squashes dynamics like a transmitter compressor, adds gentle tube-ish
 * saturation, a slow carrier fade, and a pink-noise static bed. The static
 * runs even when nobody is talking, so the station sounds like a live AM
 * frequency instead of dead digital silence.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { config } from './config.js';

const RESPAWN_DELAY_MS = 2000;

function icecastUrl(): string {
  const { host, port, mount, sourcePassword } = config.icecast;
  const path = mount.startsWith('/') ? mount : `/${mount}`;
  return `icecast://source:${encodeURIComponent(sourcePassword)}@${host}:${port}${path}`;
}

export function buildFfmpegArgs(): string[] {
  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'warning',
    // Input 0: the mixer's continuous 48kHz stereo s16le PCM stream.
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
  ];

  // Two outputs off the same processed audio: icecast (the station) and a
  // second mp3 stream on stdout that feeds the in-memory /clip ring buffer.
  let icecastMap: string[];
  let clipMap: string[];

  if (config.radio.preset === 'am') {
    const { lowcutHz, highcutHz, noiseLevel, flutterHz, flutterDepth } = config.radio.am;
    // Input 1: pink-noise static bed.
    args.push(
      '-f', 'lavfi',
      '-i', `anoisesrc=colour=pink:sample_rate=48000:amplitude=${noiseLevel}`,
    );
    const voiceChain = [
      // AM is mono.
      'pan=mono|c0=0.5*c0+0.5*c1',
      // Narrow AM broadcast bandwidth.
      `highpass=f=${lowcutHz}:p=2`,
      `lowpass=f=${highcutHz}:p=2`,
      // Broadcast-style heavy compression.
      'acompressor=threshold=0.12:ratio=4:attack=5:release=150:makeup=2',
      // Drive into a soft clipper for mild transmitter saturation.
      'volume=1.4',
      'asoftclip=type=atan',
      // Slow signal fade, like a distant station drifting.
      `tremolo=f=${flutterHz}:d=${flutterDepth}`,
    ].join(',');
    args.push(
      '-filter_complex',
      `[0:a]${voiceChain}[voice];[voice][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,asplit=2[out][clip]`,
    );
    icecastMap = ['-map', '[out]', '-ac', '1'];
    clipMap = ['-map', '[clip]', '-ac', '1'];
  } else {
    icecastMap = ['-map', '0:a', '-ac', '2'];
    clipMap = ['-map', '0:a', '-ac', '2'];
  }

  // Output 0: the station mount.
  args.push(
    ...icecastMap,
    '-c:a', 'libmp3lame',
    '-b:a', config.radio.bitrate,
    '-content_type', 'audio/mpeg',
    '-ice_name', config.station.name,
    '-ice_description', config.station.description,
    '-ice_genre', config.station.genre,
    '-f', 'mp3',
    icecastUrl(),
  );

  // Output 1: identical mp3 on stdout for the clip ring buffer.
  args.push(
    ...clipMap,
    '-c:a', 'libmp3lame',
    '-b:a', config.radio.bitrate,
    '-f', 'mp3',
    'pipe:1',
  );

  return args;
}

export class Encoder {
  private child: ChildProcess | null = null;
  private stopping = false;
  private respawnTimer: NodeJS.Timeout | null = null;
  private lastFailureLog = 0;

  /** Receives the aired mp3 (post AM chain) chunk-by-chunk; feeds /clip. */
  onMp3: ((chunk: Buffer) => void) | null = null;

  start(): void {
    this.stopping = false;
    this.spawnChild();
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Called by the mixer every 20ms. Drops frames while ffmpeg is down. */
  write(frame: Buffer): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.write(frame);
    } catch {
      // EPIPE during ffmpeg death; respawn logic will recover.
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    if (this.child) {
      this.child.stdin?.end();
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  private spawnChild(): void {
    const args = buildFfmpegArgs();
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    child.stdin.on('error', () => {
      // Swallow EPIPE writes racing the process exit.
    });

    child.stdout!.on('data', (chunk: Buffer) => {
      this.onMp3?.(chunk);
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      stderrTail = (stderrTail + text).slice(-2000);
      for (const line of text.split('\n')) {
        if (line.trim()) console.warn(`[ffmpeg] ${line.trim()}`);
      }
    });

    child.on('error', (error) => {
      console.error('[encoder] failed to spawn ffmpeg:', error.message);
    });

    child.on('close', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      const now = Date.now();
      if (now - this.lastFailureLog > 30_000) {
        this.lastFailureLog = now;
        console.error(
          `[encoder] ffmpeg exited (code=${code} signal=${signal}); ` +
            `respawning every ${RESPAWN_DELAY_MS}ms until the push succeeds. ` +
            `Last stderr: ${stderrTail.trim().split('\n').pop() ?? 'n/a'}`,
        );
      }
      this.respawnTimer = setTimeout(() => this.spawnChild(), RESPAWN_DELAY_MS);
    });
  }
}

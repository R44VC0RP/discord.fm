/**
 * Real-time PCM mixer.
 *
 * Discord hands us one decoded PCM stream *per speaker*. This mixer sums all
 * active speakers into a single continuous 48kHz stereo s16le stream, ticking
 * every 20ms. When nobody is talking it emits silence -- an Icecast source
 * must never stop sending data, otherwise every listener gets disconnected.
 */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 960 per channel
export const BYTES_PER_FRAME = SAMPLES_PER_FRAME * CHANNELS * 2; // 3840

/** Per-user cap: drop backlog beyond ~400ms so a stalled stream can't add latency. */
const MAX_BUFFERED_BYTES = BYTES_PER_FRAME * 20;
/** Start playing a user only once this much audio is queued (jitter buffer). */
const PREBUFFER_BYTES = BYTES_PER_FRAME * 2;
/** If the event loop stalled longer than this, resync instead of bursting frames. */
const MAX_CATCHUP_FRAMES = 15;

const SILENT_FRAME = Buffer.alloc(BYTES_PER_FRAME);

class UserStream {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private playing = false;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    // Latency guard: if a user's queue runs away, drop the oldest audio.
    while (this.buffered > MAX_BUFFERED_BYTES) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.buffered -= dropped.length;
    }
  }

  /** Returns exactly one frame of PCM, or null if this user is (still) silent. */
  readFrame(): Buffer | null {
    if (!this.playing) {
      if (this.buffered < PREBUFFER_BYTES) return null;
      this.playing = true;
    }
    if (this.buffered < BYTES_PER_FRAME) {
      // Ran dry: go back to buffering until the next burst arrives.
      this.playing = false;
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
    return frame;
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}

export interface MusicFrameSource {
  readFrame(): Buffer | null;
}

/** A finite, controller-owned source on the automation bus. */
export interface ProgramFrameSource extends MusicFrameSource {
  /** True only after the decoder has drained; an underrun is not a finish. */
  readonly finished?: boolean;
}

interface Pop {
  amp: number;
  decay: number;
  /** Noise bursts sound like record surface scratches; plain pops are clicks. */
  noise: boolean;
}

/**
 * Procedural vinyl/AM crackle, gated by voice activity. Sparse impulses with
 * exponential decay (clicks) plus occasional short noise bursts (scratches).
 * Returns mono frames; the mixer overlays them onto both channels while
 * anyone is speaking, so the crackle sits on the voices, not the music bed.
 */
class CrackleGenerator {
  private level = 0;
  private density = 0;
  private envelope = 0;
  private pops: Pop[] = [];
  private readonly buf = new Int16Array(SAMPLES_PER_FRAME);

  configure(level: number, density: number): void {
    this.level = Math.max(0, level);
    this.density = Math.max(0, density);
  }

  get enabled(): boolean {
    return this.level > 0 && this.density > 0;
  }

  /** One mono frame of crackle, or null when fully idle. */
  frame(voiceActive: boolean): Int16Array | null {
    if (!this.enabled) return null;

    // Attack ~100ms, release ~600ms so the dust tails off after speech.
    const target = voiceActive ? 1 : 0;
    if (this.envelope < target) this.envelope = Math.min(target, this.envelope + FRAME_MS / 100);
    else if (this.envelope > target) this.envelope = Math.max(target, this.envelope - FRAME_MS / 600);

    // Spawn new pops (Poisson-ish) while the gate is open.
    const spawns: { pos: number; pop: Pop }[] = [];
    if (this.envelope > 0.02 && this.pops.length < 24) {
      let budget = this.density * (FRAME_MS / 1000);
      while (budget > 0) {
        if (Math.random() < budget) {
          const noise = Math.random() < 0.18;
          spawns.push({
            pos: Math.floor(Math.random() * SAMPLES_PER_FRAME),
            pop: {
              amp:
                (0.25 + Math.random() * 0.75) * 11000 * this.level * this.envelope *
                (Math.random() < 0.5 ? -1 : 1),
              decay: noise ? 0.985 : 0.82 + Math.random() * 0.12,
              noise,
            },
          });
        }
        budget -= 1;
      }
    }
    if (spawns.length === 0 && this.pops.length === 0) return null;

    spawns.sort((a, b) => a.pos - b.pos);
    this.buf.fill(0);
    let next = 0;
    for (let s = 0; s < SAMPLES_PER_FRAME; s += 1) {
      while (next < spawns.length && spawns[next]!.pos === s) {
        this.pops.push(spawns[next]!.pop);
        next += 1;
      }
      if (this.pops.length === 0) continue;
      let value = 0;
      for (const pop of this.pops) {
        value += pop.noise ? pop.amp * (Math.random() * 2 - 1) : pop.amp;
        pop.amp *= pop.decay;
      }
      if (value > 32767) value = 32767;
      else if (value < -32768) value = -32768;
      this.buf[s] = value;
      if (s % 64 === 0) this.pops = this.pops.filter((pop) => Math.abs(pop.amp) > 40);
    }
    this.pops = this.pops.filter((pop) => Math.abs(pop.amp) > 40);
    return this.buf;
  }
}

export interface MusicOptions {
  /** Level when the channel is empty, 0..1. */
  baseGain: number;
  /** Level while humans are present, 0..1. */
  duckGain: number;
  /** Per-frame gain delta while fading down (duck). */
  stepDown: number;
  /** Per-frame gain delta while fading up. */
  stepUp: number;
}

export class Mixer {
  private readonly users = new Map<string, UserStream>();
  private sink: ((frame: Buffer) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private epoch = 0;
  private framesSent = 0;
  private music: { source: MusicFrameSource; opts: MusicOptions } | null = null;
  private musicGain = 0;
  private musicDucked = false;
  /** Rerun deck: plays at full gain; the music bed fades out underneath it. */
  private deck: MusicFrameSource | null = null;
  /** One-shot announcement (hourly time checks): speaks over ducked bed/deck. */
  private announcement: { buf: Buffer; offset: number } | null = null;
  onAnnouncementEnded?: () => void;
  private annDuck = 1;
  // This is deliberately separate from the legacy bed/deck/announcement
  // paths.  The playout controller supplies already-open finite sources; no
  // filesystem, network, or queue work is ever performed from writeFrame().
  private program: { source: ProgramFrameSource; speech: boolean } | null = null;
  private programNext: { source: ProgramFrameSource; speech: boolean } | null = null;
  private programFadeFrames = 0;
  private programFadeAt = 0;
  private programGain = 1;
  private programDucked = false;
  private programOpts: MusicOptions | null = null;
  /** Lets the controller settle a source retired at a crossfade boundary. */
  onProgramRetired?: (source: ProgramFrameSource) => void;
  /** Incoming sources can fail/finish before their crossfade promotion. */
  onProgramIncomingEnded?: (source: ProgramFrameSource) => void;
  /** The active source drained and was detached without a successor. */
  onProgramEnded?: (source: ProgramFrameSource) => void;
  private readonly crackle = new CrackleGenerator();

  setSink(sink: (frame: Buffer) => void): void {
    this.sink = sink;
  }

  /** Voice-gated crackle overlay. level 0 disables. */
  setCrackle(level: number, density: number): void {
    this.crackle.configure(level, density);
  }

  attachMusic(source: MusicFrameSource, opts: MusicOptions): void {
    this.music = { source, opts };
    this.musicGain = this.musicDucked ? opts.duckGain : opts.baseGain;
  }

  /** Duck the music bed while humans are in the channel. */
  setDucked(ducked: boolean): void {
    this.musicDucked = ducked;
  }

  /** Configure the single live-presence envelope for all automation output. */
  configureAutomation(opts: MusicOptions): void {
    this.programOpts = opts;
  }

  setAutomationDucked(ducked: boolean): void {
    this.programDucked = ducked;
  }

  /** Attach only into an empty automation slot; callers must not replace audio. */
  setProgramSource(source: ProgramFrameSource | null, speech = false): boolean {
    if (source && this.program) return false;
    this.program = source ? { source, speech } : null;
    // A cue attached while people are already live must begin at the live
    // target, not emit one full-volume frame before the 1.2s envelope runs.
    if (source) this.programGain = this.programDucked && this.programOpts ? this.programOpts.duckGain : 1;
    if (!source) {
      this.programNext = null;
      this.programFadeFrames = 0;
      this.programFadeAt = 0;
    }
    return true;
  }

  /** Preflight used by the controller before it acknowledges a cue start. */
  canAttachProgram(crossfade: boolean, speech = false): boolean {
    return crossfade
      ? Boolean(this.program && !this.programNext && !speech && !this.program.speech)
      : this.program === null;
  }

  /** Start an equal-power music transition. Both decoders keep advancing. */
  crossfadeProgramSource(source: ProgramFrameSource, durationMs: number, speech = false): boolean {
    if (!this.program || this.programNext || speech || this.program.speech) return false;
    this.programNext = { source, speech };
    this.programFadeFrames = Math.max(1, Math.round(durationMs / FRAME_MS));
    this.programFadeAt = 0;
    return true;
  }

  get automationActive(): boolean {
    return this.program !== null;
  }

  setDeckSource(source: MusicFrameSource | null): void {
    this.deck = source;
  }

  /** Queue a one-shot spoken announcement (48kHz stereo s16le PCM). */
  playAnnouncement(pcm: Buffer): void {
    if (pcm.length >= BYTES_PER_FRAME) this.announcement = { buf: pcm, offset: 0 };
  }

  /** Collision-safe form used by the station-level hourly overlay. */
  tryPlayAnnouncement(pcm: Buffer): boolean {
    if (this.announcement || pcm.length < BYTES_PER_FRAME) return false;
    this.announcement = { buf: pcm, offset: 0 }; return true;
  }

  get announcing(): boolean {
    return this.announcement !== null;
  }

  get musicState(): 'off' | 'playing' | 'ducked' | 'silenced' {
    if (!this.music) return 'off';
    if (this.deck) return 'silenced';
    return this.musicDucked ? 'ducked' : 'playing';
  }

  pushUser(userId: string, pcm: Buffer): void {
    let stream = this.users.get(userId);
    if (!stream) {
      stream = new UserStream();
      this.users.set(userId, stream);
    }
    stream.push(pcm);
  }

  removeUser(userId: string): void {
    this.users.delete(userId);
  }

  reset(): void {
    this.users.clear();
  }

  get activeSpeakers(): number {
    let count = 0;
    for (const user of this.users.values()) if (user.isPlaying) count += 1;
    return count;
  }

  start(): void {
    if (this.timer) return;
    this.epoch = performance.now();
    this.framesSent = 0;
    // Tick faster than the frame rate; each tick writes however many frames are due.
    this.timer = setInterval(() => this.tick(), FRAME_MS / 4);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const due = Math.floor((performance.now() - this.epoch) / FRAME_MS);
    if (due - this.framesSent > MAX_CATCHUP_FRAMES) {
      // Event loop stall (GC, reconnect, laptop sleep): skip ahead instead of
      // flooding ffmpeg with a burst of stale frames.
      this.framesSent = due - 1;
    }
    while (this.framesSent < due) {
      this.writeFrame();
      this.framesSent += 1;
    }
  }

  private writeFrame(): void {
    const frames: Buffer[] = [];
    for (const user of this.users.values()) {
      const frame = user.readFrame();
      if (frame) frames.push(frame);
    }

    // Announcement frame (one-shot, consumed frame by frame).
    let annFrame: Buffer | null = null;
    if (this.announcement) {
      const { buf, offset } = this.announcement;
      const end = Math.min(offset + BYTES_PER_FRAME, buf.length);
      if (end - offset === BYTES_PER_FRAME) {
        annFrame = buf.subarray(offset, end);
      } else {
        annFrame = Buffer.alloc(BYTES_PER_FRAME);
        buf.copy(annFrame, 0, offset, end);
      }
      this.announcement.offset = end;
      if (end >= buf.length) {
        this.announcement = null;
        const ended = this.onAnnouncementEnded; this.onAnnouncementEnded = undefined;
        queueMicrotask(() => ended?.());
      }
    }

    // While announcing, legacy reruns and non-speech automation program audio
    // share one smoothed underlay envelope. The automation master gain remains
    // independent, so a human joining during an ident composes the live duck
    // with this 20% speech underlay while every decoder keeps advancing.
    const annTarget = annFrame ? 0.2 : 1;
    if (this.annDuck > annTarget) this.annDuck = Math.max(annTarget, this.annDuck - 0.06);
    else if (this.annDuck < annTarget) this.annDuck = Math.min(annTarget, this.annDuck + 0.06);

    // Advance the music gain envelope every frame, even during underruns,
    // so fades keep moving at a constant rate. A live rerun deck forces the
    // bed to zero (recordings carry their own bed); announcements duck it.
    let musicFrame: Buffer | null = null;
    if (this.music) {
      const { opts, source } = this.music;
      const target = this.deck || this.program
        ? 0
        : this.musicDucked || this.announcement || annFrame
          ? opts.duckGain
          : opts.baseGain;
      if (this.musicGain > target) {
        this.musicGain = Math.max(target, this.musicGain - opts.stepDown);
      } else if (this.musicGain < target) {
        this.musicGain = Math.min(target, this.musicGain + opts.stepUp);
      }
      musicFrame = source.readFrame();
    }

    const deckFrame = this.deck ? this.deck.readFrame() : null;
    let programFrame: Buffer | null = null;
    let incomingFrame: Buffer | null = null;
    let programOutGain = 0;
    let programInGain = 0;
    let programSpeech = false;
    if (this.program) {
      const activeProgramSpeech = this.program.speech;
      const incomingProgramSpeech = this.programNext?.speech ?? false;
      const opts = this.programOpts;
      const target = this.programDucked && opts ? opts.duckGain : 1;
      const down = opts?.stepDown ?? 1;
      const up = opts?.stepUp ?? 1;
      if (this.programGain > target) this.programGain = Math.max(target, this.programGain - down);
      else if (this.programGain < target) this.programGain = Math.min(target, this.programGain + up);

      programFrame = this.program.source.readFrame();
      programSpeech = this.program.speech;
      if (this.programNext) {
        incomingFrame = this.programNext.source.readFrame();
        if (this.programNext.source.finished) {
          // Never promote a drained incoming deck: leave the current program
          // full-level and let the controller settle the failed/short cue.
          const drained = this.programNext.source;
          this.programNext = null; this.programFadeAt = 0; this.programFadeFrames = 0;
          incomingFrame = null; programOutGain = this.programGain;
          queueMicrotask(() => this.onProgramIncomingEnded?.(drained));
        } else {
          // Include both endpoints: the frame promoted to the incoming deck is
          // already at its exact steady gain, avoiding a one-frame step.
          const ratio = Math.min(1, (this.programFadeAt + 1) / this.programFadeFrames);
          // Equal-power prevents the -6dB hole of a linear two-source fade.
          programOutGain = Math.cos((Math.PI / 2) * ratio) * this.programGain;
          programInGain = Math.sin((Math.PI / 2) * ratio) * this.programGain;
          this.programFadeAt += 1;
        }
        if (this.programNext && (this.programFadeAt >= this.programFadeFrames || this.program.source.finished)) {
          const retired = this.program.source;
          this.program = this.programNext;
          this.programNext = null;
          this.programFadeAt = 0;
          this.programFadeFrames = 0;
          queueMicrotask(() => this.onProgramRetired?.(retired));
        }
      } else {
        programOutGain = this.programGain;
      }
      // Station overlays are blocked while automation spoken/hotline cues are
      // current or pending. Keep this type guard anyway: if a caller forces an
      // announcement through the low-level mixer API, speech is never attenuated
      // a second time. Music/rerun frames get the same underlay as legacy decks.
      if (!activeProgramSpeech) programOutGain *= this.annDuck;
      if (!incomingProgramSpeech) programInGain *= this.annDuck;
      // Mixer slot transitions are the sole owner of normal completion
      // notification. This fires on the same frame that detaches the source,
      // so decoder completion never depends on one more readFrame() call.
      if (this.program?.source.finished && !this.programNext) {
        const ended = this.program.source;
        this.program = null;
        queueMicrotask(() => this.onProgramEnded?.(ended));
      }
    }
    // The announcement voice earns crackle just like live speakers.
    const crackleFrame = this.crackle.frame(frames.length > 0 || annFrame !== null || programSpeech);

    let out: Buffer;
    if (frames.length === 0 && !musicFrame && !deckFrame && !annFrame && !programFrame && !incomingFrame) {
      out = SILENT_FRAME;
    } else if (frames.length === 1 && !musicFrame && !deckFrame && !annFrame && !programFrame && !incomingFrame) {
      out = frames[0]!;
    } else {
      const mixed = Buffer.allocUnsafe(BYTES_PER_FRAME);
      const gain = this.musicGain;
      const deckGain = this.annDuck;
      for (let i = 0; i < BYTES_PER_FRAME; i += 2) {
        let sum = 0;
        for (const frame of frames) sum += frame.readInt16LE(i);
        if (musicFrame) sum += Math.round(musicFrame.readInt16LE(i) * gain);
        if (deckFrame) sum += Math.round(deckFrame.readInt16LE(i) * deckGain);
        if (programFrame) sum += Math.round(programFrame.readInt16LE(i) * programOutGain);
        if (incomingFrame) sum += Math.round(incomingFrame.readInt16LE(i) * programInGain);
        if (annFrame) sum += annFrame.readInt16LE(i);
        // Mono crackle onto both channels: sample index i/2, mono index i/4.
        if (crackleFrame) sum += crackleFrame[(i >> 2)]!;
        if (sum > 32767) sum = 32767;
        else if (sum < -32768) sum = -32768;
        mixed.writeInt16LE(sum, i);
      }
      out = mixed;
    }

    this.sink?.(out);
  }
}

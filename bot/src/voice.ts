/**
 * Voice channel membership + per-speaker receive pipeline.
 *
 * Discord delivers one encrypted Opus stream per speaker. For each user that
 * starts talking we subscribe, decode Opus -> 48kHz stereo PCM, and feed the
 * mixer. Subscriptions end after ~1s of silence and are recreated on the next
 * "speaking" event.
 *
 * DAVE (E2EE) is mandatory on regular voice channels since March 2026;
 * @discordjs/voice negotiates it automatically because @snazzah/davey is
 * installed. No extra code needed here.
 */

import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import type { Mixer } from './mixer.js';

/** Opus silence frame; sending a few unlocks inbound audio on some routes. */
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const REJOIN_DELAY_MS = 5000;

interface Subscription {
  destroy(): void;
}

export class RadioVoice {
  private connection: VoiceConnection | null = null;
  private channel: VoiceBasedChannel | null = null;
  private readonly subscriptions = new Map<string, Subscription>();
  private rejoinTimer: NodeJS.Timeout | null = null;
  private leaving = false;

  /** Invoked after joining/leaving a channel so occupancy-driven state can sync. */
  onPresenceChange?: () => void;

  constructor(
    private readonly client: Client,
    private readonly mixer: Mixer,
  ) {}

  get connectedChannel(): VoiceBasedChannel | null {
    return this.connection ? this.channel : null;
  }

  get speakerCount(): number {
    return this.subscriptions.size;
  }

  /** Users the bot is currently receiving audio from (spoke within ~1s). */
  get speakingUserIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    this.leaving = false;
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;

    if (this.connection && this.channel?.id !== channel.id) this.teardown();
    this.channel = channel;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      // Must not be deafened, or Discord will not send us audio.
      selfDeaf: false,
      selfMute: false,
    });
    this.connection = connection;

    connection.on('error', (error) => {
      console.error('[voice] connection error:', error.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.leaving) return;
      try {
        // Might be a channel move or region switch; give it 5s to recover.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        console.warn('[voice] disconnected; rejoining shortly');
        this.teardown();
        this.scheduleRejoin();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      this.teardown();
      throw new Error(
        `timed out joining #${channel.name} -- check Connect permission and that ` +
          `@snazzah/davey is installed (DAVE/E2EE is required on voice channels). ` +
          `${error instanceof Error ? error.message : ''}`,
      );
    }

    // Nudge the receive path open.
    for (let i = 0; i < 5; i += 1) connection.playOpusPacket(SILENCE_FRAME);

    connection.receiver.speaking.on('start', (userId) => this.subscribeUser(userId));
    console.log(`[voice] live in #${channel.name} (${channel.guild.name})`);
    this.onPresenceChange?.();
  }

  leave(): void {
    this.leaving = true;
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    this.teardown();
    this.channel = null;
    this.onPresenceChange?.();
  }

  private scheduleRejoin(): void {
    if (this.rejoinTimer || this.leaving || !this.channel) return;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      const channel = this.channel;
      if (!channel) return;
      this.join(channel).catch((error: unknown) => {
        console.error('[voice] rejoin failed:', error instanceof Error ? error.message : error);
        this.scheduleRejoin();
      });
    }, REJOIN_DELAY_MS);
  }

  private subscribeUser(userId: string): void {
    if (!this.connection) return;
    if (userId === this.client.user?.id) return;
    if (this.subscriptions.has(userId)) return;

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    decoder.on('data', (pcm: Buffer) => this.mixer.pushUser(userId, pcm));

    const cleanup = () => {
      if (!this.subscriptions.delete(userId)) return;
      opusStream.destroy();
      decoder.destroy();
    };

    opusStream.once('end', cleanup);
    opusStream.on('error', (error) => {
      console.warn(`[voice] receive stream error for ${userId}:`, error.message);
      cleanup();
    });
    decoder.on('error', (error) => {
      console.warn(`[voice] opus decode error for ${userId}:`, error.message);
      cleanup();
    });

    opusStream.pipe(decoder);
    this.subscriptions.set(userId, { destroy: cleanup });
  }

  private teardown(): void {
    for (const subscription of [...this.subscriptions.values()]) subscription.destroy();
    this.subscriptions.clear();
    this.mixer.reset();
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        // Already destroyed.
      }
      this.connection = null;
    }
  }
}

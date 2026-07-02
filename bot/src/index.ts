import { existsSync } from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { handleRadioCommand, radioCommand } from './commands.js';
import { config } from './config.js';
import { Encoder } from './encoder.js';
import { ActivityFeed, type PresenceSnapshot } from './feed.js';
import { FRAME_MS, Mixer } from './mixer.js';
import { MusicSource } from './music.js';
import { RadioVoice } from './voice.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const mixer = new Mixer();
const encoder = new Encoder();
const radio = new RadioVoice(client, mixer);
const feed = new ActivityFeed(config.feed.dir, {
  station: config.station.name,
  link: config.feed.link,
  maxItems: config.feed.maxItems,
});

// The station runs 24/7: encoder + mixer start immediately, so the mount is
// live (music + AM static) even before the bot joins a voice channel.
mixer.setSink((frame) => encoder.write(frame));
mixer.setCrackle(config.radio.crackle.level, config.radio.crackle.density);
encoder.start();
mixer.start();

// Looping background-music bed; ducks while humans are in the channel.
let music: MusicSource | null = null;
if (config.music.file) {
  if (existsSync(config.music.file)) {
    music = new MusicSource(config.music.file);
    music.start();
    mixer.attachMusic(music, {
      baseGain: config.music.gain,
      duckGain: config.music.duckGain,
      stepDown: FRAME_MS / Math.max(config.music.fadeDownMs, FRAME_MS),
      stepUp: FRAME_MS / Math.max(config.music.fadeUpMs, FRAME_MS),
    });
    console.log(`[music] bed active: ${config.music.file}`);
  } else {
    console.warn(`[music] file not found, running without music: ${config.music.file}`);
  }
}

function currentSnapshot(): PresenceSnapshot {
  const channel = radio.connectedChannel;
  const members = channel
    ? [...channel.members.values()].filter((member) => member.id !== client.user?.id)
    : [];
  return {
    live: channel !== null,
    humans: members.filter((member) => !member.user.bot).length,
    members: members.map((member) => member.displayName),
  };
}

/** Recompute occupancy: duck/unduck music and refresh the public feed. */
function syncPresence(): PresenceSnapshot {
  const snapshot = currentSnapshot();
  mixer.setDucked(snapshot.humans > 0);
  void feed.update(snapshot);
  return snapshot;
}

radio.onPresenceChange = () => void syncPresence();

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[bot] logged in as ${readyClient.user.tag}`);
  await feed.init();

  try {
    await readyClient.application.commands.set([radioCommand.toJSON()], config.discord.guildId);
    console.log('[bot] slash commands registered');
  } catch (error) {
    console.error('[bot] failed to register commands:', error);
  }

  if (config.discord.voiceChannelId) {
    try {
      const channel = await readyClient.channels.fetch(config.discord.voiceChannelId);
      if (channel?.isVoiceBased()) {
        await radio.join(channel);
      } else {
        console.error('[bot] DISCORD_VOICE_CHANNEL_ID is not a voice channel');
      }
    } catch (error) {
      console.error(
        '[bot] auto-join failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'radio') return;
  try {
    await handleRadioCommand(interaction, radio, mixer, encoder);
  } catch (error) {
    console.error('[bot] command error:', error);
  }
});

client.on(Events.Error, (error) => {
  console.error('[bot] client error:', error);
});

// Join/leave monitoring: logs, music ducking, and the public activity feed.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const channel = radio.connectedChannel;
  if (!channel) return;
  const member = newState.member ?? oldState.member;
  if (!member) return;
  if (member.id === client.user?.id) {
    syncPresence();
    return;
  }
  const joined = newState.channelId === channel.id && oldState.channelId !== channel.id;
  const left = oldState.channelId === channel.id && newState.channelId !== channel.id;
  if (!joined && !left) return;
  const snapshot = syncPresence();
  console.log(
    `[monitor] ${member.displayName}${member.user.bot ? ' [bot]' : ''} ${joined ? 'joined' : 'left'} ` +
      `#${channel.name} (${snapshot.humans} human${snapshot.humans === 1 ? '' : 's'} in channel)`,
  );
  void feed.record(member.displayName, joined ? 'joined' : 'left', snapshot);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[bot] ${signal} received, shutting down`);
  radio.leave();
  mixer.stop();
  music?.stop();
  encoder.stop();
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void client.login(config.discord.token);

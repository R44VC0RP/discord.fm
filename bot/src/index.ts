import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { Announcer, decodeToPcm } from './announcer.js';
import { startApi } from './api.js';
import { ArchiveCaster } from './archivecast.js';
import { AudienceLog } from './audience.js';
import { CLIP_MAX_S, ClipBuffer } from './clip.js';
import {
  clipCommand,
  handleClipCommand,
  handleHotlineCommand,
  handleRadioCommand,
  hotlineCommand,
  radioCommand,
} from './commands.js';
import { config } from './config.js';
import { Encoder } from './encoder.js';
import { ActivityFeed, type PresenceSnapshot } from './feed.js';
import { hotlineLabel, listInbox } from './hotline.js';
import { fetchAllListeners } from './listeners.js';
import { FRAME_MS, Mixer } from './mixer.js';
import { MusicSource } from './music.js';
import { RerunManager } from './rerun.js';
import { startSkinRotation } from './skins.js';
import { RadioVoice } from './voice.js';
import { YouTubeChatBridge } from './ytchat.js';

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

// /clip rolling tape: the encoder tees the aired mp3 back into memory.
const clipBuffer = new ClipBuffer(config.radio.bitrate, CLIP_MAX_S);
encoder.onMp3 = (chunk) => clipBuffer.push(chunk);

encoder.start();
mixer.start();

// Looping background-music bed; ducks while humans are in the channel.
// The active track is hot-swappable via the control API and persisted so
// restarts keep the admin's selection.
const musicOpts = () => ({
  baseGain: config.music.gain,
  duckGain: config.music.duckGain,
  stepDown: FRAME_MS / Math.max(config.music.fadeDownMs, FRAME_MS),
  stepUp: FRAME_MS / Math.max(config.music.fadeUpMs, FRAME_MS),
});
const trackStateFile = config.feed.dir ? join(config.feed.dir, 'music-track.txt') : '';
let music: MusicSource | null = null;
let activeTrack = config.music.file;
try {
  if (trackStateFile && existsSync(trackStateFile)) {
    const saved = readFileSync(trackStateFile, 'utf8').trim();
    if (saved && existsSync(saved)) activeTrack = saved;
  }
} catch {
  // fall back to the configured track
}
if (activeTrack && existsSync(activeTrack)) {
  music = new MusicSource(activeTrack);
  music.start();
  mixer.attachMusic(music, musicOpts());
  console.log(`[music] bed active: ${activeTrack}`);
} else if (activeTrack) {
  console.warn(`[music] file not found, running without music: ${activeTrack}`);
}

async function setMusicTrack(fileName: string): Promise<void> {
  const path = join(config.music.dir, basename(fileName));
  if (!existsSync(path)) throw new Error(`no such track: ${basename(fileName)}`);
  music?.stop();
  music = new MusicSource(path);
  music.start();
  mixer.attachMusic(music, musicOpts());
  activeTrack = path;
  if (trackStateFile) await writeFile(trackStateFile, `${path}\n`, 'utf8');
  console.log(`[music] track -> ${path}`);
}

// Rerun engine: replays session recordings while the channel is empty,
// paced (post-live wait, gaps, oldest-first full rotation before repeats).
const rerun = new RerunManager(mixer, config.rerun.recordingsDir, {
  auto: config.rerun.auto,
  afterLiveMs: config.rerun.afterLiveMin * 60_000,
  gapMs: config.rerun.gapMin * 60_000,
  stateFile: config.feed.dir ? join(config.feed.dir, 'rerun-state.json') : '',
  timeZone: config.station.timeZone,
});

function currentSnapshot(): PresenceSnapshot {
  const channel = radio.connectedChannel;
  const members = channel
    ? [...channel.members.values()].filter((member) => member.id !== client.user?.id)
    : [];
  return {
    live: channel !== null,
    humans: members.filter((member) => !member.user.bot).length,
    members: members.map((member) => member.displayName),
    memberIds: members.map((member) => member.id),
    rerun: rerun.nowPlayingLabel,
  };
}

// --- voice channel status (the small text under the channel name) ---
// Shows the station mode + combined listener count. Semi-documented
// endpoint: PUT /channels/{id}/voice-status. Only PUTs when text changes.
let lastVoiceStatus = '';
let voiceStatusWarned = false;
async function updateVoiceStatus(): Promise<void> {
  const channel = radio.connectedChannel;
  if (!channel) return;
  const snapshot = currentSnapshot();
  const listeners = await fetchAllListeners().catch(() => null);
  const count = listeners && listeners.total !== null ? ` — ${listeners.total} listening` : '';
  let text: string;
  if (snapshot.humans > 0) text = `🔴 ON AIR${count}`;
  else if (snapshot.rerun) text = `📼 RERUN ${snapshot.rerun}${count}`;
  else if (snapshot.live) text = `🎶 music through the static${count}`;
  else text = '📡 off air — static';
  text = text.slice(0, 450);
  if (text === lastVoiceStatus) return;
  try {
    await client.rest.put(`/channels/${channel.id}/voice-status`, { body: { status: text } });
    lastVoiceStatus = text;
  } catch (error) {
    if (!voiceStatusWarned) {
      voiceStatusWarned = true;
      console.warn(
        '[status] voice channel status update failed (permission?):',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
setInterval(() => void updateVoiceStatus(), 120_000);

/** Recompute occupancy: duck music, drive reruns, refresh the public feed. */
function syncPresence(): PresenceSnapshot {
  const snapshot = currentSnapshot();
  mixer.setDucked(snapshot.humans > 0);
  rerun.onPresence(snapshot.humans);
  void feed.update(snapshot);
  void updateVoiceStatus();
  return snapshot;
}

radio.onPresenceChange = () => void syncPresence();
rerun.onChange = () => {
  void feed.update(currentSnapshot());
  void updateVoiceStatus();
};

// Daily homepage skin rotation (deterministic per station-timezone day).
if (config.web.dir && existsSync(config.web.dir)) {
  startSkinRotation(config.web.dir, config.station.timeZone);
}

// Hourly time checks (only while nobody is live; manual fire via the API).
let announcer: Announcer | null = null;
if (config.announcer.elevenLabsKey && config.announcer.voiceId) {
  announcer = new Announcer({ mixer, getSnapshot: currentSnapshot, getListeners: fetchAllListeners });
  announcer.start();
}

// Hotline voicemails: FIFO on-air queue. Each plays into the stream (via the
// announcement slot: bed/rerun duck, crackle applies) AND into the Discord
// channel so live hosts hear the caller and can react.
const voicemailQueue: string[] = [];
let voicemailBusy = false;
function queueVoicemail(fileName: string): number {
  voicemailQueue.push(basename(fileName));
  return voicemailQueue.length;
}
/** Posts the "new hotline message" notice into the voice channel's chat. */
async function announceVoicemail(fileName: string): Promise<void> {
  const channel = radio.connectedChannel;
  if (!channel) return;
  const inbox = await listInbox();
  const index = inbox.findIndex((item) => item.file === basename(fileName));
  const item = index >= 0 ? inbox[index]! : null;
  const n = index >= 0 ? index + 1 : 'N';
  const quote = item?.transcript ? `\n> 🗒️ “${item.transcript.slice(0, 600)}”` : '';
  await channel
    .send({
      content:
        `📞 New hotline message: ${item ? hotlineLabel(item) : basename(fileName)}${quote}\n` +
        `\`/hotline play ${n}\` preview here · \`/hotline air ${n}\` broadcast · \`/hotline list\` inbox`,
      allowedMentions: { parse: [] },
    })
    .catch((error: unknown) =>
      console.warn('[hotline] notify failed:', error instanceof Error ? error.message : error),
    );
}

setInterval(() => {
  if (voicemailBusy || voicemailQueue.length === 0 || mixer.announcing) return;
  voicemailBusy = true;
  const file = voicemailQueue.shift()!;
  void (async () => {
    try {
      const path = join(config.voicemail.dir, file);
      const pcm = await decodeToPcm(await readFile(path));
      mixer.playAnnouncement(pcm);
      radio.playFile(path);
      console.log(`[voicemail] on air: ${file} (~${Math.round(pcm.length / (48000 * 4))}s)`);
    } catch (error) {
      console.warn(`[voicemail] failed to play ${file}:`, error instanceof Error ? error.message : error);
    } finally {
      voicemailBusy = false;
    }
  })();
}, 1500);

// Hourly audience samples (web + youtube) for the control room chart.
const audience = new AudienceLog(config.feed.dir || '/tmp', fetchAllListeners, currentSnapshot);
if (config.feed.dir) void audience.start();

startApi({
  mixer,
  rerun,
  getSnapshot: currentSnapshot,
  getListeners: fetchAllListeners,
  getAudience: (hours) => audience.recent(hours),
  getMusicTrack: () => (activeTrack ? basename(activeTrack) : ''),
  setMusicTrack,
  queueVoicemail,
  getVoicemailQueue: () => [...voicemailQueue],
  voicemailReceived: announceVoicemail,
  announce: (force) =>
    announcer ? announcer.fire(force) : Promise.resolve({ fired: false, reason: 'announcer disabled (no keys)' }),
});

// Keep audience counts in status.json: web listeners (TV/recorder excluded)
// polled every 30s + YouTube concurrent viewers (cached 5m for quota).
setInterval(() => {
  void fetchAllListeners().then((breakdown) => feed.setListeners(breakdown));
}, 30_000);

// Periodic voice-session refresh: full reconnect while nobody is in the
// channel, so a long-lived connection never goes stale.
if (config.discord.voiceRefreshHours > 0) {
  setInterval(() => {
    if (currentSnapshot().humans === 0 && radio.connectedChannel) void radio.refresh();
  }, config.discord.voiceRefreshHours * 3_600_000);
}

// YouTube live chat -> the voice channel's text chat.
if (config.youtube.apiKey && config.youtube.videoId) {
  const bridge = new YouTubeChatBridge(
    config.youtube.apiKey,
    config.youtube.videoId,
    Math.max(config.youtube.chatPollS, 10) * 1000,
    (text) => {
      const channel = radio.connectedChannel;
      if (!channel) return;
      channel
        .send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } })
        .catch((error: unknown) =>
          console.warn('[ytchat] post failed:', error instanceof Error ? error.message : error),
        );
    },
  );
  bridge.start();
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[bot] logged in as ${readyClient.user.tag}`);
  await feed.init();

  // Finished sessions -> rendered mp4 -> posted to the archive channel.
  if (config.archive.postChannelId && config.feed.dir) {
    const caster = new ArchiveCaster(
      client,
      config.archive.postChannelId,
      config.rerun.recordingsDir,
      config.feed.dir,
    );
    void caster.start();
  }

  try {
    await readyClient.application.commands.set(
      [radioCommand.toJSON(), hotlineCommand.toJSON(), clipCommand.toJSON()],
      config.discord.guildId,
    );
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
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'radio') {
      await handleRadioCommand(interaction, radio, mixer, encoder);
    } else if (interaction.commandName === 'hotline') {
      await handleHotlineCommand(interaction, radio, queueVoicemail);
    } else if (interaction.commandName === 'clip') {
      await handleClipCommand(interaction, clipBuffer, currentSnapshot);
    }
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

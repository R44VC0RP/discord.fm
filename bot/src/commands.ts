import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { join } from 'node:path';
import { CLIP_MAX_S, CLIP_MIN_S, clipRenderBusy, renderClip, type ClipBuffer } from './clip.js';
import { config } from './config.js';
import type { Encoder } from './encoder.js';
import { onAirLine, type PresenceSnapshot } from './feed.js';
import { hotlineLabel, listInbox } from './hotline.js';
import type { Mixer } from './mixer.js';
import type { RadioVoice } from './voice.js';

export const radioCommand = new SlashCommandBuilder()
  .setName('radio')
  .setDescription(`Control the ${config.station.name} broadcast`)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('join')
      .setDescription('Join a voice channel and put it on air')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Voice channel (defaults to configured channel, then your current one)')
          .addChannelTypes(ChannelType.GuildVoice),
      ),
  )
  .addSubcommand((sub) => sub.setName('leave').setDescription('Take the channel off air (stream keeps playing static)'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Broadcast status'));

import { fetchAllListeners } from './listeners.js';

export const hotlineCommand = new SlashCommandBuilder()
  .setName('hotline')
  .setDescription(`${config.station.name} hotline inbox`)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName('list').setDescription('List hotline messages'))
  .addSubcommand((sub) =>
    sub
      .setName('play')
      .setDescription('Preview a message here in Discord (not on air)')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('message number from /hotline list').setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('air')
      .setDescription('Broadcast a message on the station')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('message number from /hotline list').setRequired(true).setMinValue(1),
      ),
  );

export const clipCommand = new SlashCommandBuilder()
  .setName('clip')
  .setDescription('Clip the last moments of the broadcast as a shareable video')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) =>
    o
      .setName('seconds')
      .setDescription(`How far back to clip, ${CLIP_MIN_S}-${CLIP_MAX_S} (default 30)`)
      .setMinValue(CLIP_MIN_S)
      .setMaxValue(CLIP_MAX_S),
  );

export async function handleClipCommand(
  interaction: ChatInputCommandInteraction,
  clipBuffer: ClipBuffer,
  getSnapshot: () => PresenceSnapshot,
): Promise<void> {
  if (clipRenderBusy()) {
    await interaction.reply({
      content: '📼 the tape deck is busy with another clip — try again in a few seconds',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requested = interaction.options.getInteger('seconds') ?? 30;
  const buffered = Math.floor(clipBuffer.bufferedSeconds());
  if (buffered < CLIP_MIN_S) {
    await interaction.reply({
      content: `📼 the tape is still warming up (${buffered}s buffered) — try again shortly`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const seconds = Math.min(requested, buffered);

  await interaction.deferReply();

  const when = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: config.station.timeZone,
  }).format(new Date());
  const label = `${when} ET — ${onAirLine(getSnapshot())}`;

  try {
    const mp3 = clipBuffer.lastSeconds(seconds);
    const clip = await renderClip(mp3, seconds, label);
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      const short = requested > seconds ? ` (only ${seconds}s on tape)` : '';
      await interaction.editReply({
        content: `📼 the last **${seconds}s** of ${config.station.name}${short} — call in: (361) 266-6259`,
        files: [{ attachment: clip.path, name: `anomalyfm-clip-${stamp}-${seconds}s.mp4` }],
      });
    } finally {
      await clip.cleanup();
    }
  } catch (error) {
    console.error('[clip] failed:', error);
    await interaction
      .editReply(`📼 clip failed: ${error instanceof Error ? error.message : String(error)}`)
      .catch(() => {});
  }
}

export async function handleHotlineCommand(
  interaction: ChatInputCommandInteraction,
  radio: RadioVoice,
  queueVoicemail: (file: string) => number,
  automationOwnsSpoken = false,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const inbox = await listInbox();

  if (sub === 'list') {
    if (inbox.length === 0) {
      await interaction.reply('hotline inbox is empty — call (361) 266-6259');
      return;
    }
    const lines = inbox.slice(0, 10).map((item, i) => {
      const quote = item.transcript ? `\n> 🗒️ ${item.transcript.slice(0, 140)}${item.transcript.length > 140 ? '…' : ''}` : '';
      return `**${i + 1}.** ${hotlineLabel(item)}${quote}`;
    });
    if (inbox.length > 10) lines.push(`…and ${inbox.length - 10} more in the control room`);
    lines.push('`/hotline play N` preview here (not on air) · `/hotline air N` broadcast');
    await interaction.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    return;
  }

  const n = interaction.options.getInteger('number', true);
  if (n < 1 || n > inbox.length) {
    await interaction.reply({
      content: inbox.length ? `pick 1–${inbox.length} (see \`/hotline list\`)` : 'inbox is empty',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const item = inbox[n - 1]!;

  if (sub === 'play') {
    radio.playFile(join(config.voicemail.dir, item.file));
    await interaction.reply({
      content: `▶️ previewing **${n}.** ${hotlineLabel(item)} — Discord only, not on air`,
      allowedMentions: { parse: [] },
    });
  } else if (sub === 'air') {
    if (automationOwnsSpoken) {
      await interaction.reply({ content: '📡 automation playout owns on-air hotline calls; queue this call through the control room automation queue.', flags: MessageFlags.Ephemeral });
      return;
    }
    const position = queueVoicemail(item.file);
    await interaction.reply({
      content: `📡 queued on air (#${position}): ${hotlineLabel(item)}`,
      allowedMentions: { parse: [] },
    });
  }
}

export async function handleRadioCommand(
  interaction: ChatInputCommandInteraction,
  radio: RadioVoice,
  mixer: Mixer,
  encoder: Encoder,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'join') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let channel: VoiceBasedChannel | null = null;
    const option = interaction.options.getChannel('channel');
    if (option && 'isVoiceBased' in option && option.isVoiceBased()) {
      channel = option;
    } else if (config.discord.voiceChannelId) {
      const fetched = await interaction.client.channels
        .fetch(config.discord.voiceChannelId)
        .catch(() => null);
      if (fetched?.isVoiceBased()) channel = fetched;
    }
    if (!channel && interaction.inCachedGuild()) {
      channel = interaction.member.voice.channel;
    }

    if (!channel) {
      await interaction.editReply(
        'No channel to join. Pass one, set `DISCORD_VOICE_CHANNEL_ID`, or hop into a voice channel first.',
      );
      return;
    }

    try {
      await radio.join(channel);
      await interaction.editReply(`On air from ${channel}. Stream mount: \`${config.icecast.mount}\``);
    } catch (error) {
      await interaction.editReply(
        `Failed to join: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }

  if (subcommand === 'leave') {
    radio.leave();
    await interaction.reply({
      content: 'Off air. The stream is still up and broadcasting static.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'status') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const listeners = await fetchAllListeners();
    const channel = radio.connectedChannel;
    const lines = [
      `station: **${config.station.name}** (\`${config.radio.preset}\` preset @ ${config.radio.bitrate})`,
      `voice: ${channel ? `live in ${channel}` : 'not connected (broadcasting the bed)'}`,
      `music: ${mixer.musicState}`,
      `encoder: ${encoder.running ? 'running' : 'down (respawning)'}`,
      `listeners: ${listeners.total ?? 'unknown'} (web ${listeners.web ?? '?'}, youtube ${listeners.youtube ?? '–'})`,
    ];
    if (channel) {
      const speaking = new Set(radio.speakingUserIds);
      const members = [...channel.members.values()].filter(
        (member) => member.id !== interaction.client.user.id,
      );
      lines.push(`in channel (${members.length}):`);
      lines.push(
        members.length
          ? members
              .map((member) => {
                const tags = [
                  member.user.bot ? '[bot]' : '',
                  speaking.has(member.id) ? '<- on air' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return `- ${member.displayName}${tags ? ` ${tags}` : ''}`;
              })
              .join('\n')
          : '(empty)',
      );
    }
    await interaction.editReply(lines.join('\n'));
  }
}

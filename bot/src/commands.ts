import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { config } from './config.js';
import type { Encoder } from './encoder.js';
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

interface IcecastSource {
  listenurl?: string;
  listeners?: number;
}

async function fetchListeners(): Promise<number | null> {
  try {
    const response = await fetch(
      `http://${config.icecast.host}:${config.icecast.port}/status-json.xsl`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!response.ok) return null;
    const stats = (await response.json()) as { icestats?: { source?: IcecastSource | IcecastSource[] } };
    const source = stats.icestats?.source;
    if (!source) return 0;
    const sources = Array.isArray(source) ? source : [source];
    const mount = config.icecast.mount.startsWith('/') ? config.icecast.mount : `/${config.icecast.mount}`;
    const match = sources.find((entry) => entry.listenurl?.endsWith(mount));
    return match?.listeners ?? 0;
  } catch {
    return null;
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
    const listeners = await fetchListeners();
    const channel = radio.connectedChannel;
    const lines = [
      `station: **${config.station.name}** (\`${config.radio.preset}\` preset @ ${config.radio.bitrate})`,
      `voice: ${channel ? `live in ${channel}` : 'not connected (broadcasting the bed)'}`,
      `music: ${mixer.musicState}`,
      `encoder: ${encoder.running ? 'running' : 'down (respawning)'}`,
      `listeners: ${listeners ?? 'unknown (icecast unreachable)'}`,
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

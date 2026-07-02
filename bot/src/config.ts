function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`[config] missing required env var: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const value = Number(optional(name, String(fallback)));
  if (!Number.isFinite(value)) {
    console.error(`[config] env var ${name} is not a number`);
    process.exit(1);
  }
  return value;
}

export type RadioPreset = 'am' | 'clean';

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    guildId: required('DISCORD_GUILD_ID'),
    /** Optional: auto-join this voice channel on boot. */
    voiceChannelId: optional('DISCORD_VOICE_CHANNEL_ID', ''),
  },
  station: {
    name: optional('STATION_NAME', 'anomaly.fm'),
    description: optional('STATION_DESCRIPTION', 'live from the anomaly'),
    genre: optional('STATION_GENRE', 'talk'),
  },
  radio: {
    preset: optional('RADIO_PRESET', 'am') as RadioPreset,
    bitrate: optional('RADIO_BITRATE', '96k'),
    am: {
      lowcutHz: optionalNumber('AM_LOWCUT_HZ', 300),
      highcutHz: optionalNumber('AM_HIGHCUT_HZ', 3800),
      /** Amplitude of the pink-noise static bed, 0..1. */
      noiseLevel: optionalNumber('AM_NOISE_LEVEL', 0.004),
      /** Slow carrier-fade (signal drift) rate in Hz. */
      flutterHz: optionalNumber('AM_FLUTTER_HZ', 0.3),
      /** Carrier-fade depth, 0..1. */
      flutterDepth: optionalNumber('AM_FLUTTER_DEPTH', 0.08),
    },
    /** Voice-gated crackle: dust/pops that ride on speech only. */
    crackle: {
      /** Overall crackle loudness, 0..1. 0 disables. */
      level: optionalNumber('CRACKLE_LEVEL', 0.3),
      /** Average pops per second while someone is talking. */
      density: optionalNumber('CRACKLE_DENSITY', 10),
    },
  },
  icecast: {
    host: optional('ICECAST_HOST', 'icecast'),
    port: optionalNumber('ICECAST_PORT', 8000),
    mount: optional('ICECAST_MOUNT', '/radio'),
    sourcePassword: required('ICECAST_SOURCE_PASSWORD'),
  },
  music: {
    /** Path to the looping background track inside the container. "off" disables. */
    file: offable(optional('MUSIC_FILE', '/music/background.mp3')),
    /** Music level when the channel is empty. */
    gain: optionalNumber('MUSIC_GAIN', 0.9),
    /** Music level while humans are in the channel. */
    duckGain: optionalNumber('MUSIC_DUCK_GAIN', 0.08),
    /** Fade time when someone joins (duck down). */
    fadeDownMs: optionalNumber('MUSIC_FADE_DOWN_MS', 1200),
    /** Fade time when the channel empties (back up). */
    fadeUpMs: optionalNumber('MUSIC_FADE_UP_MS', 3000),
  },
  feed: {
    /** Directory shared with icecast's webroot. "off" disables. */
    dir: offable(optional('FEED_DIR', '/feed')),
    maxItems: optionalNumber('FEED_MAX_ITEMS', 50),
    link: `https://${optional('STREAM_DOMAIN', 'localhost')}`,
  },
};

function offable(value: string): string {
  return value.toLowerCase() === 'off' ? '' : value;
}

if (config.radio.preset !== 'am' && config.radio.preset !== 'clean') {
  console.error(`[config] RADIO_PRESET must be "am" or "clean", got "${config.radio.preset}"`);
  process.exit(1);
}

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

function speechSpeed(name: string, ttsEnabled: boolean): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return 0.92;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.7 || value > 1.2) {
    // Hourly TTS is optional. A malformed tuning value must never prevent the
    // radio bot from starting (nor reveal the configured value in logs).
    console.warn(`[config] ${name} must be a number from 0.7 to 1.2; using 0.92${ttsEnabled ? '' : ' while hourly TTS is disabled'}`);
    return 0.92;
  }
  return value;
}

export type RadioPreset = 'am' | 'clean';

const hourlyTtsEnabled = Boolean(process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_VOICE_ID?.trim());

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    guildId: required('DISCORD_GUILD_ID'),
    /** Optional: auto-join this voice channel on boot. */
    voiceChannelId: optional('DISCORD_VOICE_CHANNEL_ID', ''),
    /** Reconnect the voice session this often while the channel is empty. 0 disables. */
    voiceRefreshHours: optionalNumber('VOICE_REFRESH_HOURS', 3),
  },
  youtube: {
    /** Enables the YouTube live chat -> Discord bridge when both are set. */
    apiKey: optional('YOUTUBE_API_KEY', ''),
    videoId: optional('YOUTUBE_VIDEO_ID', ''),
    /** Poll floor; ~45s keeps a 24/7 bridge inside the 10k/day quota. */
    chatPollS: optionalNumber('YT_CHAT_POLL_S', 45),
  },
  station: {
    name: optional('STATION_NAME', 'anomaly.fm'),
    description: optional('STATION_DESCRIPTION', 'live from the anomaly'),
    genre: optional('STATION_GENRE', 'talk'),
    /** Timezone for on-air labels (rerun date/time display). */
    timeZone: optional('STATION_TZ', 'America/New_York'),
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
    /** Enables admin-filtered listener counts (excludes tv/recorder). */
    adminPassword: optional('ICECAST_ADMIN_PASSWORD', ''),
  },
  rerun: {
    /** Auto-rotate the archive while the channel is empty. */
    auto: optional('RERUN_AUTO', 'true') !== 'false',
    /** Wait after live ends before any rerun starts. */
    afterLiveMin: optionalNumber('RERUN_AFTER_LIVE_MIN', 35),
    /** Music-bed gap between consecutive reruns. */
    gapMin: optionalNumber('RERUN_GAP_MIN', 35),
    recordingsDir: optional('RECORDINGS_DIR', '/recordings'),
  },
  music: {
    /** Directory of selectable bed tracks (admin uploads land here). */
    dir: optional('MUSIC_DIR', '/music'),
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
  web: {
    /** Station web root (skins + generated current.html). Empty disables rotation. */
    dir: optional('WEB_DIR', '/web'),
  },
  voicemail: {
    /** Hotline recordings directory (shared with the admin app). */
    dir: optional('VOICEMAIL_DIR', '/voicemails'),
  },
  archive: {
    /** Finished sessions are rendered to mp4 and posted here. "off" disables. */
    postChannelId: offable(optional('ARCHIVE_POST_CHANNEL_ID', '1522363822084587693')),
    /** Admin app base URL (runs the mp4 renders). */
    adminApi: optional('ADMIN_API', 'http://admin:8091'),
  },
  announcer: {
    /** Hourly time checks air when both ElevenLabs values are set. */
    elevenLabsKey: optional('ELEVENLABS_API_KEY', ''),
    voiceId: optional('ELEVENLABS_VOICE_ID', ''),
    /** Native ElevenLabs cadence control (official range: 0.7–1.2). */
    speechSpeed: speechSpeed('ELEVENLABS_SPEECH_SPEED', hourlyTtsEnabled),
    modelId: optional('ELEVENLABS_MODEL_ID', 'eleven_multilingual_v2'),
    /** Script LLM (opencode zen, Anthropic-compatible). Optional: plain time check without it. */
    zenKey: optional('ZEN_API_KEY', ''),
    zenModel: optional('ZEN_MODEL', 'claude-haiku-4-5'),
    zenUrl: optional('ZEN_URL', 'https://opencode.ai/zen/v1/messages'),
  },
  automation: {
    /** Explicit cutover flag. False leaves every legacy audio path unchanged. */
    playoutEnabled: optional('AUTOMATION_PLAYOUT_ENABLED', 'false') === 'true',
    internalUrl: optional('AUTOMATION_INTERNAL_URL', 'http://automation:8092'),
    internalToken: optional('AUTOMATION_INTERNAL_TOKEN', ''),
    /** Fixed equal-power music transition; server also constrains this policy. */
    crossfadeMs: optionalNumber('AUTOMATION_CROSSFADE_MS', 6000),
    /** Fire claim/prebuffer slightly before the audible fade boundary. */
    crossfadeLeadMs: optionalNumber('AUTOMATION_CROSSFADE_LEAD_MS', 250),
    generatedDir: optional('AUTOMATION_GENERATED_DIR', '/generated'),
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

import path from 'node:path';
import type { AutomationConfig } from './types.js';

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(): AutomationConfig {
  const badwords = (process.env.AUTOMATION_HOTLINE_BADWORDS || '').split(',').map((v) => v.trim().toLocaleLowerCase('en-US')).filter(Boolean);
  const speechBadwords = (process.env.AUTOMATION_SPEECH_BADWORDS || '').split(',').map((v) => v.trim().toLocaleLowerCase('en-US')).filter(Boolean);
  if (badwords.length > 256 || badwords.some((word) => Buffer.byteLength(word, 'utf8') > 64 || /[\u0000-\u001f\u007f]/u.test(word))) {
    throw new Error('AUTOMATION_HOTLINE_BADWORDS must contain at most 256 plain entries of at most 64 bytes');
  }
  const config: AutomationConfig = {
    databasePath: process.env.AUTOMATION_DB_PATH || '/state/station.db',
    migrationsDir: process.env.AUTOMATION_MIGRATIONS_DIR || path.resolve('migrations'),
    musicDir: process.env.AUTOMATION_MUSIC_DIR || '/music',
    generatedDir: process.env.AUTOMATION_GENERATED_DIR || '/generated',
    recordingsDir: process.env.AUTOMATION_RECORDINGS_DIR || '/recordings',
    voicemailsDir: process.env.AUTOMATION_VOICEMAILS_DIR || '/voicemails',
    bind: process.env.AUTOMATION_BIND || '127.0.0.1',
    port: int('AUTOMATION_PORT', 8092, 1, 65535),
    internalToken: process.env.AUTOMATION_INTERNAL_TOKEN || '',
    allowUnauthenticated: bool('AUTOMATION_ALLOW_UNAUTHENTICATED', false),
    maxBodyBytes: int('AUTOMATION_MAX_BODY_BYTES', 65_536, 1024, 1_048_576),
    claimLeaseMs: int('AUTOMATION_CLAIM_LEASE_MS', 30_000, 5000, 300_000),
    maxQueueCues: int('AUTOMATION_MAX_QUEUE_CUES', 100, 24, 1000),
    maxHorizonMs: int('AUTOMATION_MAX_HORIZON_MIN', 120, 90, 1440) * 60_000,
    lowCueCount: int('AUTOMATION_LOW_CUES', 12, 1, 100),
    highCueCount: int('AUTOMATION_HIGH_CUES', 24, 1, 200),
    lowHorizonMs: int('AUTOMATION_LOW_HORIZON_MIN', 45, 1, 1440) * 60_000,
    targetHorizonMs: int('AUTOMATION_TARGET_HORIZON_MIN', 90, 1, 1440) * 60_000,
    assetRepeatMs: int('AUTOMATION_ASSET_REPEAT_MIN', 360, 0, 10_080) * 60_000,
    artistRepeatMs: int('AUTOMATION_ARTIST_REPEAT_MIN', 120, 0, 10_080) * 60_000,
    crossfadeMs: int('AUTOMATION_CROSSFADE_MS', 3000, 500, 5000),
    badwords,
    hotlineEnabled: bool('AUTOMATION_HOTLINE_ENABLED', false),
    playoutEnabled: bool('AUTOMATION_PLAYOUT_ENABLED', false),
    djEnabled: bool('AUTOMATION_DJ_ENABLED', false),
    djShadow: bool('AUTOMATION_DJ_SHADOW', false),
    aiArchiveEnabled: bool('AUTOMATION_AI_ARCHIVE_ENABLED', false),
    generationEnabled: bool('AUTOMATION_GENERATION_ENABLED', false),
    hotlineImportEnabled: bool('AUTOMATION_HOTLINE_IMPORT_ENABLED', false),
    speechBadwords,
    elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
    elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
    elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    elevenLabsBaseUrl: (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/u, ''),
    generationPollMs: int('AUTOMATION_GENERATION_POLL_MS', 2000, 250, 60_000),
    generationLeaseMs: int('AUTOMATION_GENERATION_LEASE_MS', 120_000, 10_000, 600_000),
    generatedMaxBytes: int('AUTOMATION_GENERATED_MAX_BYTES', 10_000_000, 100_000, 100_000_000),
    generatedBudgetBytes: int('AUTOMATION_GENERATED_BUDGET_BYTES', 2_147_483_648, 10_000_000, 20_000_000_000),
    opencodeUrl: (process.env.AUTOMATION_OPENCODE_URL || 'http://opencode:4096').replace(/\/$/u, ''),
    opencodeUsername: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
    opencodePassword: process.env.OPENCODE_SERVER_PASSWORD || '',
    djModel: process.env.AUTOMATION_DJ_MODEL || '',
    djToolToken: process.env.AUTOMATION_DJ_TOOL_TOKEN || '',
    djPollMs: int('AUTOMATION_DJ_POLL_MS', 15_000, 1000, 300_000),
    djTimeoutMs: int('AUTOMATION_DJ_TIMEOUT_MS', 60_000, 5000, 110_000),
    djLeaseMs: int('AUTOMATION_DJ_LEASE_MS', 120_000, 10_000, 300_000),
    djCooldownMs: int('AUTOMATION_DJ_COOLDOWN_MS', 300_000, 0, 3_600_000),
    djDailyToolLimit: int('AUTOMATION_DJ_DAILY_TOOL_LIMIT', 200, 1, 100_000),
    djDailyModelTokenLimit: int('AUTOMATION_DJ_DAILY_MODEL_TOKEN_LIMIT', 200_000, 1000, 100_000_000),
    ttsDailyCharacterLimit: int('AUTOMATION_TTS_DAILY_CHARACTER_LIMIT', 20_000, 100, 10_000_000),
    feedDir: process.env.AUTOMATION_FEED_DIR || '/feed',
    rerunAuto: bool('RERUN_AUTO', true),
    rerunAfterLiveMs: int('RERUN_AFTER_LIVE_MIN', 35, 0, 1440) * 60_000,
    rerunGapMs: int('RERUN_GAP_MIN', 35, 0, 1440) * 60_000,
    rerunPollMs: int('AUTOMATION_RERUN_POLL_MS', 5000, 250, 300_000),
    djFakeProviderEnabled: bool('AUTOMATION_DJ_FAKE_PROVIDER_ENABLED', false),
    stationTimeZone: process.env.STATION_TZ || 'America/New_York',
  };
  if (config.highCueCount < config.lowCueCount) throw new Error('AUTOMATION_HIGH_CUES must be >= AUTOMATION_LOW_CUES');
  if (config.maxQueueCues < config.highCueCount) throw new Error('AUTOMATION_MAX_QUEUE_CUES must be >= AUTOMATION_HIGH_CUES');
  if (config.targetHorizonMs < config.lowHorizonMs) throw new Error('AUTOMATION_TARGET_HORIZON_MIN must be >= AUTOMATION_LOW_HORIZON_MIN');
  if (config.maxHorizonMs < config.targetHorizonMs) throw new Error('AUTOMATION_MAX_HORIZON_MIN must be >= AUTOMATION_TARGET_HORIZON_MIN');
  if (speechBadwords.length > 256 || speechBadwords.some((word) => Buffer.byteLength(word, 'utf8') > 64 || /[\u0000-\u001f\u007f]/u.test(word))) {
    throw new Error('AUTOMATION_SPEECH_BADWORDS must contain at most 256 plain entries of at most 64 bytes');
  }
  return config;
}

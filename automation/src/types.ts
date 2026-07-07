export const CUE_TYPES = ['music', 'spoken', 'hotline', 'rerun', 'station_id', 'silence'] as const;
export type CueType = typeof CUE_TYPES[number];
export type CueState = 'DRAFT' | 'GENERATING' | 'VALIDATING' | 'READY' | 'CLAIMED' |
  'PLAYING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'CANCELED';

export interface ProbeResult {
  durationMs: number;
  codecName: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitRate: number | null;
  mimeType: string;
  loudnessLufs?: number | null;
  raw?: unknown;
}

export interface AutomationConfig {
  databasePath: string;
  migrationsDir: string;
  musicDir: string;
  generatedDir: string;
  recordingsDir: string;
  voicemailsDir: string;
  bind: string;
  port: number;
  internalToken: string;
  allowUnauthenticated: boolean;
  maxBodyBytes: number;
  claimLeaseMs: number;
  maxQueueCues: number;
  maxHorizonMs: number;
  lowCueCount: number;
  highCueCount: number;
  lowHorizonMs: number;
  targetHorizonMs: number;
  assetRepeatMs: number;
  artistRepeatMs: number;
  crossfadeMs: number;
  badwords: string[];
  hotlineEnabled: boolean;
  playoutEnabled: boolean;
  djEnabled: boolean;
  djShadow: boolean;
  aiArchiveEnabled: boolean;
  generationEnabled: boolean;
  hotlineImportEnabled: boolean;
  speechBadwords: string[];
  elevenLabsKey: string;
  elevenLabsVoiceId: string;
  elevenLabsModelId: string;
  elevenLabsSpeechSpeed: number;
  elevenLabsBaseUrl: string;
  generationPollMs: number;
  generationLeaseMs: number;
  generatedMaxBytes: number;
  generatedBudgetBytes: number;
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
  djModel: string;
  djToolToken: string;
  djPollMs: number;
  djTimeoutMs: number;
  djLeaseMs: number;
  djCooldownMs: number;
  djDailyToolLimit: number;
  djDailyModelTokenLimit: number;
  ttsDailyCharacterLimit: number;
  feedDir: string;
  rerunAfterLiveMs: number;
  rerunGapMs: number;
  rerunPollMs: number;
  djFakeProviderEnabled: boolean;
  stationTimeZone: string;
}

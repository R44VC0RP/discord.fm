import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AutomationConfig } from '../types.js';
import { AutomationStore } from '../store.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function testConfig(root: string, overrides: Partial<AutomationConfig> = {}): AutomationConfig {
  return {
    databasePath: path.join(root, 'state', 'station.db'), migrationsDir: path.join(packageRoot, 'migrations'),
    musicDir: path.join(root, 'music'), generatedDir: path.join(root, 'generated'), recordingsDir: path.join(root, 'recordings'), voicemailsDir: path.join(root, 'voicemails'),
    bind: '127.0.0.1', port: 8092, internalToken: 'test-token', allowUnauthenticated: false, maxBodyBytes: 65_536,
    claimLeaseMs: 30_000, maxQueueCues: 100, maxHorizonMs: 7_200_000, lowCueCount: 12, highCueCount: 24,
    lowHorizonMs: 2_700_000, targetHorizonMs: 5_400_000, assetRepeatMs: 21_600_000, artistRepeatMs: 7_200_000,
    crossfadeMs: 3000, badwords: ['forbidden phrase'], speechBadwords: ['speech-blocked'],
    hotlineEnabled: true, playoutEnabled: true, djEnabled: false, djShadow: false, aiArchiveEnabled: false,
    generationEnabled: false, hotlineImportEnabled: false, elevenLabsKey: '', elevenLabsVoiceId: '', elevenLabsModelId: 'eleven_multilingual_v2', elevenLabsBaseUrl: 'https://api.elevenlabs.io',
    generationPollMs: 2000, generationLeaseMs: 120_000, generatedMaxBytes: 10_000_000, generatedBudgetBytes: 2_147_483_648,
    opencodeUrl: 'http://127.0.0.1:4096', opencodeUsername: 'opencode', opencodePassword: 'test-password', djModel: 'opencode/test', djToolToken: 'dj-tool-token-0123456789abcdef012345', djPollMs: 15_000, djTimeoutMs: 60_000, djLeaseMs: 120_000, djCooldownMs: 300_000,
    djDailyToolLimit: 200, djDailyModelTokenLimit: 200_000, ttsDailyCharacterLimit: 20_000,
    feedDir: path.join(root, 'feed'), rerunAuto: true, rerunAfterLiveMs: 35 * 60_000, rerunGapMs: 35 * 60_000, rerunPollMs: 1000,
    djFakeProviderEnabled: false,
    stationTimeZone: 'America/New_York',
    ...overrides,
  };
}

export async function testFixture(overrides: Partial<AutomationConfig> = {}): Promise<{ root: string; store: AutomationStore; config: AutomationConfig }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anomaly-automation-'));
  await Promise.all(['music', 'generated', 'recordings', 'voicemails', 'feed'].map((dir) => fsp.mkdir(path.join(root, dir))));
  const config = testConfig(root, overrides);
  return { root, config, store: new AutomationStore(config) };
}

export function testChecksum(seed: string): string { return crypto.createHash('sha256').update(seed).digest('hex'); }

export function testAsset(store: AutomationStore, seed: string, kind: 'music' | 'spoken' | 'hotline' | 'rerun' | 'station_id' = 'music', durationMs = 180_000, artist = 'Test Artist'): string {
  fs.mkdirSync(store.config.generatedDir, { recursive: true });
  const locator = path.join(store.config.generatedDir, `${seed.replaceAll('/', '_')}.mp3`);
  fs.writeFileSync(locator, seed);
  return store.putAsset({ kind, checksum: testChecksum(seed), sourceLocator: locator, playoutLocator: locator, title: seed, artist, durationMs, mimeType: 'audio/mpeg', codecName: 'mp3', sampleRateHz: 48_000, channels: 2, bitRate: 128_000 }).assetId;
}

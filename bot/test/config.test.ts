import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const botRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadBotConfig(env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DISCORD_TOKEN: 'test-token',
    DISCORD_GUILD_ID: '123456789012345678',
    ICECAST_SOURCE_PASSWORD: 'test-password',
  };
  delete childEnv.ELEVENLABS_API_KEY;
  delete childEnv.ELEVENLABS_VOICE_ID;
  delete childEnv.ELEVENLABS_SPEECH_SPEED;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]; else childEnv[key] = value;
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', "import { config } from './src/config.ts'; process.stdout.write(String(config.announcer.speechSpeed));"], {
    cwd: botRoot, env: childEnv, encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('invalid optional speech speed cannot terminate the bot without announcer credentials', () => {
  const result = loadBotConfig({ ELEVENLABS_SPEECH_SPEED: 'not-a-speed' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0.92');
  assert.match(result.stderr, /using 0\.92 while hourly TTS is disabled/u);
  assert.doesNotMatch(result.stderr, /not-a-speed/u);
});

test('bot speech speed uses default and valid official boundaries, including enabled TTS', () => {
  assert.equal(loadBotConfig({}).stdout, '0.92');
  assert.equal(loadBotConfig({ ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_VOICE_ID: 'test-voice', ELEVENLABS_SPEECH_SPEED: '0.7' }).stdout, '0.7');
  assert.equal(loadBotConfig({ ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_VOICE_ID: 'test-voice', ELEVENLABS_SPEECH_SPEED: '1.2' }).stdout, '1.2');
  const invalidEnabled = loadBotConfig({ ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_VOICE_ID: 'test-voice', ELEVENLABS_SPEECH_SPEED: '1.3' });
  assert.equal(invalidEnabled.status, 0);
  assert.equal(invalidEnabled.stdout, '0.92');
  assert.match(invalidEnabled.stderr, /using 0\.92/u);
  assert.doesNotMatch(invalidEnabled.stderr, /test-key|test-voice|1\.3/u);
});

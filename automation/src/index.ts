import { loadConfig } from './config.js';
import { AutomationStore } from './store.js';
import { createServer } from './server.js';
import { importMusic } from './importer.js';
import { GenerationWorker, ElevenLabsRenderer } from './generation.js';
import { HotlineScanner } from './hotline-importer.js';
import { OpenCodeGateway } from './opencode.js';
import { DjCoordinator } from './dj.js';
import { RerunScheduler } from './rerun-scheduler.js';

const config = loadConfig();
if (!config.internalToken && !config.allowUnauthenticated) throw new Error('AUTOMATION_INTERNAL_TOKEN is required (or explicitly set AUTOMATION_ALLOW_UNAUTHENTICATED=true for isolated local tests)');
if (config.internalToken && config.internalToken.length < 32) throw new Error('AUTOMATION_INTERNAL_TOKEN must be at least 32 characters');
if (config.hotlineEnabled && config.badwords.length === 0) throw new Error('AUTOMATION_HOTLINE_BADWORDS must contain an operator-reviewed policy before hotline automation is enabled');
if (config.aiArchiveEnabled) throw new Error('AUTOMATION_AI_ARCHIVE_ENABLED is intentionally unsupported in the initial rollout');
if (config.generationEnabled && (!config.elevenLabsKey || !config.elevenLabsVoiceId)) throw new Error('ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required when generation is enabled');
if (config.hotlineImportEnabled && !config.hotlineEnabled) throw new Error('AUTOMATION_HOTLINE_ENABLED must also be true when hotline import is enabled');
if (config.djEnabled && (!config.djModel || !config.opencodePassword || (!config.djShadow && !config.generationEnabled))) throw new Error('DJ enablement requires AUTOMATION_DJ_MODEL and OPENCODE_SERVER_PASSWORD; live DJ mutations also require AUTOMATION_GENERATION_ENABLED=true');
if (config.djEnabled && config.djToolToken.length < 32) throw new Error('AUTOMATION_DJ_TOOL_TOKEN must be at least 32 characters when DJ tools are enabled');
if (config.djEnabled && config.opencodePassword.length < 32) throw new Error('OPENCODE_SERVER_PASSWORD must be at least 32 characters when DJ tools are enabled');
const store = new AutomationStore(config);
const reruns = new RerunScheduler(store, config);

if (process.env.AUTOMATION_IMPORT_MUSIC_ON_START === 'true') {
  const result = await importMusic(store, config.musicDir);
  process.stdout.write(`${JSON.stringify({ level: result.failed.length ? 'warn' : 'info', event: 'music_import_complete', ...result })}\n`);
}

await reruns.initialize();
const server = createServer(store, config, reruns);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5000;
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.bind, () => resolve());
});
process.stdout.write(`${JSON.stringify({ level: 'info', event: 'automation_listening', bind: config.bind, port: config.port, flags: { playout: config.playoutEnabled, dj: config.djEnabled, generation: config.generationEnabled, hotline: config.hotlineEnabled, hotline_import: config.hotlineImportEnabled } })}\n`);

const generationWorker = new GenerationWorker(store, config, new ElevenLabsRenderer(config));
const hotlineScanner = new HotlineScanner(store, config.voicemailsDir);
const dj = new DjCoordinator(store, config, new OpenCodeGateway(config));
try {
  await dj.initialize();
  generationWorker.start();
  reruns.start();
  if (config.hotlineImportEnabled) hotlineScanner.start();
  dj.start();
} catch (error) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  throw error;
}

function shutdown(signal: string): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', event: 'automation_shutdown', signal })}\n`);
  generationWorker.stop(); hotlineScanner.stop(); dj.stop(); reruns.stop();
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

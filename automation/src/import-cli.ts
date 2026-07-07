import { loadConfig } from './config.js';
import { AutomationStore } from './store.js';
import { importMusic } from './importer.js';

const config = loadConfig();
const store = new AutomationStore(config);
try {
  const result = await importMusic(store, config.musicDir);
  process.stdout.write(`${JSON.stringify({ level: result.failed.length ? 'warn' : 'info', event: 'music_import_complete', ...result })}\n`);
  if (result.failed.length) process.exitCode = 1;
} finally {
  store.close();
}

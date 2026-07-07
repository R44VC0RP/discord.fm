/**
 * Local test harness: renders every theme x representative air states into
 * /tmp/og-test/*.png plus whatever the live station reports right now.
 * Usage: node test-render.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const OUT = '/tmp/og-test';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Fake a web dir per skin so detectSkin() picks the theme under test.
const repoWeb = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web');
const skins = fs.readdirSync(path.join(repoWeb, 'skins')).filter((f) => f.endsWith('.html'));

const states = {
  live: { station: 'anomaly.fm', live: true, humans: 2, members: ['vogel.kit', 'exedev'], rerun: null, listeners: 14, sources: { web: 9, youtube: 5 }, updated: new Date().toISOString() },
  'live-long': { station: 'anomaly.fm', live: true, humans: 4, members: ['vogel.kit', 'exedev', 'someone with a very long name', 'fourth caller'], rerun: null, listeners: 133, sources: {}, updated: new Date().toISOString() },
  rerun: { station: 'anomaly.fm', live: true, humans: 0, members: [], rerun: 'Jul 2 | 2:54 PM | vogel.kit, exedev', listeners: 6, sources: {}, updated: new Date().toISOString() },
  automation: { station: 'anomaly.fm', live: true, humans: 0, members: [], rerun: null, automation: { enabled: true, current: { type: 'music', title: 'Signal Through Rain', artist: 'Night Operator' }, next_depth: 8 }, listeners: 9, sources: {}, updated: new Date().toISOString() },
  ident: { station: 'anomaly.fm', live: true, humans: 0, members: [], stationIdent: { title: 'Hourly time check' }, automation: { enabled: true, current: null, next_depth: 8 }, listeners: 9, sources: {}, updated: new Date().toISOString() },
  idle: { station: 'anomaly.fm', live: true, humans: 0, members: [], rerun: null, listeners: 3, sources: {}, updated: new Date().toISOString() },
  offair: null,
};

// Real live status, if reachable.
try {
  const real = execSync('curl -sf --max-time 5 https://anomaly.fm/feed/status.json', { encoding: 'utf8' });
  states.real = JSON.parse(real);
} catch { console.log('(live status.json unreachable, skipping "real")'); }

for (const skin of skins) {
  const name = skin.replace(/\.html$/, '');
  const webDir = path.join(OUT, 'web-' + name);
  fs.mkdirSync(path.join(webDir, 'skins'), { recursive: true });
  for (const s of skins) fs.copyFileSync(path.join(repoWeb, 'skins', s), path.join(webDir, 'skins', s));
  fs.copyFileSync(path.join(repoWeb, 'skins', skin), path.join(webDir, 'current.html'));

  for (const [label, status] of Object.entries(states)) {
    const feedDir = path.join(OUT, 'feed');
    fs.mkdirSync(feedDir, { recursive: true });
    const statusFile = path.join(feedDir, 'status.json');
    if (status) fs.writeFileSync(statusFile, JSON.stringify(status));
    else fs.rmSync(statusFile, { force: true });

    execSync(`node --input-type=module -e "
      process.env.STATUS_FILE = '${statusFile}';
      process.env.WEB_DIR = '${webDir}';
      process.env.OG_POLL_S = '3600';
      await import('${path.join(path.dirname(new URL(import.meta.url).pathname), 'generator.js')}');
      process.exit(0);
    "`, { stdio: 'inherit' });
    fs.copyFileSync(path.join(webDir, 'og.png'), path.join(OUT, `${name}--${label}.png`));
  }
}
console.log('done ->', OUT);

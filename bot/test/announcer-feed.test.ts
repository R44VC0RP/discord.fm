import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivityFeed, onAirLine, type PresenceSnapshot } from '../src/feed.js';
import { BYTES_PER_FRAME, Mixer } from '../src/mixer.js';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_GUILD_ID ||= '123456789012345678';
process.env.ICECAST_SOURCE_PASSWORD ||= 'test-password';

async function announcerClass() {
  const { Announcer } = await import('../src/announcer.js');
  return class TestAnnouncer extends Announcer {
    writes = 0; speaks = 0; failSpeak = false; afterSpeak?: () => void;
    override async writeScript(): Promise<string> { this.writes += 1; return 'Test hourly ident'; }
    override async speak(): Promise<Buffer> { this.speaks += 1; this.afterSpeak?.(); if (this.failSpeak) throw new Error('tts down'); return Buffer.alloc(BYTES_PER_FRAME * 2); }
  };
}

const listeners = async () => ({ web: 0, youtube: 0, total: 0 });

test('hourly ident skips collision/live/expiry, rechecks presence, and fails soft', async () => {
  const TestAnnouncer = await announcerClass();
  let snapshot: PresenceSnapshot = { live: true, humans: 0, members: [] };
  let canStart = false;
  const mixer = new Mixer();
  const announcer = new TestAnnouncer({ mixer, getSnapshot: () => snapshot, getListeners: listeners, canStart: () => canStart });
  assert.match((await announcer.fire()).reason ?? '', /pending|active/u); assert.equal(announcer.writes, 0);
  canStart = true; snapshot = { live: true, humans: 1, members: ['host'] };
  assert.equal((await announcer.fire()).fired, false); assert.equal(announcer.writes, 0);
  snapshot = { live: true, humans: 0, members: [] }; announcer.afterSpeak = () => { snapshot.humans = 1; };
  assert.match((await announcer.fire()).reason ?? '', /went live/u); assert.equal(mixer.announcing, false);
  snapshot.humans = 0; announcer.afterSpeak = undefined;
  assert.match((await announcer.fire(false, Date.now() - 1)).reason ?? '', /expired/u);
  announcer.failSpeak = true;
  assert.match((await announcer.fire()).reason ?? '', /tts down/u);
});

test('hourly ident occupies one collision-safe station overlay', async () => {
  const TestAnnouncer = await announcerClass();
  const mixer = new Mixer(); let active = false;
  const snapshot: PresenceSnapshot = { live: true, humans: 0, members: [] };
  const announcer = new TestAnnouncer({ mixer, getSnapshot: () => snapshot, getListeners: listeners, canStart: () => true, onStateChange: (value) => { active = value; } });
  assert.equal((await announcer.fire()).fired, true); assert.equal(active, true); assert.equal(mixer.announcing, true);
  assert.match((await announcer.fire()).reason ?? '', /busy/u);
});

test('feed projects automation/rerun/ident safely and latest atomic update wins', async () => {
  assert.equal(onAirLine({ live: true, humans: 0, members: [], automation: { enabled: true, current: { type: 'music', title: 'Song\nInjected', artist: 'Artist', progress_ms: 0, duration_ms: 1 }, next_depth: 1 } }), 'NOW PLAYING — Song Injected — Artist');
  assert.equal(onAirLine({ live: true, humans: 0, members: [], stationIdent: { title: 'Hourly time check' } }), 'STATION ID — Hourly time check');
  assert.match(onAirLine({ live: true, humans: 0, members: [], automation: { enabled: true, current: { type: 'rerun', title: 'Archive', artist: '', progress_ms: 0, duration_ms: 1 }, next_depth: 0 } }), /^RERUN/u);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anomaly-feed-'));
  const feed = new ActivityFeed(dir, { station: 'test', link: 'https://example.test', maxItems: 5 });
  await feed.init();
  const first = feed.update({ live: true, humans: 0, members: [], automation: { enabled: true, current: { type: 'music', title: 'old', artist: '', progress_ms: 0, duration_ms: 1 }, next_depth: 1 } });
  const second = feed.update({ live: true, humans: 0, members: [], automation: { enabled: true, current: { type: 'hotline', title: 'latest', artist: '', progress_ms: 0, duration_ms: 1 }, next_depth: 0 } });
  await Promise.all([first, second]);
  assert.equal(await fsp.readFile(path.join(dir, 'onair.txt'), 'utf8'), 'HOTLINE — latest\n');
  const status = JSON.parse(await fsp.readFile(path.join(dir, 'status.json'), 'utf8')) as { automation: { current: { title: string } } };
  assert.equal(status.automation.current.title, 'latest');
  await fsp.rm(dir, { recursive: true, force: true });
});

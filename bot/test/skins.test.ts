import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startApi, type ApiDeps } from '../src/api.js';
import { InvalidSkinError, SkinControlUnavailableError, SkinManager, dailySkin } from '../src/skins.js';

const fixedNow = new Date('2026-07-03T12:00:00Z');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anomaly-skins-'));
  const web = join(root, 'web');
  const feed = join(root, 'feed');
  await mkdir(join(web, 'skins'), { recursive: true });
  await mkdir(feed);
  await writeFile(join(web, 'skins', 'alpha.html'), 'alpha');
  await writeFile(join(web, 'skins', 'beta.html'), 'beta');
  const stateFile = join(feed, 'skin-state.json');
  const manager = () => new SkinManager(web, 'America/New_York', stateFile, { now: () => fixedNow });
  return { root, web, stateFile, manager };
}

test('manual pin survives restart and daily applies immediately', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = f.manager();
  await first.start();
  const daily = dailySkin(['alpha.html', 'beta.html'], 'America/New_York', fixedNow)!;
  assert.equal((await first.state()).active, daily);
  assert.equal(await readFile(join(f.web, 'current.html'), 'utf8'), daily.replace('.html', ''));

  const manual = daily === 'alpha.html' ? 'beta.html' : 'alpha.html';
  await first.setManual(manual);
  first.stop();
  const restarted = f.manager();
  await restarted.start();
  assert.deepEqual(await restarted.state(), {
    mode: 'manual', active: manual, daily, available: ['alpha.html', 'beta.html'],
    control: { available: true, message: null },
  });
  assert.equal(await readFile(join(f.web, 'current.html'), 'utf8'), manual.replace('.html', ''));
  assert.equal((await restarted.setDaily()).active, daily);
  restarted.stop();
});

test('rejects unknown and traversal skin names', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manager = f.manager();
  await manager.start();
  await assert.rejects(manager.setManual('../alpha.html'), InvalidSkinError);
  await assert.rejects(manager.setManual('missing.html'), InvalidSkinError);
  manager.stop();
});

test('controls are unavailable without durable policy storage while daily rotation continues', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manager = new SkinManager(f.web, 'America/New_York', '', { now: () => fixedNow });
  await manager.start();
  const state = await manager.state();
  assert.equal(state.mode, 'daily');
  assert.equal(state.control.available, false);
  assert.match(state.control.message ?? '', /FEED_DIR/);
  assert.equal(await readFile(join(f.web, 'current.html'), 'utf8'), state.active!.replace('.html', ''));
  await assert.rejects(manager.setManual('alpha.html'), SkinControlUnavailableError);
  await assert.rejects(manager.setDaily(), SkinControlUnavailableError);
  manager.stop();
});

test('enumerates and activates only regular html files', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(join(f.web, 'skins', 'directory.html'));
  await symlink(join(f.web, 'skins', 'alpha.html'), join(f.web, 'skins', 'symlink.html'));
  const manager = f.manager();
  await manager.start();
  assert.deepEqual((await manager.state()).available, ['alpha.html', 'beta.html']);
  await assert.rejects(manager.setManual('directory.html'), InvalidSkinError);
  await assert.rejects(manager.setManual('symlink.html'), InvalidSkinError);
  manager.stop();
});

test('falls back to daily when a selected file changes during activation', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manager = f.manager();
  await manager.start();
  const internals = manager as unknown as { materialize: (skin: string) => Promise<void> };
  const materialize = internals.materialize.bind(manager);
  let swapped = false;
  internals.materialize = async (skin) => {
    if (!swapped && skin === 'alpha.html') {
      swapped = true;
      await unlink(join(f.web, 'skins', skin));
      await mkdir(join(f.web, 'skins', skin));
    }
    await materialize(skin);
  };

  await assert.rejects(manager.setManual('alpha.html'), InvalidSkinError);
  const state = await manager.state();
  assert.equal(state.mode, 'daily');
  assert.equal(state.active, 'beta.html');
  assert.equal(await readFile(join(f.web, 'current.html'), 'utf8'), 'beta');
  manager.stop();
});

test('deleted pin and corrupt policy fall back to daily', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manager = f.manager();
  await manager.start();
  await manager.setManual('alpha.html');
  await unlink(join(f.web, 'skins', 'alpha.html'));
  const fallback = await manager.state();
  assert.equal(fallback.mode, 'daily');
  assert.equal(fallback.active, 'beta.html');
  manager.stop();

  await writeFile(f.stateFile, '{broken');
  const corrupt = f.manager();
  await corrupt.start();
  assert.equal((await corrupt.state()).mode, 'daily');
  corrupt.stop();
});

test('re-enumerates new skins and atomically heals current.html', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manager = f.manager();
  await manager.start();
  await writeFile(join(f.web, 'skins', 'gamma.html'), 'gamma');
  assert.deepEqual((await manager.state()).available, ['alpha.html', 'beta.html', 'gamma.html']);
  await manager.setManual('gamma.html');
  await writeFile(join(f.web, 'current.html'), 'tampered');
  await manager.state();
  assert.equal(await readFile(join(f.web, 'current.html'), 'utf8'), 'gamma');
  assert.deepEqual((await readdir(f.web)).filter((name) => name.includes('.tmp')), []);
  manager.stop();
});

test('skin API rejects malformed JSON and unavailable durable controls', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manager = new SkinManager(f.web, 'America/New_York', '', { now: () => fixedNow });
  await manager.start();
  t.after(() => manager.stop());
  const server = startApi({ skin: manager } as unknown as ApiDeps, 0);
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const malformed = await fetch(`http://127.0.0.1:${port}/skin`, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid JSON body' });

  const unavailable = await fetch(`http://127.0.0.1:${port}/skin`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'manual', skin: 'alpha.html' }),
  });
  assert.equal(unavailable.status, 409);
  assert.match((await unavailable.json() as { error: string }).error, /FEED_DIR/);
});

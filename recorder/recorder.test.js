'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SessionRecorder, nonnegativeSeconds, watchStatusFile } = require('./recorder');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    return true;
  }

  close(signal = 'SIGTERM') {
    this.signalCode = signal;
    this.emit('close', null, signal);
  }
}

function fixture(now = Date.parse('2026-07-03T12:00:00Z'), options = {}) {
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-recorder-'));
  const statusFile = path.join(recordingDir, 'status.json');
  const children = [];
  let currentTime = now;
  const recorder = new SessionRecorder({
    recordingDir,
    statusFile,
    stopDelaySeconds: 0,
    now: () => currentTime,
    ...options,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  return {
    recorder,
    recordingDir,
    statusFile,
    children,
    advance(ms) { currentTime += ms; },
    cleanup() { fs.rmSync(recordingDir, { recursive: true, force: true }); },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await delay(5);
  }
}

test('1 -> 0 immediately stops capture and publishes metadata only after ffmpeg closes', async (t) => {
  const f = fixture();
  t.after(f.cleanup);

  f.recorder.pollStatus({ humans: 1, members: ['Alice'], memberIds: ['123'] });
  const base = f.recorder.session.base;
  const finalization = f.recorder.pollStatus({ humans: 0 });

  assert.equal(f.recorder.session, null);
  assert.deepEqual(f.children[0].kills, ['SIGTERM']);
  assert.equal(fs.existsSync(path.join(f.recordingDir, `${base}.json`)), false);

  f.children[0].close();
  await finalization;

  const metadata = JSON.parse(fs.readFileSync(path.join(f.recordingDir, `${base}.json`), 'utf8'));
  assert.deepEqual(metadata.members, ['Alice']);
  assert.deepEqual(metadata.memberIds, ['123']);
});

test('a human returning 30 seconds later starts a distinct session', async (t) => {
  const f = fixture();
  t.after(f.cleanup);

  f.recorder.pollStatus({ humans: 1, members: ['Alice'] });
  const firstBase = f.recorder.session.base;
  const finalization = f.recorder.pollStatus({ humans: 0 });

  f.advance(30_000);
  f.recorder.pollStatus({ humans: 1, members: ['Alice'] });

  assert.notEqual(f.recorder.session.base, firstBase);
  assert.equal(f.children.length, 2);

  // The old capture may still be flushing, but it remains a separate session
  // and only becomes visible to archive consumers once it closes.
  f.children[0].close();
  await finalization;
  assert.equal(fs.existsSync(path.join(f.recordingDir, `${firstBase}.json`)), true);
});

test('status watcher stops immediately without waiting for the 2s polling fallback', async (t) => {
  const f = fixture();
  const watcher = watchStatusFile(f.recorder, { debounceMs: 5, retryMs: 5 });
  t.after(() => {
    watcher.close();
    f.cleanup();
  });

  f.recorder.pollStatus({ humans: 1, members: ['Alice'] });
  const started = Date.now();
  const replacement = `${f.statusFile}.tmp`;
  fs.writeFileSync(replacement, JSON.stringify({ humans: 0, members: [] }));
  fs.renameSync(replacement, f.statusFile);

  await waitFor(() => f.children[0].kills.includes('SIGTERM'));
  assert.ok(Date.now() - started < 500, 'watch-triggered stop should be prompt');
  assert.equal(f.recorder.session, null);

  f.children[0].close();
  await f.recorder.waitForFinalizations();
});

test('late close after SIGKILL publishes metadata exactly once', async (t) => {
  const f = fixture(Date.parse('2026-07-03T12:00:00Z'), {
    captureTermTimeoutMs: 5,
    captureCloseWarnMs: 12,
  });
  t.after(f.cleanup);
  let publications = 0;
  const publishMetadata = f.recorder.publishMetadata.bind(f.recorder);
  f.recorder.publishMetadata = (...args) => {
    publications += 1;
    return publishMetadata(...args);
  };

  f.recorder.pollStatus({ humans: 1, members: ['Alice'] });
  const base = f.recorder.session.base;
  const finalization = f.recorder.pollStatus({ humans: 0 });

  await delay(25);
  assert.deepEqual(f.children[0].kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(publications, 0);
  assert.equal(fs.existsSync(path.join(f.recordingDir, `${base}.json`)), false);

  f.children[0].close('SIGKILL');
  await finalization;
  assert.equal(publications, 1);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(f.recordingDir, `${base}.json`), 'utf8')));

  f.children[0].close('SIGKILL');
  await delay(0);
  assert.equal(publications, 1);
});

test('resumed multi-part capture records every part and SIGTERMs the current child', async (t) => {
  const f = fixture();
  t.after(f.cleanup);

  f.recorder.pollStatus({ humans: 1, members: ['Alice'] });
  const base = f.recorder.session.base;
  f.children[0].close();
  assert.equal(f.recorder.session.child, null);

  f.recorder.pollStatus({ humans: 1, members: ['Alice', 'Bob'] });
  assert.equal(f.children.length, 2);
  assert.deepEqual(
    f.recorder.session.files.map((file) => path.basename(file)),
    [`${base}.mp3`, `${base}-part2.mp3`],
  );

  const finalization = f.recorder.pollStatus({ humans: 0 });
  assert.deepEqual(f.children[0].kills, []);
  assert.deepEqual(f.children[1].kills, ['SIGTERM']);
  f.children[1].close();
  await finalization;

  const metadata = JSON.parse(fs.readFileSync(path.join(f.recordingDir, `${base}.json`), 'utf8'));
  assert.deepEqual(metadata.files, [`${base}.mp3`, `${base}-part2.mp3`]);
  assert.deepEqual(metadata.members, ['Alice', 'Bob']);
});

test('retention protects a finalizing mp3 and metadata appears atomically after close', async (t) => {
  const f = fixture();
  t.after(f.cleanup);

  const oldFile = path.join(f.recordingDir, 'session-2026-07-03T11-00-00.mp3');
  fs.writeFileSync(oldFile, '12345678');
  fs.utimesSync(oldFile, new Date(0), new Date(0));

  f.recorder.pollStatus({ humans: 1, members: ['Alice'] });
  const base = f.recorder.session.base;
  const activeFile = path.join(f.recordingDir, `${base}.mp3`);
  fs.writeFileSync(activeFile, 'abcdefgh');
  f.recorder.maxBytes = 8;
  const finalization = f.recorder.pollStatus({ humans: 0 });

  f.recorder.sweep();
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(activeFile), true);
  assert.equal(fs.existsSync(path.join(f.recordingDir, `${base}.json`)), false);

  f.children[0].close();
  await finalization;
  const metadataFiles = fs.readdirSync(f.recordingDir).filter((name) => name.startsWith(`${base}.json`));
  assert.deepEqual(metadataFiles, [`${base}.json`]);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(f.recordingDir, `${base}.json`), 'utf8')));
  assert.equal(fs.readdirSync(f.recordingDir).some((name) => name.endsWith('.tmp')), false);
});

test('explicit zero is preserved while a nonzero legacy delay remains supported', async () => {
  assert.equal(nonnegativeSeconds('0', 120), 0);
  assert.equal(nonnegativeSeconds(undefined, 0), 0);

  const f = fixture();
  f.recorder.stopDelayMs = 10_000;
  try {
    f.recorder.pollStatus({ humans: 1 });
    f.recorder.pollStatus({ humans: 0 });
    assert.notEqual(f.recorder.session, null);
    assert.deepEqual(f.children[0].kills, []);
    f.advance(10_000);
    const finalization = f.recorder.pollStatus({ humans: 0 });
    assert.equal(f.recorder.session, null);
    f.children[0].close();
    await finalization;
  } finally {
    f.cleanup();
  }
});

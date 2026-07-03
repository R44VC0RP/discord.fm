/**
 * Session recorder: when humans enter the voice channel (status.json humans
 * 0 -> 1) start capturing the aired stream; when the channel stays empty for
 * RECORDING_STOP_DELAY_S, stop and finalize the session.
 *
 * Capture is a pure stream copy (-c copy) of the Icecast mp3: zero re-encode,
 * near-zero CPU, and the recording is exactly what listeners heard (AM filter,
 * music bed, crackle). Sessions survive brief bot redeploys thanks to the
 * Icecast fallback mount; if the capture process dies anyway, the session
 * continues in a new part file.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STATUS_FILE = process.env.STATUS_FILE || '/feed/status.json';
const RECORDING_DIR = process.env.RECORDING_DIR || '/recordings';
const RECORD_URL = process.env.RECORD_URL || 'http://icecast:8000/radio';
const STOP_DELAY_MS = (Number(process.env.RECORDING_STOP_DELAY_S) || 120) * 1000;
const POLL_MS = 2000;

/** @type {null | { child: import('node:child_process').ChildProcess | null, files: string[], base: string, startedAt: number, members: Set<string>, zeroSince: number | null, stopping: boolean }} */
let session = null;

const stamp = () => new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');

function spawnCapture(file) {
  const child = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'anomalyfm-internal',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-i', RECORD_URL,
    '-c', 'copy', '-f', 'mp3', file,
  ]);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    for (const line of text.split('\n')) if (line.trim()) console.warn('[rec:ffmpeg]', line.trim());
  });
  child.on('close', (code) => {
    if (session && session.child === child && !session.stopping) {
      console.warn(`[rec] capture exited mid-session (code ${code}); a new part will start`);
      session.child = null; // poll loop restarts into a part file
    }
  });
  return child;
}

function startSession(members, memberIds) {
  const base = `session-${stamp()}`;
  const file = path.join(RECORDING_DIR, `${base}.mp3`);
  session = {
    child: spawnCapture(file),
    files: [file],
    base,
    startedAt: Date.now(),
    members: new Set(members),
    memberIds: new Set(memberIds),
    zeroSince: null,
    stopping: false,
  };
  console.log('[rec] session started ->', file);
}

function resumeCapture() {
  const file = path.join(RECORDING_DIR, `${session.base}-part${session.files.length + 1}.mp3`);
  session.files.push(file);
  session.child = spawnCapture(file);
  console.log('[rec] capture resumed ->', file);
}

function stopSession() {
  const done = session;
  session = null;
  done.stopping = true;
  if (done.child) {
    done.child.kill('SIGTERM');
  }
  const meta = {
    startedAt: new Date(done.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - done.startedAt) / 1000),
    members: [...done.members],
    // Discord user IDs of everyone seen in the session (enables @mentions).
    memberIds: [...(done.memberIds ?? [])],
    files: done.files.map((f) => path.basename(f)),
  };
  const metaFile = path.join(RECORDING_DIR, `${done.base}.json`);
  try {
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch (error) {
    console.warn('[rec] failed to write metadata:', error.message);
  }
  console.log(`[rec] session saved (${meta.durationSeconds}s, ${meta.members.length} members) ->`, done.base);
}

function poll() {
  let status;
  try {
    status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return; // bot not up yet, or mid-write
  }
  const humans = Number(status.humans) || 0;
  const members = Array.isArray(status.members) ? status.members : [];
  const memberIds = Array.isArray(status.memberIds) ? status.memberIds : [];

  if (humans > 0) {
    if (!session) {
      startSession(members, memberIds);
    } else {
      session.zeroSince = null;
      for (const member of members) session.members.add(member);
      if (!session.memberIds) session.memberIds = new Set();
      for (const id of memberIds) session.memberIds.add(id);
      if (!session.child) resumeCapture();
    }
    return;
  }

  if (session) {
    if (session.zeroSince === null) {
      session.zeroSince = Date.now();
      console.log(`[rec] channel empty; stopping in ${STOP_DELAY_MS / 1000}s unless someone returns`);
    } else if (Date.now() - session.zeroSince > STOP_DELAY_MS) {
      stopSession();
    }
  }
}

// Retention: keep the archive under RECORDINGS_MAX_GB, deleting oldest first.
const MAX_BYTES = (Number(process.env.RECORDINGS_MAX_GB) || 10) * 1024 ** 3;

function sweep() {
  try {
    const entries = fs
      .readdirSync(RECORDING_DIR)
      .filter((name) => name.startsWith('session-') && name.endsWith('.mp3'))
      .map((name) => {
        const stat = fs.statSync(path.join(RECORDING_DIR, name));
        return { name, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    let total = 0;
    for (const entry of entries) {
      total += entry.size;
      const active = session && session.files.some((f) => path.basename(f) === entry.name);
      if (total > MAX_BYTES && !active) {
        fs.rmSync(path.join(RECORDING_DIR, entry.name), { force: true });
        fs.rmSync(path.join(RECORDING_DIR, entry.name.replace(/(-part\d+)?\.mp3$/, '.json')), { force: true });
        console.log('[rec] retention: deleted', entry.name);
      }
    }
  } catch (error) {
    console.warn('[rec] retention sweep failed:', error.message);
  }
}

fs.mkdirSync(RECORDING_DIR, { recursive: true });
console.log(`[rec] watching ${STATUS_FILE} (stop delay ${STOP_DELAY_MS / 1000}s, retention ${MAX_BYTES / 1024 ** 3}GB)`);
setInterval(poll, POLL_MS);
setInterval(sweep, 60 * 60 * 1000);
sweep();

process.on('SIGTERM', () => {
  if (session) stopSession();
  process.exit(0);
});

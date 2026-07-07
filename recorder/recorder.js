/**
 * Session recorder: when humans enter the voice channel (status.json humans
 * 0 -> 1) start capturing the aired stream; when the channel becomes empty,
 * stop and finalize the session. RECORDING_STOP_DELAY_S can retain the old
 * grace-period behavior, but defaults to zero so every departure ends a session.
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

const POLL_MS = 2000;
const CAPTURE_TERM_TIMEOUT_MS = 5_000;
const CAPTURE_CLOSE_WARN_MS = 30_000;
const STATUS_WATCH_DEBOUNCE_MS = 20;
const STATUS_WATCH_RETRY_MS = 50;
const STATUS_WATCH_RETRIES = 5;
const CAPTURE_CLOSED = Symbol('captureClosed');

function nonnegativeSeconds(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stamp(date) {
  return date.toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

class SessionRecorder {
  constructor(options = {}) {
    this.statusFile = options.statusFile ?? process.env.STATUS_FILE ?? '/feed/status.json';
    this.recordingDir = options.recordingDir ?? process.env.RECORDING_DIR ?? '/recordings';
    this.recordUrl = options.recordUrl ?? process.env.RECORD_URL ?? 'http://icecast:8000/radio';
    this.stopDelayMs = nonnegativeSeconds(
      options.stopDelaySeconds ?? process.env.RECORDING_STOP_DELAY_S,
      0,
    ) * 1000;
    this.maxBytes = nonnegativeSeconds(
      options.maxGigabytes ?? process.env.RECORDINGS_MAX_GB,
      10,
    ) * 1024 ** 3;
    this.now = options.now ?? (() => Date.now());
    this.spawn = options.spawn ?? spawn;
    this.captureTermTimeoutMs = options.captureTermTimeoutMs ?? CAPTURE_TERM_TIMEOUT_MS;
    this.captureCloseWarnMs = options.captureCloseWarnMs ?? CAPTURE_CLOSE_WARN_MS;
    this.session = null;
    this.finalizations = new Set();
    this.reservedBases = new Set();
  }

  uniqueBase() {
    const initial = `session-${stamp(new Date(this.now()))}`;
    let base = initial;
    let suffix = 2;
    while (
      this.reservedBases.has(base)
      || fs.existsSync(path.join(this.recordingDir, `${base}.mp3`))
      || fs.existsSync(path.join(this.recordingDir, `${base}.json`))
    ) {
      base = `${initial}-${suffix++}`;
    }
    this.reservedBases.add(base);
    return base;
  }

  spawnCapture(file) {
    const child = this.spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-user_agent', 'anomalyfm-internal',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
      '-i', this.recordUrl,
      '-c', 'copy', '-f', 'mp3', file,
    ]);
    child[CAPTURE_CLOSED] = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      for (const line of text.split('\n')) if (line.trim()) console.warn('[rec:ffmpeg]', line.trim());
    });
    child.once('close', (code) => {
      child[CAPTURE_CLOSED] = true;
      if (this.session && this.session.child === child && !this.session.stopping) {
        console.warn(`[rec] capture exited mid-session (code ${code}); a new part will start`);
        this.session.child = null; // poll loop restarts into a part file
      }
    });
    return child;
  }

  startSession(members, memberIds) {
    const base = this.uniqueBase();
    const file = path.join(this.recordingDir, `${base}.mp3`);
    this.session = {
      child: this.spawnCapture(file),
      files: [file],
      base,
      startedAt: this.now(),
      members: new Set(members),
      memberIds: new Set(memberIds),
      zeroSince: null,
      stopping: false,
    };
    console.log('[rec] session started ->', file);
  }

  resumeCapture() {
    const file = path.join(
      this.recordingDir,
      `${this.session.base}-part${this.session.files.length + 1}.mp3`,
    );
    this.session.files.push(file);
    this.session.child = this.spawnCapture(file);
    console.log('[rec] capture resumed ->', file);
  }

  waitForCaptureClose(child) {
    if (!child || child[CAPTURE_CLOSED]) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (closed) => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(warnTimer);
        child.off('close', onClose);
        resolve(closed);
      };
      const onClose = () => finish(true);
      child.once('close', onClose);

      // ffmpeg flushes and closes the mp3 before its ChildProcess "close"
      // event. Metadata is deliberately withheld until that event so the
      // archive watcher can never discover a session with a still-open mp3.
      const termTimer = setTimeout(() => {
        console.warn('[rec] ffmpeg did not stop after SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }, this.captureTermTimeoutMs);
      termTimer.unref?.();
      const warnTimer = setTimeout(() => {
        // Never make the archive visible while ffmpeg may still have the mp3
        // open. Keep this one-shot close listener until the process confirms
        // closure; a pathological child costs one intentional listener and a
        // protected orphan rather than a corrupt archive entry.
        console.warn('[rec] ffmpeg still has not closed after SIGKILL; metadata remains withheld');
      }, this.captureCloseWarnMs);
      warnTimer.unref?.();

      child.kill('SIGTERM');
    });
  }

  stopSession() {
    const done = this.session;
    if (!done) return Promise.resolve();

    // Detach immediately. A human returning on the next poll must always start
    // a distinct session, even while the prior ffmpeg is flushing its output.
    this.session = null;
    done.stopping = true;
    const endedAt = this.now();

    const finalization = this.finalizeSession(done, endedAt).finally(() => {
      this.finalizations.delete(finalization);
      this.reservedBases.delete(done.base);
    });
    this.finalizations.add(finalization);
    return finalization;
  }

  async finalizeSession(done, endedAt) {
    await this.waitForCaptureClose(done.child);
    this.publishMetadata(done, endedAt);
  }

  publishMetadata(done, endedAt) {
    const meta = {
      startedAt: new Date(done.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationSeconds: Math.round((endedAt - done.startedAt) / 1000),
      members: [...done.members],
      // Discord user IDs of everyone seen in the session (enables @mentions).
      memberIds: [...done.memberIds],
      files: done.files.map((file) => path.basename(file)),
    };
    const metaFile = path.join(this.recordingDir, `${done.base}.json`);
    const tempFile = `${metaFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(meta, null, 2));
      fs.renameSync(tempFile, metaFile);
    } catch (error) {
      fs.rmSync(tempFile, { force: true });
      console.warn('[rec] failed to write metadata:', error.message);
      return;
    }
    console.log(`[rec] session saved (${meta.durationSeconds}s, ${meta.members.length} members) ->`, done.base);
  }

  pollStatus(status) {
    const humans = Number(status.humans) || 0;
    const members = Array.isArray(status.members) ? status.members : [];
    const memberIds = Array.isArray(status.memberIds) ? status.memberIds : [];

    if (humans > 0) {
      if (!this.session) {
        this.startSession(members, memberIds);
      } else {
        this.session.zeroSince = null;
        for (const member of members) this.session.members.add(member);
        for (const id of memberIds) this.session.memberIds.add(id);
        if (!this.session.child) this.resumeCapture();
      }
      return null;
    }

    if (!this.session) return null;
    if (this.stopDelayMs === 0) return this.stopSession();

    if (this.session.zeroSince === null) {
      this.session.zeroSince = this.now();
      console.log(`[rec] channel empty; stopping in ${this.stopDelayMs / 1000}s unless someone returns`);
    } else if (this.now() - this.session.zeroSince >= this.stopDelayMs) {
      return this.stopSession();
    }
    return null;
  }

  poll() {
    let status;
    try {
      status = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
    } catch {
      return false; // bot not up yet, or mid-write; watcher retries shortly
    }
    void this.pollStatus(status);
    return true;
  }

  // Retention: keep the archive under RECORDINGS_MAX_GB, deleting oldest first.
  sweep() {
    try {
      const entries = fs
        .readdirSync(this.recordingDir)
        .filter((name) => name.startsWith('session-') && name.endsWith('.mp3'))
        .map((name) => {
          const stat = fs.statSync(path.join(this.recordingDir, name));
          return { name, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime); // newest first
      let total = 0;
      for (const entry of entries) {
        total += entry.size;
        const active = (
          this.session && this.session.files.some((file) => path.basename(file) === entry.name)
        ) || [...this.reservedBases].some(
          (base) => entry.name === `${base}.mp3` || entry.name.startsWith(`${base}-part`),
        );
        if (total > this.maxBytes && !active) {
          fs.rmSync(path.join(this.recordingDir, entry.name), { force: true });
          fs.rmSync(path.join(this.recordingDir, entry.name.replace(/(-part\d+)?\.mp3$/, '.json')), { force: true });
          console.log('[rec] retention: deleted', entry.name);
        }
      }
    } catch (error) {
      console.warn('[rec] retention sweep failed:', error.message);
    }
  }

  waitForFinalizations() {
    return Promise.allSettled([...this.finalizations]);
  }
}

/**
 * Watch the containing directory rather than status.json itself: this survives
 * atomic replacement of the file. Direct writes are debounced and retried if
 * observed mid-write; the slow interval remains a fallback for missed events.
 */
function watchStatusFile(recorder, options = {}) {
  const watch = options.watch ?? fs.watch;
  const debounceMs = options.debounceMs ?? STATUS_WATCH_DEBOUNCE_MS;
  const retryMs = options.retryMs ?? STATUS_WATCH_RETRY_MS;
  const maxRetries = options.maxRetries ?? STATUS_WATCH_RETRIES;
  const directory = path.dirname(recorder.statusFile);
  const statusName = path.basename(recorder.statusFile);
  let timer = null;
  let closed = false;
  let watcher;

  const schedule = (delay, retriesRemaining = maxRetries) => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!recorder.poll() && retriesRemaining > 0) schedule(retryMs, retriesRemaining - 1);
    }, delay);
    timer.unref?.();
  };

  try {
    watcher = watch(directory, (eventType, filename) => {
      const name = filename == null ? null : String(filename);
      // Some platforms omit names. A rename may be the destination side of an
      // atomic replacement, so accept all rename events in this small feed dir.
      if (name === null || name === statusName || eventType === 'rename') schedule(debounceMs);
    });
    watcher.on('error', (error) => {
      console.warn('[rec] status watcher failed; retaining 2s polling fallback:', error.message);
      if (timer) clearTimeout(timer);
      timer = null;
      closed = true;
      watcher.close();
    });
  } catch (error) {
    console.warn('[rec] status watcher unavailable; retaining 2s polling fallback:', error.message);
    return { close() {} };
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };
}

function main() {
  const recorder = new SessionRecorder();
  fs.mkdirSync(recorder.recordingDir, { recursive: true });
  console.log(`[rec] watching ${recorder.statusFile} (stop delay ${recorder.stopDelayMs / 1000}s, retention ${recorder.maxBytes / 1024 ** 3}GB)`);
  const statusWatcher = watchStatusFile(recorder);
  recorder.poll();
  const pollTimer = setInterval(() => recorder.poll(), POLL_MS);
  const sweepTimer = setInterval(() => recorder.sweep(), 60 * 60 * 1000);
  recorder.sweep();

  let shuttingDown = false;
  process.on('SIGTERM', async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    statusWatcher.close();
    clearInterval(pollTimer);
    clearInterval(sweepTimer);
    if (recorder.session) await recorder.stopSession();
    await recorder.waitForFinalizations();
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { SessionRecorder, nonnegativeSeconds, watchStatusFile };

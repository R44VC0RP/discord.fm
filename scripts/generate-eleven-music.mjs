#!/usr/bin/env node

/**
 * Standalone ElevenLabs Music experiment generator.
 *
 * Official contract (reviewed 2026-07-07):
 * https://elevenlabs.io/docs/api-reference/music/compose
 * https://elevenlabs.io/docs/overview/capabilities/music
 *
 * This script is intentionally not imported by the station application.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const MUSIC_ROOT = path.join(WORKSPACE_ROOT, 'music');
const API_MODEL = 'music_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_DURATION_SECONDS = 90;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12 * 60 * 1000;
const OFFICIAL_API_BASE = 'https://api.elevenlabs.io';
const MANIFEST_NAME = 'manifest.json';
const LOCK_NAME = '.generate-eleven-music.lock';
const DOCS = [
  'https://elevenlabs.io/docs/api-reference/music/compose',
  'https://elevenlabs.io/docs/overview/capabilities/music',
];

const PROMPTS = [
  ['Neural Afterglow', 'Ambient electronica about a neural network dreaming after the operators leave: warm granular pads, slow glassy arpeggios, distant machine-room pulse, subtle tape haze, spacious evolving harmony, a gentle luminous ending. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Packet Garden', 'Bright intricate IDM inspired by packets finding paths through a living digital garden: crisp asymmetrical drums, plucked modular synth, playful micro-glitches, elastic sub-bass, melodic growth from sparse to exuberant. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Silicon Nocturne', 'Dark downtempo electronica for a midnight semiconductor laboratory: smoky analog chords, restrained broken beat, low electrical hum textures, sparse bell tones, tense middle passage resolving into calm. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Cache Miss', 'Angular glitch funk and IDM portraying a cache miss spiraling into a beautiful accident: clipped percussion, syncopated bass, stuttering synth fragments, sudden negative space, precise production, energetic but not harsh. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Data Center Dub', 'Deep data-center dub at a patient tempo: huge spring-style echoes, warm sub-bass, muted machine percussion, cooling-fan ambience shaped musically, sparse chord stabs, long hypnotic decay, nocturnal atmosphere. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Quantum Side Street', 'Cybernetic jazz trio wandering through probabilistic side streets: electric piano, synthetic upright bass, brushed electronic drums, tasteful odd-meter turns, small modular responses, mysterious then warmly resolved. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Compiler Rain', 'Melancholy ambient breakbeat evoking source code compiling during summer rain: soft rain-like synthesis, dusty drums, rounded bass, patient minor-key motif, gradual harmonic opening, intimate cinematic depth. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Robot Cartographer', 'Optimistic modular synth expedition mapping an unknown machine continent: interlocking sequencers, buoyant polyrhythms, tactile analog bleeps, broad horizon pads, clear three-act arc and satisfying return. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Latency Lagoon', 'Weightless aquatic downtempo built around the sensation of signals arriving late: rippling synth mallets, lazy half-time beat, deep soft bass, delayed motifs answering across stereo space, serene blue-green mood. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Synthetic Mycelium', 'Organic glitch ambient where a hidden computational mycelium exchanges information: woody percussion, granular spores of sound, slowly branching arpeggios, earthy low drones, complex detail with a tranquil pulse. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Inference Engine', 'Focused futuristic electro-jazz representing an inference engine reaching a surprising conclusion: tight drums, fretless synthetic bass, electric keys, escalating rhythmic hypotheses, a brief suspended silence, confident final theorem. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Cold Storage Sunrise', 'Slow radiant ambient electronica emerging from archival darkness into sunrise: frozen spectral pads, tiny hard-drive-like ticks used as percussion, warm bass bloom, hopeful major colors, graceful cinematic crescendo. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Recursive Arcade', 'Colorful high-detail IDM with a recursive melodic game: sparkling digital leads, punchy but clean breakbeats, motifs folding into altered versions of themselves, adventurous harmony, exuberant final level. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Autonomous Night Bus', 'Moody cybernetic jazz and downtempo soundtrack for an empty autonomous bus crossing a sleeping city: electric piano chords, brushed machine beat, soft sub-bass, passing neon textures, reflective improvised synth lead. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Firmware Ritual', 'Dark ceremonial modular synthesis built from imaginary firmware update tones: slow tom-like electronic percussion, resonant drones, repeating voltage sequence, controlled distortion, ominous transformation into clear stable harmony. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Open Source Weather', 'Airy bright electronica imagining weather systems designed collaboratively: breezy pads, hand-built sounding percussion, flowing sequencers, generous bass, alternating sunny and stormy passages, communal uplifting finish. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Telemetry Ghosts', 'Minimal dub techno and ambient about forgotten telemetry still crossing space: restrained four-on-the-floor pulse, deep chord echoes, radio-static textures, distant metallic pings, vast patient atmosphere, subtle emotional arc. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Machine Learning to Dance', 'Playful off-kilter electro and glitch groove where a machine gradually learns rhythm: intentionally hesitant opening clicks, increasingly assured drums, rubbery bass, bright synth hooks, joyful fluent finale. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['Serverless Campfire', 'Warm intimate ambient folk-electronic hybrid around an imaginary serverless campfire: plucked synthesized strings, soft crackle-like percussion, mellow analog pads, simple original melody, human-scale quiet and starlit space. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
  ['The Last Turing Test', 'Cinematic experimental electronica for the final unanswered machine-intelligence question: cerebral piano-like synth, shifting odd meter, granular shadows, cybernetic jazz harmony, tension and wonder balancing in an ambiguous luminous ending. Instrumental only; no vocals, speech, lyrics, voice imitation, or recognizable existing melody.'],
].map(([title, prompt], offset) => ({
  index: offset + 1,
  title,
  slug: slugify(title),
  prompt,
}));

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function usage() {
  return `Usage: node scripts/generate-eleven-music.mjs [options]

Generate up to 20 curated, instrumental ElevenLabs Music experiments. Every API
request may be billed and is never automatically retried. ELEVENLABS_API_KEY is
read only for a non-dry run and is never printed or written.

Options:
  --count N                 Number of prompts, from the start (default 20, max 20)
  --duration-seconds N      Requested duration, 3-120 seconds (default 90)
                             90s is song-like while limiting a full batch to
                             30 generated minutes; check account pricing first.
  --output PATH             Relative batch directory strictly beneath music/
  --concurrency N           Simultaneous requests (default 1, max 2)
  --prompt-index SPEC       Exact 1-based prompts, e.g. 2,5,9-12 (repeatable;
                             cannot be combined with --count)
  --dry-run                 Validate and print the plan; make no network request
  --resume [PATH]           Resume manifest in PATH, or in --output when omitted
  --acknowledge-ambiguous N Explicitly regenerate AMBIGUOUS indexes on resume;
                             accepts comma/range syntax and may cause double billing
  --help                    Show this help

Files are never overwritten. A network/stream/provider-5xx/post-response local
failure is AMBIGUOUS and stops the batch without retry. Regeneration requires
 --resume and --acknowledge-ambiguous. Requires ffprobe.`;
}

function parseInteger(raw, flag, min, max) {
  if (!/^\d+$/.test(String(raw ?? ''))) throw new CliError(`${flag} requires an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new CliError(`${flag} must be ${min}-${max}`);
  return value;
}

function parsePromptSpec(raw) {
  const selected = new Set();
  for (const part of String(raw).split(',')) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new CliError(`invalid --prompt-index value: ${part}`);
    const start = parseInteger(match[1], '--prompt-index', 1, PROMPTS.length);
    const end = match[2] ? parseInteger(match[2], '--prompt-index', 1, PROMPTS.length) : start;
    if (end < start) throw new CliError(`invalid descending prompt range: ${part}`);
    for (let value = start; value <= end; value += 1) selected.add(value);
  }
  return selected;
}

function parseArgs(argv) {
  const options = {
    count: 20,
    countSet: false,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    durationSet: false,
    concurrency: 1,
    output: null,
    outputSet: false,
    promptIndexes: new Set(),
    dryRun: false,
    resume: false,
    resumePath: null,
    acknowledgeAmbiguous: new Set(),
    help: false,
  };
  const valueFlags = new Set(['--count', '--duration-seconds', '--output', '--concurrency', '--prompt-index', '--acknowledge-ambiguous']);
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inlineValue;
    const equals = arg.indexOf('=');
    if (equals > 0) {
      inlineValue = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    }
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--resume') {
      options.resume = true;
      if (inlineValue !== undefined) options.resumePath = inlineValue;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) options.resumePath = argv[++i];
    } else if (valueFlags.has(arg)) {
      const raw = inlineValue !== undefined ? inlineValue : argv[++i];
      if (raw === undefined) throw new CliError(`${arg} requires a value`);
      if (arg === '--count') {
        options.count = parseInteger(raw, arg, 1, 20);
        options.countSet = true;
      } else if (arg === '--duration-seconds') {
        options.durationSeconds = parseInteger(raw, arg, 3, 120);
        options.durationSet = true;
      } else if (arg === '--concurrency') options.concurrency = parseInteger(raw, arg, 1, 2);
      else if (arg === '--output') {
        options.output = raw;
        options.outputSet = true;
      } else if (arg === '--prompt-index') {
        for (const value of parsePromptSpec(raw)) options.promptIndexes.add(value);
      } else {
        for (const value of parsePromptSpec(raw)) options.acknowledgeAmbiguous.add(value);
      }
    } else throw new CliError(`unknown option: ${arg}`);
  }
  if (options.promptIndexes.size && options.countSet) {
    throw new CliError('--prompt-index cannot be combined with --count');
  }
  if (options.resumePath && options.outputSet) {
    throw new CliError('use either --resume PATH or --resume --output PATH, not both');
  }
  if (options.resume && !options.resumePath && !options.output) {
    throw new CliError('--resume requires a PATH or --output PATH');
  }
  if (options.acknowledgeAmbiguous.size && !options.resume) {
    throw new CliError('--acknowledge-ambiguous requires --resume');
  }
  return options;
}

class CliError extends Error {}

class SafeError extends Error {
  constructor(code, message, { stopBatch = false, ambiguous = false } = {}) {
    super(message);
    this.code = code;
    this.stopBatch = stopBatch;
    this.ambiguous = ambiguous;
  }
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function resolveOutputPath(input, isResume) {
  const raw = input || path.join('ai-experiments', compactTimestamp());
  // The standalone test harness uses an isolated OS temp directory. Production
  // runs remain constrained to ignored paths below music/.
  const testOutput = process.env.ELEVENLABS_MUSIC_TEST_MODE === '1' && path.isAbsolute(raw);
  if (path.isAbsolute(raw) && !testOutput) throw new CliError('--output and --resume paths must be relative beneath music/');
  const candidate = testOutput ? path.resolve(raw) : path.resolve(MUSIC_ROOT, raw);
  if (testOutput) {
    if (isResume) {
      const info = await stat(candidate).catch(() => null);
      if (!info?.isDirectory()) throw new CliError(`resume directory does not exist: ${candidate}`);
    }
    return candidate;
  }
  if (candidate === MUSIC_ROOT || !candidate.startsWith(`${MUSIC_ROOT}${path.sep}`)) {
    throw new CliError('output must stay strictly beneath the workspace music root');
  }
  const relative = path.relative(MUSIC_ROOT, candidate);
  let current = MUSIC_ROOT;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const info = await lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new CliError('output path must not contain symlink components');
  }
  const ignored = await runProcess('git', ['check-ignore', '-q', '--', path.relative(WORKSPACE_ROOT, candidate)], { cwd: WORKSPACE_ROOT });
  if (ignored.code !== 0) throw new CliError('output path must be gitignored and untracked');
  if (isResume) {
    const info = await stat(candidate).catch(() => null);
    if (!info?.isDirectory()) throw new CliError(`resume directory does not exist: music/${relative}`);
  }
  return candidate;
}

function getApiBase() {
  const override = process.env.ELEVENLABS_MUSIC_TEST_API_BASE;
  if (!override) return OFFICIAL_API_BASE;
  if (process.env.ELEVENLABS_MUSIC_TEST_MODE !== '1') {
    throw new CliError('test API base requires ELEVENLABS_MUSIC_TEST_MODE=1');
  }
  let parsed;
  try {
    parsed = new URL(override);
  } catch {
    throw new CliError('invalid test API base URL');
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (!local || !['http:', 'https:'].includes(parsed.protocol)) throw new CliError('test API base must use a loopback hostname');
  if (parsed.username || parsed.password) throw new CliError('test API base must not contain credentials');
  return parsed.origin;
}

function selectedPrompts(options) {
  const indexes = options.promptIndexes.size
    ? [...options.promptIndexes].sort((a, b) => a - b)
    : PROMPTS.slice(0, options.count).map((prompt) => prompt.index);
  return indexes.map((index) => PROMPTS[index - 1]);
}

function filenameFor(prompt) {
  return `${String(prompt.index).padStart(2, '0')}-${prompt.slug}.mp3`;
}

function createManifest(prompts, durationSeconds, batchId) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    batchId,
    createdAt: now,
    updatedAt: now,
    api: {
      endpoint: '/v1/music',
      modelId: API_MODEL,
      outputFormat: OUTPUT_FORMAT,
      contractReviewedAt: '2026-07-07',
      documentation: DOCS,
    },
    settings: {
      durationSeconds,
      forceInstrumental: true,
      promptIndexes: prompts.map((prompt) => prompt.index),
      nonIdempotentRequests: true,
      automaticRetries: false,
    },
    tracks: prompts.map((prompt) => ({
      index: prompt.index,
      title: prompt.title,
      slug: prompt.slug,
      prompt: prompt.prompt,
      requestedDurationSeconds: durationSeconds,
      actualDurationSeconds: null,
      file: filenameFor(prompt),
      bytes: null,
      sha256: null,
      status: 'PENDING',
      safeErrorCode: null,
      attempts: 0,
      ambiguityAcknowledgements: 0,
      ambiguityAcknowledgedAt: null,
      providerIds: {},
      startedAt: null,
      completedAt: null,
    })),
  };
}

async function atomicWriteJson(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function validateManifest(manifest, prompts, durationSeconds, options) {
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.tracks)) throw new CliError('unsupported or malformed manifest');
  if (manifest.api?.endpoint !== '/v1/music' || manifest.api?.modelId !== API_MODEL || manifest.api?.outputFormat !== OUTPUT_FORMAT) {
    throw new CliError('manifest API contract does not match this script');
  }
  const manifestIndexes = manifest.settings?.promptIndexes;
  const expectedIndexes = prompts.map((prompt) => prompt.index);
  if (options.promptIndexes.size && JSON.stringify(manifestIndexes) !== JSON.stringify(expectedIndexes)) {
    throw new CliError('resume prompt selection does not match manifest');
  }
  if (options.durationSet && manifest.settings?.durationSeconds !== durationSeconds) {
    throw new CliError('resume duration does not match manifest');
  }
  for (const track of manifest.tracks) {
    const canonical = PROMPTS[track.index - 1];
    if (!canonical || track.prompt !== canonical.prompt || track.file !== filenameFor(canonical)) {
      throw new CliError(`manifest prompt ${track.index} no longer matches the curated set`);
    }
    if (track.requestedDurationSeconds !== manifest.settings.durationSeconds) {
      throw new CliError(`manifest duration mismatch for prompt ${track.index}`);
    }
  }
}

async function acquireBatchLock(outputDir) {
  const lockFile = path.join(outputDir, LOCK_NAME);
  let handle;
  try {
    handle = await open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new CliError(`batch is locked: music/${path.relative(MUSIC_ROOT, outputDir)}`);
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(lockFile, { force: true }).catch(() => {});
    throw error;
  }
  return async () => {
    await handle.close().catch(() => {});
    await rm(lockFile, { force: true }).catch(() => {});
  };
}

async function sha256File(file) {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runTrackedProcess(command, args, { signal, activeChildren }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SafeError('interrupted', 'operation interrupted', { stopBatch: true }));
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren?.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const abort = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        killTimer.unref();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      settled = true;
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code, childSignal) => {
      if (settled) return;
      activeChildren?.delete(child);
      signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (signal?.aborted) reject(new SafeError('interrupted', 'operation interrupted', { stopBatch: true }));
      else resolve({ code, signal: childSignal, stdout, stderr });
    });
  });
}

function ffprobeCommand() {
  if (process.env.ELEVENLABS_MUSIC_TEST_MODE === '1' && process.env.ELEVENLABS_MUSIC_TEST_FFPROBE) {
    return process.env.ELEVENLABS_MUSIC_TEST_FFPROBE;
  }
  return 'ffprobe';
}

async function ensureFfprobe({ signal, activeChildren }) {
  const result = await runTrackedProcess(ffprobeCommand(), ['-version'], { signal, activeChildren }).catch((error) => {
    if (error?.code === 'ENOENT') throw new CliError('ffprobe is required before a paid run');
    throw error;
  });
  if (result.code !== 0) throw new CliError('ffprobe preflight failed before any paid request');
}

async function inspectMp3(file, requestedDurationSeconds, processContext) {
  const handle = await open(file, 'r');
  const signature = Buffer.alloc(3);
  try {
    const { bytesRead } = await handle.read(signature, 0, 3, 0);
    const isId3 = bytesRead === 3 && signature.toString('ascii') === 'ID3';
    const isFrame = bytesRead >= 2 && signature[0] === 0xff && (signature[1] & 0xe0) === 0xe0;
    if (!isId3 && !isFrame) throw new SafeError('invalid_mp3_signature', 'download is not an MP3');
  } finally {
    await handle.close();
  }
  let result;
  try {
    result = await runTrackedProcess(ffprobeCommand(), [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,duration:format=duration',
      '-of', 'json', file,
    ], processContext);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SafeError('ffprobe_missing', 'ffprobe is required');
    throw error;
  }
  if (result.code !== 0) throw new SafeError('audio_decode_failed', 'ffprobe could not decode the MP3');
  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch {
    throw new SafeError('audio_probe_invalid', 'ffprobe returned invalid metadata');
  }
  const stream = probe.streams?.find((candidate) => candidate.codec_name === 'mp3');
  const actualDuration = Number(probe.format?.duration ?? stream?.duration);
  if (!stream || !Number.isFinite(actualDuration) || actualDuration <= 0) {
    throw new SafeError('audio_probe_invalid', 'download has no valid MP3 audio stream');
  }
  const tolerance = Math.max(3, requestedDurationSeconds * 0.05);
  if (Math.abs(actualDuration - requestedDurationSeconds) > tolerance) {
    throw new SafeError('duration_mismatch', 'generated duration is outside validation tolerance');
  }
  return actualDuration;
}

function providerIds(headers) {
  const allowlist = [
    'song-id',
    'request-id',
    'x-request-id',
    'generation-id',
    'x-generation-id',
    'history-item-id',
    'trace-id',
    'x-trace-id',
  ];
  const ids = {};
  for (const name of allowlist) {
    const value = headers.get(name);
    if (value && /^[A-Za-z0-9._:-]{1,200}$/.test(value)) ids[name] = value;
  }
  return ids;
}

function classifyHttpStatus(status) {
  if (status === 401) return new SafeError('auth_failed', 'authentication failed', { stopBatch: true });
  if (status === 402) return new SafeError('payment_required', 'payment or credits required', { stopBatch: true });
  if (status === 403) return new SafeError('access_forbidden', 'API access forbidden', { stopBatch: true });
  if (status === 429) return new SafeError('rate_or_quota_limited', 'rate or quota limited', { stopBatch: true });
  if (status >= 500 && status <= 599) return new SafeError(`provider_${status}`, 'provider response is ambiguous', { stopBatch: true, ambiguous: true });
  if (status === 408) return new SafeError('provider_timeout', 'provider response is ambiguous', { stopBatch: true, ambiguous: true });
  if (status === 422) return new SafeError('request_rejected', 'request validation rejected');
  if (status >= 400 && status <= 499) return new SafeError(`terminal_http_${status}`, 'provider rejected request');
  return new SafeError(`unexpected_http_${status}`, 'unexpected provider response', { stopBatch: true, ambiguous: true });
}

async function writeResponseToPart(response, partFile) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new SafeError('response_too_large', 'response exceeds size limit');
  }
  if (process.env.ELEVENLABS_MUSIC_TEST_MODE === '1' && process.env.ELEVENLABS_MUSIC_TEST_DISK_ERROR === '1') {
    throw new SafeError('disk_write_failed', 'test disk write failure');
  }
  let handle;
  try {
    handle = await open(partFile, 'wx', 0o600);
  } catch {
    throw new SafeError('disk_write_failed', 'could not create partial audio file');
  }
  let total = 0;
  try {
    if (!response.body) throw new SafeError('empty_response', 'provider returned no audio body');
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new SafeError('response_too_large', 'response exceeds size limit');
      }
      try {
        await handle.write(value);
      } catch {
        throw new SafeError('disk_write_failed', 'could not write partial audio file');
      }
    }
    try {
      await handle.sync();
    } catch {
      throw new SafeError('disk_write_failed', 'could not sync partial audio file');
    }
  } finally {
    await handle.close();
  }
  if (total === 0) throw new SafeError('empty_response', 'provider returned empty audio');
  return total;
}

async function requestTrack({ apiBase, apiKey, prompt, durationSeconds, partFile, controller }) {
  const endpoint = new URL('/v1/music', apiBase);
  endpoint.searchParams.set('output_format', OUTPUT_FORMAT);
  const body = JSON.stringify({
    prompt: prompt.prompt,
    music_length_ms: durationSeconds * 1000,
    model_id: API_MODEL,
    force_instrumental: true,
    store_for_inpainting: false,
    sign_with_c2pa: false,
  });
  await rm(partFile, { force: true });
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/octet-stream, audio/mpeg',
        'xi-api-key': apiKey,
      },
      body,
      signal: controller.signal,
    });
  } catch {
    const timeout = controller.signal.reason?.code === 'request_timeout';
    throw new SafeError(timeout ? 'request_timeout' : 'network_or_interrupt', 'request outcome is ambiguous', { stopBatch: true, ambiguous: true });
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw classifyHttpStatus(response.status);
  }
  const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!['application/octet-stream', 'audio/mpeg', 'audio/mp3'].includes(contentType)) {
    response.body?.cancel().catch(() => {});
    throw new SafeError('unexpected_content_type', 'provider did not return MP3 audio', { stopBatch: true, ambiguous: true });
  }
  try {
    const bytes = await writeResponseToPart(response, partFile);
    return { bytes, providerIds: providerIds(response.headers) };
  } catch (error) {
    await rm(partFile, { force: true });
    if (error instanceof SafeError) {
      error.ambiguous = true;
      error.stopBatch = true;
      throw error;
    }
    throw new SafeError('response_stream_lost', 'audio response stream was interrupted', { stopBatch: true, ambiguous: true });
  }
}

async function validateCompletedTrack(track, outputDir, processContext) {
  if (track.status !== 'SUCCESS' || !/^[a-f0-9]{64}$/.test(track.sha256 || '')) return false;
  const file = path.join(outputDir, track.file);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size !== track.bytes) return false;
    if (await sha256File(file) !== track.sha256) return false;
    const actual = await inspectMp3(file, track.requestedDurationSeconds, processContext);
    return Math.abs(actual - track.actualDurationSeconds) <= 0.25;
  } catch (error) {
    if (error instanceof SafeError && error.code === 'interrupted') throw error;
    return false;
  }
}

function safeFailure(error) {
  if (error instanceof SafeError) return error;
  return new SafeError('post_request_local_failure', 'unexpected local failure after request', { stopBatch: true, ambiguous: true });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\nTry --help.`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  let apiBase;
  let outputDir;
  try {
    apiBase = getApiBase();
    const outputInput = options.resumePath || options.output;
    outputDir = await resolveOutputPath(outputInput, options.resume);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let prompts = selectedPrompts(options);
  let durationSeconds = options.durationSeconds;
  let previewManifest;
  const manifestFile = path.join(outputDir, MANIFEST_NAME);
  if (options.resume) {
    try {
      previewManifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      if (!options.promptIndexes.size) prompts = previewManifest.tracks.map((track) => PROMPTS[track.index - 1]);
      if (!options.durationSet) durationSeconds = previewManifest.settings.durationSeconds;
      validateManifest(previewManifest, prompts, durationSeconds, options);
    } catch (error) {
      console.error(`Error: cannot resume: ${error.message}`);
      process.exitCode = 2;
      return;
    }
  }

  const estimatedMinutes = (prompts.length * durationSeconds) / 60;
  console.log(`Plan: ${prompts.length} × ${durationSeconds} seconds = ${estimatedMinutes.toFixed(1)} total generated minutes.`);
  console.log(`Model/format: ${API_MODEL} / ${OUTPUT_FORMAT}. Concurrency: ${options.concurrency}.`);
  console.log('PAID-RUN WARNING: exact credits are unknown and plan-dependent; every request may be billed and will not be retried automatically.');
  for (const prompt of prompts) console.log(`  ${String(prompt.index).padStart(2, '0')}. ${prompt.title}`);
  if (options.dryRun) {
    console.log('Dry run complete: no key read, no network request made, and no files written.');
    return;
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('Error: ELEVENLABS_API_KEY is required in the environment.');
    process.exitCode = 2;
    return;
  }

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let releaseLock;
  try {
    releaseLock = await acquireBatchLock(outputDir);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let manifest;
  let writeChain = Promise.resolve();
  const activeControllers = new Set();
  const activeChildren = new Set();
  const partFiles = new Set();
  const batchAbort = new AbortController();
  let stopping = false;
  let signalReceived = null;
  let signalCount = 0;
  let stopReason = null;

  function handleSignal(signal) {
    signalCount += 1;
    if (signalCount > 1) {
      for (const child of activeChildren) child.kill('SIGKILL');
      return;
    }
    signalReceived = signal;
    stopping = true;
    stopReason = 'interrupted';
    console.error(`\n${signal} received; aborting request/validation and cleaning partial files...`);
    batchAbort.abort(new Error('batch interrupted'));
    for (const controller of activeControllers) controller.abort(new Error('batch interrupted'));
    for (const child of activeChildren) child.kill('SIGTERM');
  }
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  function saveManifest() {
    manifest.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(manifest);
    writeChain = writeChain.then(() => atomicWriteJson(manifestFile, snapshot));
    return writeChain;
  }

  try {
    if (options.resume) {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      validateManifest(manifest, prompts, durationSeconds, options);
    } else {
      manifest = createManifest(prompts, durationSeconds, path.basename(outputDir));
    }

    if (!options.resume) {
      let manifestExists = false;
      try {
        await access(manifestFile, fsConstants.F_OK);
        manifestExists = true;
      } catch {}
      if (manifestExists) throw new CliError(`${MANIFEST_NAME} already exists; use --resume. Nothing was overwritten.`);
      await atomicWriteJson(manifestFile, manifest);
    }

    // A crash after request dispatch cannot prove whether generation was billed.
    for (const track of manifest.tracks) {
      if (track.status === 'GENERATING') {
        track.status = 'AMBIGUOUS';
        track.safeErrorCode = 'previous_run_interrupted';
        track.completedAt = new Date().toISOString();
      }
    }
    const ambiguousTracks = manifest.tracks.filter((track) => track.status === 'AMBIGUOUS');
    if (ambiguousTracks.length) {
      const ambiguousIndexes = new Set(ambiguousTracks.map((track) => track.index));
      const unknown = [...options.acknowledgeAmbiguous].filter((index) => !ambiguousIndexes.has(index));
      const missing = [...ambiguousIndexes].filter((index) => !options.acknowledgeAmbiguous.has(index));
      if (unknown.length) throw new CliError(`--acknowledge-ambiguous includes non-AMBIGUOUS index(es): ${unknown.join(',')}`);
      if (missing.length) {
        await saveManifest();
        throw new CliError(`AMBIGUOUS paid outcome for index(es) ${missing.join(',')}; inspect the account, then explicitly acknowledge regeneration`);
      }
      for (const track of ambiguousTracks) {
        track.status = 'PENDING';
        track.ambiguityAcknowledgements = (track.ambiguityAcknowledgements || 0) + 1;
        track.ambiguityAcknowledgedAt = new Date().toISOString();
        track.safeErrorCode = null;
        track.startedAt = null;
        track.completedAt = null;
      }
      await saveManifest();
      console.error(`Acknowledged possible duplicate billing for AMBIGUOUS index(es): ${[...ambiguousIndexes].join(',')}.`);
    } else if (options.acknowledgeAmbiguous.size) {
      throw new CliError('no AMBIGUOUS tracks match --acknowledge-ambiguous');
    }

    await ensureFfprobe({ signal: batchAbort.signal, activeChildren });

    let next = 0;
    let generated = 0;
    let resumed = 0;
    let failed = 0;
    let ambiguous = 0;

    async function processTrack(track) {
      const prefix = `[${String(track.index).padStart(2, '0')}/${PROMPTS.length}]`;
      if (await validateCompletedTrack(track, outputDir, { signal: batchAbort.signal, activeChildren })) {
        resumed += 1;
        console.log(`${prefix} skip valid completed ${track.file}`);
        return;
      }
      if (stopping || batchAbort.signal.aborted) return;
      if (track.status === 'SUCCESS') {
        track.status = 'AMBIGUOUS';
        track.safeErrorCode = 'completed_file_missing_or_invalid';
        track.completedAt = new Date().toISOString();
        ambiguous += 1;
        stopping = true;
        stopReason = track.safeErrorCode;
        await saveManifest();
        console.error(`${prefix} AMBIGUOUS: ${track.safeErrorCode}; explicit acknowledgement required`);
        return;
      }

      const finalFile = path.join(outputDir, track.file);
      const partFile = `${finalFile}.part`;
      partFiles.add(partFile);
      await rm(partFile, { force: true });
      const existing = await stat(finalFile).catch(() => null);
      if (existing) {
        track.status = 'FAILED';
        track.safeErrorCode = 'existing_file_conflict';
        track.completedAt = new Date().toISOString();
        failed += 1;
        await saveManifest();
        console.error(`${prefix} FAILED: existing_file_conflict (nothing overwritten)`);
        partFiles.delete(partFile);
        return;
      }

      track.status = 'GENERATING';
      track.safeErrorCode = null;
      track.startedAt = new Date().toISOString();
      track.completedAt = null;
      track.attempts = (track.attempts || 0) + 1;
      await saveManifest();
      console.log(`${prefix} generating ${track.title} (single non-idempotent request)...`);
      const controller = new AbortController();
      activeControllers.add(controller);
      const forwardAbort = () => controller.abort(batchAbort.signal.reason);
      batchAbort.signal.addEventListener('abort', forwardAbort, { once: true });
      const timeout = setTimeout(() => {
        const reason = new Error('request timeout');
        reason.code = 'request_timeout';
        controller.abort(reason);
      }, process.env.ELEVENLABS_MUSIC_TEST_MODE === '1'
        ? Number(process.env.ELEVENLABS_MUSIC_TEST_TIMEOUT_MS || REQUEST_TIMEOUT_MS)
        : REQUEST_TIMEOUT_MS);
      let responseAccepted = false;
      let createdFinal = false;
      try {
        const prompt = PROMPTS[track.index - 1];
        const response = await requestTrack({
          apiBase,
          apiKey,
          prompt,
          durationSeconds: track.requestedDurationSeconds,
          partFile,
          controller,
        });
        responseAccepted = true;
        if (stopping || controller.signal.aborted) throw new SafeError('interrupted_after_response', 'interrupted after response', { stopBatch: true, ambiguous: true });
        const actualDuration = await inspectMp3(partFile, track.requestedDurationSeconds, { signal: controller.signal, activeChildren });
        if (stopping || controller.signal.aborted) throw new SafeError('interrupted_during_validation', 'interrupted during validation', { stopBatch: true, ambiguous: true });
        const checksum = await sha256File(partFile);
        if (stopping || controller.signal.aborted) throw new SafeError('interrupted_before_finalize', 'interrupted before finalize', { stopBatch: true, ambiguous: true });
        try {
          await link(partFile, finalFile);
          createdFinal = true;
        } catch (error) {
          const code = error?.code === 'EEXIST' ? 'final_file_conflict' : 'finalize_failed';
          throw new SafeError(code, 'could not finalize without overwrite', { stopBatch: true, ambiguous: true });
        }
        await rm(partFile, { force: true });
        if (stopping || controller.signal.aborted) {
          await rm(finalFile, { force: true });
          createdFinal = false;
          throw new SafeError('interrupted_during_finalize', 'interrupted during finalize', { stopBatch: true, ambiguous: true });
        }
        track.status = 'SUCCESS';
        track.safeErrorCode = null;
        track.actualDurationSeconds = Number(actualDuration.toFixed(3));
        track.bytes = response.bytes;
        track.sha256 = checksum;
        track.providerIds = response.providerIds;
        track.completedAt = new Date().toISOString();
        generated += 1;
        await saveManifest();
        console.log(`${prefix} saved ${track.file} (${track.actualDurationSeconds}s, sha256 ${checksum.slice(0, 12)}…)`);
      } catch (rawError) {
        let error = safeFailure(rawError);
        if (responseAccepted && !error.ambiguous) {
          error = new SafeError(error.code, error.message, { stopBatch: true, ambiguous: true });
        }
        if (createdFinal) await rm(finalFile, { force: true }).catch(() => {});
        await rm(partFile, { force: true }).catch(() => {});
        track.status = error.ambiguous ? 'AMBIGUOUS' : 'FAILED';
        track.safeErrorCode = error.code;
        track.completedAt = new Date().toISOString();
        if (error.ambiguous) ambiguous += 1;
        else failed += 1;
        await saveManifest();
        console.error(`${prefix} ${track.status}: ${error.code}${error.ambiguous ? '; explicit acknowledgement required before regeneration' : ''}`);
        if (error.stopBatch) {
          stopping = true;
          stopReason = error.code;
          batchAbort.abort(new Error('batch stopped'));
          for (const active of activeControllers) if (active !== controller) active.abort(new Error('batch stopped'));
        }
      } finally {
        clearTimeout(timeout);
        batchAbort.signal.removeEventListener('abort', forwardAbort);
        activeControllers.delete(controller);
        partFiles.delete(partFile);
        await rm(partFile, { force: true }).catch(() => {});
      }
    }

    async function worker() {
      while (!stopping) {
        const position = next++;
        if (position >= manifest.tracks.length) return;
        await processTrack(manifest.tracks[position]);
      }
    }

    await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
    await writeChain;
    const succeeded = manifest.tracks.filter((track) => track.status === 'SUCCESS').length;
    const requested = manifest.tracks.length;
    console.log(`Summary: ${succeeded}/${requested} complete (${generated} generated, ${resumed} resumed/skipped, ${failed} failed, ${ambiguous} ambiguous).`);
    console.log(`Manifest: music/${path.relative(MUSIC_ROOT, manifestFile)}`);
    if (stopReason) console.error(`Batch stopped safely: ${stopReason}. No automatic retry was attempted.`);
    if (signalReceived) process.exitCode = 130;
    else if (succeeded < requested) process.exitCode = 1;
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}`);
      process.exitCode = 2;
    } else if (error instanceof SafeError && error.code === 'interrupted') {
      console.error('Error: interrupted; no automatic retry was attempted.');
      process.exitCode = 130;
    } else {
      console.error('Error: safe local batch failure; inspect the manifest before any retry.');
      process.exitCode = 1;
    }
  } finally {
    stopping = true;
    batchAbort.abort(new Error('batch cleanup'));
    for (const controller of activeControllers) controller.abort(new Error('batch cleanup'));
    for (const child of activeChildren) child.kill('SIGTERM');
    for (const partFile of partFiles) await rm(partFile, { force: true }).catch(() => {});
    await writeChain.catch(() => {});
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await releaseLock();
  }
}

await main();

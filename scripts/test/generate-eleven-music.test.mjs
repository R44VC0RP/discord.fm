import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const WORKSPACE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SCRIPT = path.join(WORKSPACE, 'scripts', 'generate-eleven-music.mjs');
const TEST_KEY = 'unit-test-key-that-must-never-appear';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function makeMp3Fixture(directory) {
  const file = path.join(directory, 'fixture.mp3');
  const result = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-y', file,
  ]);
  assert.equal(result.code, 0, `ffmpeg fixture failed: ${result.stderr}`);
  return readFile(file);
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function assertContract(req, body) {
  const url = new URL(req.url, 'http://localhost');
  assert.equal(req.method, 'POST');
  assert.equal(url.pathname, '/v1/music');
  assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
  assert.equal(req.headers['xi-api-key'], TEST_KEY);
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(body).sort(), [
    'force_instrumental',
    'model_id',
    'music_length_ms',
    'prompt',
    'sign_with_c2pa',
    'store_for_inpainting',
  ]);
  assert.equal(body.music_length_ms, 3000);
  assert.equal(body.model_id, 'music_v2');
  assert.equal(body.force_instrumental, true);
  assert.equal(body.store_for_inpainting, false);
  assert.equal(body.sign_with_c2pa, false);
  assert.match(body.prompt, /Instrumental only/);
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function runGenerator(output, port, extra = []) {
  const result = await run(process.execPath, [
    SCRIPT,
    '--count', '1',
    '--duration-seconds', '3',
    '--output', output,
    ...extra,
  ], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      ELEVENLABS_API_KEY: TEST_KEY,
      ELEVENLABS_MUSIC_TEST_MODE: '1',
      ELEVENLABS_MUSIC_TEST_API_BASE: `http://127.0.0.1:${port}`,
      ELEVENLABS_MUSIC_TEST_RETRY_BASE_MS: '5',
      ELEVENLABS_MUSIC_TEST_TIMEOUT_MS: '10000',
    },
  });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(TEST_KEY));
  return result;
}

async function assertAtomicDirectory(output) {
  const names = await readdir(output);
  assert.equal(names.some((name) => name.endsWith('.part') || /^\.manifest\..*\.tmp$/.test(name)), false);
  return JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
}

test('success uses the official contract and records safe IDs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eleven-music-success-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = await makeMp3Fixture(root);
  let requests = 0;
  await withServer(async (req, res) => {
    requests += 1;
    const body = await readRequest(req);
    assertContract(req, body);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': audio.length,
      'song-id': 'song_test_123',
      'request-id': 'request_test_456',
      'x-unsafe-header': 'must-not-be-recorded',
    });
    res.end(audio);
  }, async (port) => {
    const output = path.join(root, 'batch');
    const result = await runGenerator(output, port);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests, 1);
    const manifest = await assertAtomicDirectory(output);
    assert.equal(manifest.tracks[0].status, 'SUCCESS');
    assert.equal(manifest.tracks[0].providerIds['song-id'], 'song_test_123');
    assert.equal(manifest.tracks[0].providerIds['request-id'], 'request_test_456');
    assert.equal(manifest.tracks[0].providerIds['x-unsafe-header'], undefined);
    assert.match(manifest.tracks[0].sha256, /^[a-f0-9]{64}$/);
  });
});

test('does not automatically retry a lost response or 429', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eleven-music-retries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = await makeMp3Fixture(root);

  for (const scenario of ['response-loss', 'rate-limit']) {
    let requests = 0;
    await withServer(async (req, res) => {
      requests += 1;
      const body = await readRequest(req);
      assertContract(req, body);
      if (requests === 1 && scenario === 'response-loss') {
        req.socket.destroy();
        return;
      }
      if (requests === 1 && scenario === 'rate-limit') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end('{"detail":"test only"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
      res.end(audio);
    }, async (port) => {
      const output = path.join(root, scenario);
      const result = await runGenerator(output, port);
      assert.equal(result.code, 1, `${scenario}: ${result.stderr}`);
      assert.equal(requests, 1);
      const manifest = await assertAtomicDirectory(output);
      assert.equal(manifest.tracks[0].attempts, 1);
      assert.equal(manifest.tracks[0].status, scenario === 'response-loss' ? 'AMBIGUOUS' : 'FAILED');
    });
  }
});

test('terminal 401 stops without retry and stores only a safe error code', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eleven-music-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  await withServer(async (req, res) => {
    requests += 1;
    await readRequest(req);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"detail":"raw secret-like provider explanation"}');
  }, async (port) => {
    const output = path.join(root, 'batch');
    const result = await runGenerator(output, port);
    assert.equal(result.code, 1);
    assert.equal(requests, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /raw secret-like/);
    const manifest = await assertAtomicDirectory(output);
    assert.equal(manifest.tracks[0].status, 'FAILED');
    assert.equal(manifest.tracks[0].safeErrorCode, 'auth_failed');
    assert.doesNotMatch(JSON.stringify(manifest), /raw secret-like/);
  });
});

test('malformed audio is rejected and leaves no final or part file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eleven-music-malformed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from('ID3not-really-audio'));
  }, async (port) => {
    const output = path.join(root, 'batch');
    const result = await runGenerator(output, port);
    assert.equal(result.code, 1);
    const manifest = await assertAtomicDirectory(output);
    assert.equal(manifest.tracks[0].safeErrorCode, 'audio_decode_failed');
    await assert.rejects(stat(path.join(output, manifest.tracks[0].file)));
  });
});

test('resume checksum-valid output without another request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eleven-music-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = await makeMp3Fixture(root);
  let requests = 0;
  await withServer(async (req, res) => {
    requests += 1;
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': audio.length });
    res.end(audio);
  }, async (port) => {
    const output = path.join(root, 'batch');
    const first = await runGenerator(output, port);
    assert.equal(first.code, 0, first.stderr);
    const second = await run(process.execPath, [
      SCRIPT, '--resume', '--output', output,
    ], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: TEST_KEY,
        ELEVENLABS_MUSIC_TEST_MODE: '1',
        ELEVENLABS_MUSIC_TEST_API_BASE: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /skip valid completed/);
    assert.equal(requests, 1);
    await assertAtomicDirectory(output);
  });
});

test('dry-run makes no request and writes nothing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eleven-music-dry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  await withServer((req, res) => {
    requests += 1;
    res.writeHead(500).end();
  }, async (port) => {
    const output = path.join(root, 'not-created');
    const result = await runGenerator(output, port, ['--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests, 0);
    await assert.rejects(stat(output));
  });
});

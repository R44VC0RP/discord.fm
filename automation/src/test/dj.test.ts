import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DjCoordinator } from '../dj.js';
import { verifyCapturedProviderRequest } from '../dj-contract.js';
import { DJ_TOOL_NAMES, EXPECTED_TOOL_SCHEMA_KEYS, executeDjTool } from '../dj-tools.js';
import { DomainError } from '../errors.js';
import { assertOpenCodeHealth, classifyOpenCodeCompletion, REQUIRED_OPENCODE_VERSION, type DjGateway } from '../opencode.js';
import { testAsset, testFixture } from './helpers.js';
import { createServer } from '../server.js';

function capturedRequest(extra: string[] = [], toolChoice?: unknown): Record<string, unknown> {
  const names = [...DJ_TOOL_NAMES, ...extra];
  return {
    model: 'dj-contract', ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    tools: names.map((name) => ({
      type: 'function',
      function: {
        name, description: name,
        parameters: { type: 'object', additionalProperties: false, properties: Object.fromEntries(((EXPECTED_TOOL_SCHEMA_KEYS as Record<string, readonly string[]>)[name] || []).map((key) => [key, { type: 'string' }])) },
      },
    })),
  };
}

test('provider-boundary contract accepts exactly seven reviewed tools and rejects extras/forced choice', () => {
  assert.doesNotThrow(() => verifyCapturedProviderRequest(capturedRequest()));
  assert.doesNotThrow(() => verifyCapturedProviderRequest(capturedRequest([], 'auto')));
  assert.throws(() => verifyCapturedProviderRequest(capturedRequest(['bash'])), (error) => error instanceof DomainError && error.code === 'DJ_CONTRACT_MISMATCH');
  assert.throws(() => verifyCapturedProviderRequest(capturedRequest([], { type: 'tool', name: 'enqueue_track' })), (error) => error instanceof DomainError && error.code === 'DJ_CONTRACT_MISMATCH');
});

test('pinned OpenCode health rejects version mismatch and unhealthy servers', () => {
  assert.doesNotThrow(() => assertOpenCodeHealth({ healthy: true, version: REQUIRED_OPENCODE_VERSION }));
  assert.throws(() => assertOpenCodeHealth({ healthy: true, version: '1.17.14' }), (error) => error instanceof DomainError && error.code === 'OPENCODE_VERSION_MISMATCH');
  assert.throws(() => assertOpenCodeHealth({ healthy: false, version: REQUIRED_OPENCODE_VERSION }), (error) => error instanceof DomainError && error.code === 'OPENCODE_UNHEALTHY');
});

test('wrapped provider/auth/model and zero-token completions classify as safe failures', () => {
  const envelope = (error?: unknown, tokens = { input: 0, output: 0 }, parts: unknown[] = []) => ({ info: { id: 'msg_1', role: 'assistant', error, tokens, cost: 0 }, parts });
  const cases = [
    [envelope({ name: 'ProviderAuthError', data: { providerID: 'capture', message: 'secret-key-value' } }), 'DJ_PROVIDER_AUTH'],
    [envelope({ name: 'APIError', data: { statusCode: 401, responseBody: 'secret provider body', responseHeaders: { authorization: 'secret' } } }), 'DJ_PROVIDER_AUTH'],
    [envelope({ name: 'APIError', data: { statusCode: 404, responseBody: 'model private response' } }), 'DJ_PROVIDER_MODEL'],
    [envelope({ name: 'UnknownError', data: { message: 'wrapped provider secret-key-value' } }), 'DJ_PROVIDER_ERROR'],
    [envelope(undefined), 'DJ_PROVIDER_EMPTY'],
  ] as const;
  for (const [message, code] of cases) {
    assert.throws(() => classifyOpenCodeCompletion(message, [message]), (error) => {
      assert.ok(error instanceof DomainError); assert.equal(error.code, code);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details || {})}`, /secret|private response|provider body/u);
      return true;
    });
  }
  const noop = classifyOpenCodeCompletion(envelope(undefined, { input: 10, output: 3 }, [{ type: 'text', text: 'No safe changes.' }]), []);
  assert.equal(noop.outcome, 'NOOP'); assert.equal(noop.toolActivity, 0);
  const completed = classifyOpenCodeCompletion(envelope(undefined, { input: 10, output: 3 }, [{ type: 'tool', state: { status: 'completed' } }]), []);
  assert.equal(completed.outcome, 'COMPLETED'); assert.equal(completed.toolActivity, 1);
});

test('checked-in OpenCode config exposes only seven custom tool files and ordered deny/allow rules', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const toolDir = path.join(repo, 'opencode', 'config', 'tools');
  const files = (await fsp.readdir(toolDir)).filter((file) => file.endsWith('.ts')).map((file) => file.slice(0, -3)).sort();
  assert.deepEqual(files, [...DJ_TOOL_NAMES].sort());
  const config = JSON.parse(await fsp.readFile(path.join(repo, 'opencode', 'config', 'opencode.json'), 'utf8')) as { agent: { 'dj-planner': { permission: Record<string, string> } }; provider: { capture: { npm: string } }; mcp?: unknown };
  const permissions = Object.entries(config.agent['dj-planner'].permission);
  assert.deepEqual(permissions[0], ['*', 'deny']);
  assert.deepEqual(permissions.slice(1), DJ_TOOL_NAMES.map((name) => [name, 'allow']));
  assert.equal(config.mcp, undefined);
  assert.equal(config.provider.capture.npm, 'file:///opt/opencode/node_modules/@ai-sdk/openai-compatible/dist/index.js');
  const pkg = JSON.parse(await fsp.readFile(path.join(repo, 'opencode', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual({ cli: pkg.dependencies['opencode-ai'], plugin: pkg.dependencies['@opencode-ai/plugin'], capture: pkg.dependencies['@ai-sdk/openai-compatible'], zen: pkg.dependencies['@ai-sdk/openai'] },
    { cli: '1.17.13', plugin: '1.17.13', capture: '2.0.41', zen: '3.0.53' });
  assert.ok(Object.values(pkg.dependencies).every((version) => !/[~^*]|latest/u.test(version)));
  const compose = await fsp.readFile(path.join(repo, 'docker-compose.yml'), 'utf8');
  const opencodeBlock = compose.slice(compose.indexOf('\n  opencode:'), compose.indexOf('\n  bot:'));
  assert.doesNotMatch(opencodeBlock, /env_file|AUTOMATION_INTERNAL_TOKEN/u);
  assert.match(opencodeBlock, /AUTOMATION_DJ_TOOL_TOKEN/u);
  const gatewaySource = await fsp.readFile(path.join(repo, 'automation', 'src', 'opencode.ts'), 'utf8');
  assert.match(gatewaySource, /async runPrompt[\s\S]*?await this\.verifyContract\(\)/u);
});

test('DJ gateway enforces cadence, revision, strict fields, and shadow rollback', async () => {
  const fixture = await testFixture({ djEnabled: true, generationEnabled: true });
  const lease = fixture.store.acquireDjLease('test_owner', fixture.config.djModel) as { runId: string };
  fixture.store.attachDjSession(lease.runId, 'session_tools');
  const tracks = Array.from({ length: 6 }, (_, index) => testAsset(fixture.store, `dj-track-${index}`, 'music', 60_000, `DJ Artist ${index}`));
  for (let index = 0; index < 5; index++) {
    executeDjTool(fixture.store, fixture.config, 'enqueue_track', { asset_id: tracks[index], expected_queue_revision: index, idempotency_key: `tools:track:${index}` }, 'session_tools');
  }
  assert.throws(() => executeDjTool(fixture.store, fixture.config, 'enqueue_track', { asset_id: tracks[5], expected_queue_revision: 5, idempotency_key: 'tools:track:5' }, 'session_tools'), (error) => error instanceof DomainError && error.code === 'COMMENTARY_DUE');
  const commentary = executeDjTool(fixture.store, fixture.config, 'enqueue_commentary', { script: 'Five records into the anomaly, let us reset the dial.', expected_queue_revision: 5, idempotency_key: 'tools:commentary' }, 'session_tools') as Record<string, unknown>;
  assert.equal(commentary.state, 'GENERATING');
  assert.throws(() => executeDjTool(fixture.store, fixture.config, 'get_queue', { surprise: true }, 'session_tools'), (error) => error instanceof DomainError && error.code === 'UNKNOWN_FIELDS');

  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });

  const shadow = await testFixture({ djEnabled: true, djShadow: true, generationEnabled: true });
  const shadowLease = shadow.store.acquireDjLease('shadow_owner', shadow.config.djModel) as { runId: string };
  shadow.store.attachDjSession(shadowLease.runId, 'session_shadow');
  const track = testAsset(shadow.store, 'shadow-track', 'music', 60_000, 'Shadow Artist');
  const output = executeDjTool(shadow.store, shadow.config, 'enqueue_track', { asset_id: track, expected_queue_revision: 0, idempotency_key: 'shadow:track' }, 'session_shadow') as Record<string, unknown>;
  assert.equal(output.shadow, true); assert.equal(output.accepted, false);
  assert.equal((shadow.store.queueSnapshot().cues as unknown[]).length, 0);
  shadow.store.close(); await fsp.rm(shadow.root, { recursive: true, force: true });
});

test('tool-scoped credential reaches only seven DJ routes and broad token cannot substitute', async () => {
  const fixture = await testFixture({ djEnabled: true, generationEnabled: true, internalToken: 'broad-internal-token-012345678901234', djToolToken: 'scoped-dj-tool-token-0123456789012' });
  const lease = fixture.store.acquireDjLease('http_owner', fixture.config.djModel) as { runId: string };
  fixture.store.attachDjSession(lease.runId, 'session_http_scope');
  const server = createServer(fixture.store, fixture.config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (url: string, token: string, body = '{}', session = 'session_http_scope') => fetch(`${origin}${url}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-opencode-session-id': session }, body });
  assert.equal((await request('/internal/dj/tools/get_queue', fixture.config.djToolToken)).status, 200);
  assert.equal((await fetch(`${origin}/internal/queue/snapshot`, { headers: { authorization: `Bearer ${fixture.config.djToolToken}` } })).status, 401);
  assert.equal((await request('/internal/dj/tools/get_queue', fixture.config.internalToken)).status, 401);
  assert.equal((await request('/internal/dj/tools/get_queue', fixture.config.djToolToken, '{}', 'session_not_leased')).status, 403);
  assert.equal((await request('/internal/dj/capture/v1/chat/completions', fixture.config.djToolToken, JSON.stringify(capturedRequest()))).status, 401);
  assert.equal((await fetch(`${origin}/internal/queue/snapshot`, { headers: { authorization: `Bearer ${fixture.config.internalToken}` } })).status, 200);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

test('daily DJ tool and model budgets fail soft into next-day backoff', async () => {
  const tools = await testFixture({ djEnabled: true, generationEnabled: true, djDailyToolLimit: 1 });
  const lease = tools.store.acquireDjLease('budget_owner', tools.config.djModel) as { runId: string };
  tools.store.attachDjSession(lease.runId, 'session_daily_budget');
  executeDjTool(tools.store, tools.config, 'get_queue', {}, 'session_daily_budget');
  assert.throws(() => executeDjTool(tools.store, tools.config, 'get_queue', {}, 'session_daily_budget'), (error) => error instanceof DomainError && error.code === 'DJ_DAILY_TOOL_BUDGET');
  tools.store.close(); await fsp.rm(tools.root, { recursive: true, force: true });

  const model = await testFixture({ djEnabled: true, generationEnabled: true, djDailyModelTokenLimit: 1000, djCooldownMs: 0 });
  const first = model.store.acquireDjLease('model_owner', model.config.djModel) as { runId: string };
  model.store.finishDjRun(first.runId, 'COMPLETED', { inputTokens: 800, outputTokens: 200 });
  assert.equal(model.store.acquireDjLease('model_owner_2', model.config.djModel), null);
  const state = model.store.db.prepare('SELECT backoff_until,last_result FROM dj_state').get() as { backoff_until: string; last_result: string };
  assert.ok(new Date(state.backoff_until).getTime() > Date.now()); assert.equal(state.last_result, 'DAILY_BUDGET');
  model.store.close(); await fsp.rm(model.root, { recursive: true, force: true });
});

test('DJ coordinator direct tool mutations refill low queue toward high targets', async () => {
  const fixture = await testFixture({ djEnabled: true, generationEnabled: true, lowCueCount: 1, highCueCount: 2, lowHorizonMs: 60_000, targetHorizonMs: 120_000, djCooldownMs: 0 });
  const tracks = [testAsset(fixture.store, 'agent-one', 'music', 60_000, 'Agent One'), testAsset(fixture.store, 'agent-two', 'music', 60_000, 'Agent Two')];
  const gateway: DjGateway = {
    verifyContract: async () => {},
    runPrompt: async (_run, _prompt, onSession) => {
      onSession('session_direct');
      executeDjTool(fixture.store, fixture.config, 'enqueue_track', { asset_id: tracks[0], expected_queue_revision: 0, idempotency_key: 'direct:1' }, 'session_direct');
      executeDjTool(fixture.store, fixture.config, 'enqueue_track', { asset_id: tracks[1], expected_queue_revision: 1, idempotency_key: 'direct:2' }, 'session_direct');
      return { sessionId: 'session_direct', outcome: 'COMPLETED', toolActivity: 2, inputTokens: 20, outputTokens: 10 };
    },
  };
  const coordinator = new DjCoordinator(fixture.store, fixture.config, gateway);
  await coordinator.initialize(); await coordinator.tick();
  const snapshot = fixture.store.queueSnapshot();
  assert.equal(snapshot.ready_count, 2); assert.equal(snapshot.ready_duration_ms, 120_000);
  assert.equal((fixture.store.db.prepare("SELECT state FROM dj_runs").get() as { state: string }).state, 'COMPLETED');
  fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
});

for (const [label, failure] of [['OpenCode down', new Error('connection refused')], ['abort deadline', new DomainError('DJ_TIMEOUT', 'deadline', 504)]] as const) {
  test(`DJ coordinator handles ${label} with durable backoff and deterministic fallback`, async () => {
    const fixture = await testFixture({ djEnabled: true, generationEnabled: true, lowCueCount: 1, highCueCount: 2, lowHorizonMs: 60_000, targetHorizonMs: 120_000 });
    testAsset(fixture.store, `${label}-one`, 'music', 60_000, `${label} One`);
    testAsset(fixture.store, `${label}-two`, 'music', 60_000, `${label} Two`);
    const gateway: DjGateway = { verifyContract: async () => {}, runPrompt: async (_run, _prompt, onSession) => { onSession(`session_${label.replaceAll(' ', '_')}`); throw failure; } };
    const coordinator = new DjCoordinator(fixture.store, fixture.config, gateway);
    await coordinator.tick();
    const state = fixture.store.db.prepare('SELECT backoff_until,failure_count,last_result FROM dj_state').get() as { backoff_until: string; failure_count: number; last_result: string };
    assert.ok(new Date(state.backoff_until).getTime() > Date.now()); assert.equal(state.failure_count, 1); assert.equal(state.last_result, 'FAILED');
    assert.equal(fixture.store.queueSnapshot().ready_count, 2);
    fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
  });
}

for (const code of ['DJ_PROVIDER_AUTH', 'DJ_PROVIDER_MODEL', 'DJ_PROVIDER_ERROR', 'DJ_PROVIDER_EMPTY'] as const) {
  test(`${code} is FAILED with backoff, safe status, cleanup semantics, and no queue mutation`, async () => {
    const fixture = await testFixture({ djEnabled: true, generationEnabled: true, lowCueCount: 1, highCueCount: 2, lowHorizonMs: 60_000, targetHorizonMs: 120_000 });
    testAsset(fixture.store, `${code}-fallback`, 'music', 60_000, `${code} Artist`);
    const gateway: DjGateway = {
      verifyContract: async () => {},
      runPrompt: async (_run, _prompt, onSession) => { onSession(`session_${code}`); throw new DomainError(code, 'wrapped secret provider body must not persist', 502); },
    };
    const coordinator = new DjCoordinator(fixture.store, fixture.config, gateway);
    await coordinator.tick();
    assert.equal((fixture.store.queueSnapshot().cues as unknown[]).length, 0);
    const run = fixture.store.db.prepare('SELECT state,failure_code,input_tokens,output_tokens,tool_calls FROM dj_runs').get() as { state: string; failure_code: string; input_tokens: number | null; output_tokens: number | null; tool_calls: number };
    assert.deepEqual(run, { state: 'FAILED', failure_code: code, input_tokens: null, output_tokens: null, tool_calls: 0 });
    const status = (fixture.store.queueSnapshot().dj as { latest_run: Record<string, unknown>; backoff_until: string });
    assert.equal(status.latest_run.failure_code, code); assert.ok(new Date(status.backoff_until).getTime() > Date.now());
    assert.doesNotMatch(JSON.stringify(status), /secret|provider body/u);
    fixture.store.close(); await fsp.rm(fixture.root, { recursive: true, force: true });
  });
}

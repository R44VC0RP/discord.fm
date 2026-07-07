import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AutomationStore } from './store.js';
import type { AutomationConfig, CueType } from './types.js';
import { CUE_TYPES } from './types.js';
import { DomainError, invariant } from './errors.js';
import { exactObject, id, idempotencyKey, integer, optionalIso, referenceId, tags, text } from './validation.js';
import { ffprobe, importMusic, sha256File } from './importer.js';
import { executeDjTool, isDjToolName } from './dj-tools.js';
import { djContractCapture } from './dj-contract.js';
import { fetchOpenCodeHealth } from './opencode.js';
import type { RerunScheduler } from './rerun-scheduler.js';
import { fakeDjCompletion } from './fake-dj-provider.js';

export function createServer(store: AutomationStore, config: AutomationConfig, reruns?: RerunScheduler): http.Server {
  return http.createServer(async (request, response) => {
    const requestId = crypto.randomUUID();
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-request-id', requestId);
    try {
      const url = new URL(request.url || '/', 'http://automation.internal');
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
      if (request.method === 'GET' && url.pathname === '/readyz') return json(response, 200, store.ready());
      if (request.method === 'POST' && url.pathname === '/internal/dj/capture/v1/chat/completions') {
        authenticateBearer(request, config.opencodePassword, 'DJ_CAPTURE_AUTH_NOT_CONFIGURED');
        const input = await body(request, Math.max(config.maxBodyBytes, 1_048_576));
        const model = input && typeof input === 'object' ? String((input as Record<string, unknown>).model || '') : '';
        if (model === 'dj-auth-401') return json(response, 401, { error: { type: 'authentication_error', message: 'fixture authentication failed' } });
        if (model === 'dj-model-error') return json(response, 404, { error: { type: 'model_error', message: 'fixture model unavailable' } });
        if (model === 'dj-wrapped-error') return json(response, 200, { error: { type: 'provider_error', message: 'fixture wrapped provider failure' } });
        if (model === 'dj-zero-complete') return openAiCompletion(response, {
          id: 'chatcmpl-zero', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }, Boolean((input as { stream?: boolean }).stream));
        return openAiCompletion(response, djContractCapture.capture(input), Boolean((input as { stream?: boolean }).stream));
      }
      if (request.method === 'POST' && url.pathname === '/internal/dj/fake/v1/chat/completions') {
        authenticateBearer(request, config.opencodePassword, 'DJ_FAKE_AUTH_NOT_CONFIGURED');
        invariant(config.djFakeProviderEnabled, 'DJ_FAKE_PROVIDER_DISABLED', 'scripted DJ provider is disabled', 404);
        const fakeInput = await body(request, Math.max(config.maxBodyBytes, 1_048_576));
        const completion = fakeDjCompletion(fakeInput);
        const choice = (completion.choices as Array<{ finish_reason?: string; message?: { tool_calls?: Array<{ function?: { name?: string } }> } }>)[0];
        const messages = (fakeInput as { messages?: Array<Record<string, unknown>> }).messages ?? [];
        process.stdout.write(`${JSON.stringify({ level: 'info', event: 'fake_dj_completion', finish: choice?.finish_reason, tool: choice?.message?.tool_calls?.[0]?.function?.name ?? null, message_count: messages.length })}\n`);
        return openAiCompletion(response, completion, Boolean((fakeInput as { stream?: boolean }).stream));
      }
      const djTool = url.pathname.match(/^\/internal\/dj\/tools\/([a-z_]+)$/u);
      if (request.method === 'POST' && djTool) {
        authenticateBearer(request, config.djToolToken, 'DJ_TOOL_AUTH_NOT_CONFIGURED');
        const toolName = djTool[1] as string;
        invariant(isDjToolName(toolName), 'DJ_TOOL_NOT_FOUND', 'DJ tool does not exist', 404);
        const sessionId = referenceId(request.headers['x-opencode-session-id'], 'x-opencode-session-id');
        return json(response, 200, executeDjTool(store, config, toolName, await body(request, config.maxBodyBytes), sessionId));
      }
      authenticate(request, config);

      if (request.method === 'GET' && url.pathname === '/internal/catalog') {
        const limit = boundedQueryInt(url, 'limit', 50, 1, 100);
        const search = url.searchParams.get('search');
        if (search) text(search, 'search', 200);
        const tagValues = url.searchParams.getAll('tag').map((tag, index) => text(tag, `tag[${index}]`, 48) as string);
        return json(response, 200, store.listCatalog({ limit, cursor: url.searchParams.get('cursor'), search, tags: tagValues }));
      }
      if (request.method === 'GET' && url.pathname === '/internal/admin/catalog') {
        const search = url.searchParams.get('search');
        if (search) text(search, 'search', 200);
        return json(response, 200, store.listCatalogAdmin({
          limit: boundedQueryInt(url, 'limit', 50, 1, 200), cursor: url.searchParams.get('cursor'),
          search, status: url.searchParams.get('status'),
        }));
      }
      const assetLifecycle = url.pathname.match(/^\/internal\/admin\/catalog\/assets\/([a-z][a-z0-9_]{2,79})\/(retire|restore)$/u);
      if (request.method === 'POST' && assetLifecycle) {
        const assetId = id(assetLifecycle[1], 'asset_id');
        const raw = exactObject(await body(request, config.maxBodyBytes), ['expected_queue_revision', 'idempotency_key']);
        const input = {
          assetId,
          expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER),
          idempotencyKey: idempotencyKey(raw.idempotency_key),
        };
        return json(response, 200, assetLifecycle[2] === 'retire' ? store.retireMusicAsset(input) : store.restoreMusicAsset(input));
      }
      const assetAudio = url.pathname.match(/^\/internal\/catalog\/assets\/([a-z][a-z0-9_]{2,79})\/audio$/u);
      if (request.method === 'GET' && assetAudio) {
        return streamAssetAudio(request, response, store, assetAudio[1] as string);
      }
      const assetLookup = url.pathname.match(/^\/internal\/catalog\/assets\/([a-z][a-z0-9_]{2,79})$/u);
      if (request.method === 'GET' && assetLookup) {
        return json(response, 200, store.getAssetSummary(assetLookup[1] as string));
      }
      if (request.method === 'GET' && url.pathname === '/internal/dj/status') {
        return json(response, 200, { ...store.djStatus(), opencode: await fetchOpenCodeHealth(config) });
      }
      if (request.method === 'GET' && url.pathname === '/internal/hotline/review') {
        return json(response, 200, store.listHotlineReview({ limit: boundedQueryInt(url, 'limit', 50, 1, 100), cursor: url.searchParams.get('cursor') }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/hotline/review') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['candidate_id', 'action', 'expected_moderation_version', 'idempotency_key']);
        const action = text(raw.action, 'action', 20) as string;
        invariant(action === 'approve' || action === 'reject' || action === 'restore', 'INVALID_REVIEW_ACTION', 'action must be approve, reject, or restore');
        return json(response, 200, store.reviewHotline({
          candidateId: id(raw.candidate_id, 'candidate_id'), action,
          expectedModerationVersion: integer(raw.expected_moderation_version, 'expected_moderation_version', 1, 1_000_000),
          idempotencyKey: idempotencyKey(raw.idempotency_key),
        }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/catalog/register-upload') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['asset_id', 'title', 'artist', 'tags', 'original_filename']);
        const registered = await registerUpload(store, config, raw);
        return json(response, registered.created ? 201 : 200, registered);
      }
      if (request.method === 'GET' && url.pathname === '/internal/history') return json(response, 200, store.history(boundedQueryInt(url, 'limit', 50, 1, 200)));
      if (request.method === 'GET' && url.pathname === '/internal/history/tracks') return json(response, 200, store.trackHistory(boundedQueryInt(url, 'limit', 50, 1, 200)));
      if (request.method === 'GET' && (url.pathname === '/internal/queue/snapshot' || url.pathname === '/internal/playout/snapshot')) return json(response, 200, store.queueSnapshot());
      if (request.method === 'GET' && url.pathname === '/internal/playout/owned-claim') {
        return json(response, 200, store.ownedClaim(id(url.searchParams.get('worker_id'), 'worker_id')));
      }
      if (request.method === 'GET' && url.pathname === '/internal/hotline/candidates') return json(response, 200, store.listHotlineCandidates({ limit: boundedQueryInt(url, 'limit', 25, 1, 50), cursor: url.searchParams.get('cursor') }));
      if (request.method === 'GET' && url.pathname === '/internal/rerun/state') {
        invariant(reruns, 'RERUN_SCHEDULER_UNAVAILABLE', 'rerun scheduler is unavailable', 503);
        return json(response, 200, await reruns.state());
      }

      if (request.method === 'POST' && url.pathname === '/internal/catalog/import-existing') {
        exactObject(await body(request, config.maxBodyBytes), []);
        return json(response, 200, await importMusic(store, config.musicDir));
      }
      if (request.method === 'POST' && url.pathname === '/internal/maintenance/backup') {
        exactObject(await body(request, config.maxBodyBytes), []);
        return json(response, 201, await store.backup());
      }

      if (request.method === 'POST' && url.pathname === '/internal/queue/tracks') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['asset_id', 'expected_queue_revision', 'idempotency_key', 'transition', 'not_before', 'expires_at', 'source']);
        const transition = raw.transition === undefined ? undefined : exactObject(raw.transition, ['kind', 'duration_ms'], 'transition');
        if (transition) invariant(transition.kind === 'crossfade', 'INVALID_TRANSITION', 'only crossfade is supported');
        return json(response, 201, store.enqueueTrack({
          assetId: id(raw.asset_id, 'asset_id'), expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER),
          idempotencyKey: idempotencyKey(raw.idempotency_key), transitionMs: transition ? integer(transition.duration_ms, 'transition.duration_ms', 500, 10_000) : undefined,
          notBefore: optionalIso(raw.not_before, 'not_before'), expiresAt: optionalIso(raw.expires_at, 'expires_at'), source: optionalSource(raw.source),
        }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/queue/cues') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['type', 'asset_id', 'duration_ms', 'expected_queue_revision', 'idempotency_key', 'not_before', 'expires_at', 'source']);
        invariant(typeof raw.type === 'string' && CUE_TYPES.includes(raw.type as CueType), 'INVALID_CUE_TYPE', 'unsupported cue type');
        return json(response, 201, store.enqueueManualCue({
          type: raw.type as CueType, assetId: raw.asset_id === undefined ? null : id(raw.asset_id, 'asset_id'), durationMs: raw.duration_ms === undefined ? null : integer(raw.duration_ms, 'duration_ms', 1, 86_400_000),
          expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER), idempotencyKey: idempotencyKey(raw.idempotency_key),
          notBefore: optionalIso(raw.not_before, 'not_before'), expiresAt: optionalIso(raw.expires_at, 'expires_at'), source: optionalSource(raw.source),
        }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/queue/commentary') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['script', 'expected_queue_revision', 'idempotency_key', 'not_before', 'expires_at', 'source']);
        return json(response, 202, store.enqueueCommentary({ script: text(raw.script, 'script', 2000) as string, expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER), idempotencyKey: idempotencyKey(raw.idempotency_key), notBefore: optionalIso(raw.not_before, 'not_before'), expiresAt: optionalIso(raw.expires_at, 'expires_at'), source: optionalSource(raw.source) }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/hotline/candidates/register') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['call_id', 'asset_id', 'transcript', 'summary', 'moderation_version', 'allowed_details', 'archived']);
        invariant(raw.archived === undefined || typeof raw.archived === 'boolean', 'INVALID_ARCHIVED', 'archived must be boolean');
        return json(response, 201, store.registerHotline({ callId: referenceId(raw.call_id, 'call_id'), assetId: id(raw.asset_id, 'asset_id'), transcript: (text(raw.transcript, 'transcript', 12_000, false) || '') as string, summary: text(raw.summary, 'summary', 1000, false), moderationVersion: integer(raw.moderation_version, 'moderation_version', 1, 1_000_000), allowedDetails: tags(raw.allowed_details), archived: Boolean(raw.archived) }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/queue/hotline-groups') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['candidate_id', 'moderation_version', 'intro_script', 'outro_script', 'next_track_asset_id', 'expected_queue_revision', 'idempotency_key', 'not_before', 'expires_at', 'source']);
        return json(response, 202, store.enqueueHotlineGroup({ candidateId: id(raw.candidate_id, 'candidate_id'), moderationVersion: integer(raw.moderation_version, 'moderation_version', 1, 1_000_000), introScript: text(raw.intro_script, 'intro_script', 1200) as string, outroScript: text(raw.outro_script, 'outro_script', 1200, false), nextTrackAssetId: id(raw.next_track_asset_id, 'next_track_asset_id'), expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER), idempotencyKey: idempotencyKey(raw.idempotency_key), notBefore: optionalIso(raw.not_before, 'not_before'), expiresAt: optionalIso(raw.expires_at, 'expires_at'), source: optionalSource(raw.source) }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/queue/refill') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['expected_queue_revision', 'idempotency_key']);
        return json(response, 201, store.refillDeterministic({ expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER), idempotencyKey: idempotencyKey(raw.idempotency_key), source: 'deterministic_refill' }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/rerun/queue') {
        invariant(reruns, 'RERUN_SCHEDULER_UNAVAILABLE', 'rerun scheduler is unavailable', 503);
        const raw = exactObject(await body(request, config.maxBodyBytes), ['file']);
        return json(response, 200, await reruns.queue(text(raw.file, 'file', 255) as string));
      }
      if (request.method === 'POST' && url.pathname === '/internal/rerun/unqueue') {
        invariant(reruns, 'RERUN_SCHEDULER_UNAVAILABLE', 'rerun scheduler is unavailable', 503);
        const raw = exactObject(await body(request, config.maxBodyBytes), ['index']);
        return json(response, 200, await reruns.unqueue(integer(raw.index, 'index', 0, 10_000)));
      }
      if (request.method === 'POST' && url.pathname === '/internal/rerun/auto') {
        invariant(reruns, 'RERUN_SCHEDULER_UNAVAILABLE', 'rerun scheduler is unavailable', 503);
        const raw = exactObject(await body(request, config.maxBodyBytes), ['enabled', 'expected_version', 'idempotency_key']);
        invariant(typeof raw.enabled === 'boolean', 'INVALID_AUTO', 'enabled must be boolean');
        return json(response, 200, await reruns.setAuto(
          raw.enabled,
          integer(raw.expected_version, 'expected_version', 1, Number.MAX_SAFE_INTEGER),
          idempotencyKey(raw.idempotency_key),
        ));
      }
      if (request.method === 'POST' && url.pathname === '/internal/generations/complete') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['job_id', 'asset_id', 'expected_queue_revision', 'idempotency_key']);
        return json(response, 200, store.completeGeneration({ jobId: id(raw.job_id, 'job_id'), assetId: id(raw.asset_id, 'asset_id'), expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER), idempotencyKey: idempotencyKey(raw.idempotency_key) }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/playout/claim') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['expected_queue_revision', 'worker_id', 'idempotency_key', 'capabilities']);
        const capabilities = raw.capabilities === undefined ? [] : tags(raw.capabilities);
        return json(response, 200, store.claim({ expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER), workerId: id(raw.worker_id, 'worker_id'), idempotencyKey: idempotencyKey(raw.idempotency_key), capabilities }));
      }
      if (request.method === 'PUT' && url.pathname === '/internal/playout/presence') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['humans', 'observed_at', 'worker_id']);
        const observedAt = optionalIso(raw.observed_at, 'observed_at');
        invariant(observedAt, 'INVALID_TIMESTAMP', 'observed_at is required');
        return json(response, 200, store.presence({ humans: integer(raw.humans, 'humans', 0, 1000), observedAt, workerId: id(raw.worker_id, 'worker_id') }));
      }
      if (request.method === 'PUT' && url.pathname === '/internal/playout/presence-unknown') {
        const raw = exactObject(await body(request, config.maxBodyBytes), ['observed_at', 'worker_id']);
        const observedAt = optionalIso(raw.observed_at, 'observed_at');
        invariant(observedAt, 'INVALID_TIMESTAMP', 'observed_at is required');
        return json(response, 200, store.presenceUnknown({ observedAt, workerId: id(raw.worker_id, 'worker_id') }));
      }
      const match = url.pathname.match(/^\/internal\/playout\/([a-z][a-z0-9_]{2,79})\/(start|heartbeat|complete|interrupt)$/u);
      if (request.method === 'POST' && match) {
        const cueId = match[1] as string; const action = match[2] as string;
        const commonFields = ['expected_queue_revision', 'worker_id', 'claim_token', 'idempotency_key'];
        const raw = exactObject(await body(request, config.maxBodyBytes), action === 'interrupt' ? [...commonFields, 'reason', 'offset_ms'] : action === 'heartbeat' || action === 'complete' ? [...commonFields, 'offset_ms'] : commonFields);
        const common = { expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER), workerId: id(raw.worker_id, 'worker_id'), claimToken: id(raw.claim_token, 'claim_token'), idempotencyKey: idempotencyKey(raw.idempotency_key) };
        if (action === 'start') return json(response, 200, store.start(cueId, common));
        if (action === 'heartbeat') return json(response, 200, store.heartbeat(cueId, { ...common, offsetMs: integer(raw.offset_ms, 'offset_ms', 0, 86_400_000) }));
        if (action === 'complete') return json(response, 200, store.complete(cueId, { ...common, offsetMs: raw.offset_ms === undefined ? undefined : integer(raw.offset_ms, 'offset_ms', 0, 86_400_000) }));
        return json(response, 200, store.interrupt(cueId, { ...common, reason: text(raw.reason, 'reason', 80) as string, offsetMs: integer(raw.offset_ms, 'offset_ms', 0, 86_400_000) }));
      }
      throw new DomainError('NOT_FOUND', 'endpoint not found', 404);
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', 'internal server error', 500);
      if (!(error instanceof DomainError)) process.stderr.write(`${JSON.stringify({ level: 'error', event: 'request_failed', request_id: requestId, error: error instanceof Error ? error.message : String(error) })}\n`);
      json(response, domain.status, { error: { code: domain.code, message: domain.message, details: domain.details }, request_id: requestId });
    }
  });
}

function authenticate(request: IncomingMessage, config: AutomationConfig): void {
  if (config.allowUnauthenticated && !config.internalToken) return;
  authenticateBearer(request, config.internalToken, 'AUTH_NOT_CONFIGURED');
}

function authenticateBearer(request: IncomingMessage, expected: string, unconfiguredCode: string): void {
  invariant(expected, unconfiguredCode, 'authentication is not configured', 503);
  const header = request.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBuffer = Buffer.from(expected); const suppliedBuffer = Buffer.from(supplied);
  const valid = expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
  invariant(valid, 'UNAUTHORIZED', 'invalid internal token', 401);
}

async function body(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0];
  invariant(contentType === 'application/json', 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json', 415);
  const declared = Number(request.headers['content-length'] || 0);
  invariant(!declared || declared <= maxBytes, 'BODY_TOO_LARGE', `request body exceeds ${maxBytes} bytes`, 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new DomainError('BODY_TOO_LARGE', `request body exceeds ${maxBytes} bytes`, 413);
    chunks.push(buffer);
  }
  invariant(size > 0, 'INVALID_JSON', 'request body is required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError('INVALID_JSON', 'request body must be valid JSON'); }
}

/**
 * Registers a staged admin upload. The admin app streamed the bytes to
 * music/originals/<asset_id>.mp3 (server-generated name, never operator
 * input); automation probes, hashes, and catalogs them. Duplicate bytes
 * return the existing asset so the caller can discard the staged copy.
 */
async function registerUpload(store: AutomationStore, config: AutomationConfig, raw: Record<string, unknown>): Promise<{ created: boolean; asset_id: string; duplicate: boolean; title: string; duration_ms: number }> {
  const assetId = text(raw.asset_id, 'asset_id', 80) as string;
  invariant(/^ast_[a-f0-9]{32}$/u.test(assetId), 'INVALID_ID', 'asset_id must be a server-generated ast_<hex32> identifier');
  const title = text(raw.title, 'title', 256, false);
  const artist = text(raw.artist, 'artist', 256, false);
  const uploadTags = tags(raw.tags);
  const originalFilename = text(raw.original_filename, 'original_filename', 256, false);
  const locator = path.join(path.resolve(config.musicDir), 'originals', `${assetId}.mp3`);
  invariant(fs.existsSync(locator), 'UPLOAD_FILE_MISSING', 'staged upload file was not found', 409);
  let probe;
  try {
    probe = await ffprobe(locator);
  } catch (error) {
    throw new DomainError('PROBE_FAILED', `uploaded audio is not decodable: ${error instanceof Error ? error.message.slice(0, 300) : 'probe failed'}`, 422);
  }
  invariant(probe.codecName === 'mp3', 'INVALID_AUDIO', 'uploads must contain MP3 audio', 422);
  const checksum = await sha256File(locator);
  const fallbackTitle = (originalFilename || '').replace(/\.mp3$/iu, '').trim().slice(0, 256);
  const resolvedTitle = title || probe.title || fallbackTitle || 'Untitled';
  const result = store.putAsset({
    id: assetId, kind: 'music', checksum, sourceLocator: locator, playoutLocator: locator,
    title: resolvedTitle, artist: artist ?? probe.artist, album: probe.album, tags: uploadTags,
    durationMs: probe.durationMs, codecName: probe.codecName, sampleRateHz: probe.sampleRateHz,
    channels: probe.channels, bitRate: probe.bitRate, mimeType: probe.mimeType, raw: probe.raw,
    provenance: { source: 'admin_upload', original_filename: originalFilename, license_status: 'UNKNOWN', uploaded_at: new Date().toISOString() },
  });
  return { created: result.created, asset_id: result.assetId, duplicate: !result.created, title: resolvedTitle, duration_ms: probe.durationMs };
}

/** Streams a previewable asset with Range support. The locator never leaves this process; bytes are read O_NOFOLLOW. */
function streamAssetAudio(request: IncomingMessage, response: ServerResponse, store: AutomationStore, assetId: string): void {
  const { locator, sizeBytes } = store.assetAudio(assetId);
  const descriptor = fs.openSync(locator, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let size = sizeBytes;
  try {
    const stat = fs.fstatSync(descriptor);
    invariant(stat.isFile(), 'ASSET_FILE_MISSING', 'asset locator must be a regular file', 409);
    size = stat.size;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Math.min(Number(range[2]), size - 1);
    if (!range[1] && range[2]) { start = Math.max(0, size - Number(range[2])); end = size - 1; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      fs.closeSync(descriptor);
      response.writeHead(416, { 'content-range': `bytes */${size}`, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'requested range is not satisfiable' } }));
      return;
    }
    status = 206;
  }
  const headers: Record<string, string | number> = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': end - start + 1 };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  response.writeHead(status, headers);
  const stream = fs.createReadStream('', { fd: descriptor, start, end, autoClose: true });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

function optionalSource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const source = text(value, 'source', 40) as string;
  invariant(['manual', 'dj_tool', 'admin'].includes(source), 'INVALID_SOURCE', 'source is not allowed');
  return source;
}

function boundedQueryInt(url: URL, name: string, fallback: number, min: number, max: number): number {
  const value = url.searchParams.get(name);
  return value === null ? fallback : integer(Number(value), name, min, max);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

function openAiCompletion(response: ServerResponse, completion: Record<string, unknown>, stream: boolean): void {
  if (!stream) { json(response, 200, completion); return; }
  const choice = (completion.choices as Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: unknown[] } }>)[0] ?? {};
  const message = choice.message ?? {};
  const delta = { role: 'assistant', ...(message.content ? { content: message.content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
  const chunk = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model,
    choices: [{ index: 0, delta, finish_reason: choice.finish_reason ?? 'stop' }], usage: completion.usage };
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

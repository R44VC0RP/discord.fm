import type { AutomationConfig } from './types.js';
import type { AutomationStore } from './store.js';
import { DomainError, invariant } from './errors.js';
import { exactObject, id, idempotencyKey, integer, tags, text } from './validation.js';

export const DJ_TOOL_NAMES = [
  'list_tracks',
  'get_track_history',
  'get_queue',
  'enqueue_track',
  'enqueue_commentary',
  'list_hotline_candidates',
  'enqueue_hotline_group',
] as const;
export type DjToolName = typeof DJ_TOOL_NAMES[number];

const MUTATIONS = new Set<DjToolName>(['enqueue_track', 'enqueue_commentary', 'enqueue_hotline_group']);

export function isDjToolName(value: string): value is DjToolName {
  return (DJ_TOOL_NAMES as readonly string[]).includes(value);
}

export function executeDjTool(store: AutomationStore, config: AutomationConfig, toolName: DjToolName, input: unknown, sessionId: string): unknown {
  invariant(config.djEnabled, 'DJ_DISABLED', 'DJ tools are disabled', 409);
  store.assertDjToolBudget(sessionId, toolName);
  const started = Date.now();
  const preRevision = store.revision();
  let resultCode = 'OK';
  try {
    const execute = () => executeValidated(store, config, toolName, input);
    return config.djShadow && MUTATIONS.has(toolName)
      ? store.shadowMutation(execute as () => Record<string, unknown>)
      : execute();
  } catch (error) {
    resultCode = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
    throw error;
  } finally {
    store.auditDjTool(sessionId, toolName, input, resultCode, preRevision, store.revision(), Date.now() - started);
  }
}

function executeValidated(store: AutomationStore, config: AutomationConfig, toolName: DjToolName, input: unknown): unknown {
  switch (toolName) {
    case 'list_tracks': {
      const raw = exactObject(input, ['cursor', 'limit', 'search', 'tags']);
      const cursor = raw.cursor === undefined ? null : id(raw.cursor, 'cursor');
      const search = text(raw.search, 'search', 200, false);
      return store.listCatalog({ limit: raw.limit === undefined ? 50 : integer(raw.limit, 'limit', 1, 100), cursor, search, tags: tags(raw.tags) });
    }
    case 'get_track_history': {
      const raw = exactObject(input, ['limit']);
      return store.trackHistory(raw.limit === undefined ? 50 : integer(raw.limit, 'limit', 1, 200));
    }
    case 'get_queue':
      exactObject(input, []);
      return store.queueSnapshot();
    case 'enqueue_track': {
      const raw = exactObject(input, ['asset_id', 'expected_queue_revision', 'idempotency_key', 'transition']);
      const transition = raw.transition === undefined ? null : exactObject(raw.transition, ['kind', 'duration_ms'], 'transition');
      if (transition) invariant(transition.kind === 'crossfade', 'INVALID_TRANSITION', 'only crossfade is supported');
      return store.enqueueTrack({
        assetId: id(raw.asset_id, 'asset_id'),
        expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER),
        idempotencyKey: idempotencyKey(raw.idempotency_key),
        transitionMs: transition ? integer(transition.duration_ms, 'transition.duration_ms', 500, 10_000) : config.crossfadeMs,
        source: 'dj_tool',
      });
    }
    case 'enqueue_commentary': {
      const raw = exactObject(input, ['script', 'expected_queue_revision', 'idempotency_key']);
      return store.enqueueCommentary({
        script: text(raw.script, 'script', 2000) as string,
        expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER),
        idempotencyKey: idempotencyKey(raw.idempotency_key), source: 'dj_tool',
      });
    }
    case 'list_hotline_candidates': {
      const raw = exactObject(input, ['cursor', 'limit']);
      return store.listHotlineCandidates({ limit: raw.limit === undefined ? 25 : integer(raw.limit, 'limit', 1, 50), cursor: raw.cursor === undefined ? null : id(raw.cursor, 'cursor') });
    }
    case 'enqueue_hotline_group': {
      const raw = exactObject(input, ['candidate_id', 'moderation_version', 'intro_script', 'outro_script', 'next_track_asset_id', 'expected_queue_revision', 'idempotency_key', 'transition']);
      const transition = raw.transition === undefined ? null : exactObject(raw.transition, ['kind', 'duration_ms'], 'transition');
      if (transition) {
        invariant(transition.kind === 'crossfade', 'INVALID_TRANSITION', 'only crossfade is supported');
        integer(transition.duration_ms, 'transition.duration_ms', 500, 10_000);
      }
      return store.enqueueHotlineGroup({
        candidateId: id(raw.candidate_id, 'candidate_id'),
        moderationVersion: integer(raw.moderation_version, 'moderation_version', 1, 1_000_000),
        introScript: text(raw.intro_script, 'intro_script', 1200) as string,
        outroScript: text(raw.outro_script, 'outro_script', 1200, false),
        nextTrackAssetId: id(raw.next_track_asset_id, 'next_track_asset_id'),
        expectedRevision: integer(raw.expected_queue_revision, 'expected_queue_revision', 0, Number.MAX_SAFE_INTEGER),
        idempotencyKey: idempotencyKey(raw.idempotency_key), source: 'dj_tool',
      });
    }
  }
}

export const EXPECTED_TOOL_SCHEMA_KEYS: Record<DjToolName, readonly string[]> = {
  list_tracks: ['cursor', 'limit', 'search', 'tags'],
  get_track_history: ['limit'],
  get_queue: [],
  enqueue_track: ['asset_id', 'expected_queue_revision', 'idempotency_key', 'transition'],
  enqueue_commentary: ['script', 'expected_queue_revision', 'idempotency_key'],
  list_hotline_candidates: ['cursor', 'limit'],
  enqueue_hotline_group: ['candidate_id', 'moderation_version', 'intro_script', 'outro_script', 'next_track_asset_id', 'expected_queue_revision', 'idempotency_key', 'transition'],
};

import { invariant } from './errors.js';

type Message = { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string } }> };

/** No-credit OpenAI-compatible provider used only by the explicit local E2E flag. */
export function fakeDjCompletion(value: unknown): Record<string, unknown> {
  const body = value as { model?: string; messages?: Message[]; tools?: unknown[] };
  invariant(Array.isArray(body.messages) && Array.isArray(body.tools), 'FAKE_PROVIDER_INVALID', 'fake provider requires messages and tools');
  const toolNameById = new Map<string, string>();
  for (const message of body.messages) for (const call of message.tool_calls ?? []) if (call.id && call.function?.name) toolNameById.set(call.id, call.function.name);
  const results = new Map<string, unknown[]>();
  for (const message of body.messages) {
    if (message.role !== 'tool') continue;
    const name = toolNameById.get(String(message.tool_call_id)); if (!name) continue;
    let parsed: unknown = message.content;
    try { parsed = JSON.parse(String(message.content)); } catch { /* leave diagnostic text untouched */ }
    const values = results.get(name) ?? []; values.push(parsed); results.set(name, values);
  }
  const latest = (name: string) => results.get(name)?.at(-1) as Record<string, unknown> | undefined;
  const call = (name: string, args: Record<string, unknown>) => response(body.model, {
    role: 'assistant', content: null,
    tool_calls: [{ id: `call_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }, 'tool_calls');
  if (!latest('get_queue')) return call('get_queue', {});
  if (!latest('list_tracks')) return call('list_tracks', { limit: 100 });
  if (!latest('get_track_history')) return call('get_track_history', { limit: 20 });

  const queue = latest('get_queue')!;
  const tracks = (latest('list_tracks')?.items ?? []) as Array<{ asset_id?: string }>;
  const cues = (queue.cues ?? []) as Array<{ asset_id?: string; type?: string }>;
  const high = Number((queue.watermarks as { high_count?: number } | undefined)?.high_count ?? 3);
  const revision = Number(queue.queue_revision ?? 0);
  // Refresh after every mutation so the next call uses the committed revision
  // and sees newly queued asset IDs. This also exercises the read tool between
  // exact custom mutation calls as the real planner is instructed to do.
  const mutations = (results.get('enqueue_track')?.length ?? 0) + (results.get('enqueue_commentary')?.length ?? 0);
  const reads = results.get('get_queue')?.length ?? 0;
  if (reads <= mutations) return call('get_queue', {});
  if (Number(queue.tracks_since_commentary ?? 0) >= 3 && !latest('enqueue_commentary')) {
    return call('enqueue_commentary', { script: 'Three records through the static; the anomaly is still holding steady.', expected_queue_revision: revision, idempotency_key: `fake:commentary:${revision}` });
  }
  if (Number(queue.ready_count ?? 0) < high) {
    const used = new Set(cues.map((cue) => cue.asset_id));
    const track = tracks.find((item) => item.asset_id && !used.has(item.asset_id));
    if (track?.asset_id) return call('enqueue_track', { asset_id: track.asset_id, expected_queue_revision: revision, idempotency_key: `fake:track:${revision}`, transition: { kind: 'crossfade', duration_ms: 6000 } });
  }
  return response(body.model, { role: 'assistant', content: 'Queue refill complete; durable station policy accepted the programming.' }, 'stop');
}

function response(model: string | undefined, message: Record<string, unknown>, finishReason: string): Record<string, unknown> {
  return { id: `chatcmpl-fake-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model ?? 'scripted',
    choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
}

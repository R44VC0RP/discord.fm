import { DJ_TOOL_NAMES, EXPECTED_TOOL_SCHEMA_KEYS, type DjToolName } from './dj-tools.js';
import { DomainError, invariant } from './errors.js';

type CapturedRequest = Record<string, unknown>;

export class DjContractCapture {
  private latest: { ok: boolean; error?: string; at: number } | null = null;

  capture(request: unknown): Record<string, unknown> {
    try {
      verifyCapturedProviderRequest(request);
      this.latest = { ok: true, at: Date.now() };
    } catch (error) {
      this.latest = { ok: false, error: error instanceof Error ? error.message : String(error), at: Date.now() };
      throw error;
    }
    const body = request as { model?: string };
    return {
      id: 'chatcmpl-dj-contract', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: body.model || 'dj-contract',
      choices: [{ index: 0, message: { role: 'assistant', content: 'DJ tool contract verified.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  consume(after: number): void {
    invariant(this.latest && this.latest.at >= after, 'DJ_CONTRACT_NOT_CAPTURED', 'OpenCode contract prompt did not reach the local capture provider', 503);
    invariant(this.latest.ok, 'DJ_CONTRACT_MISMATCH', this.latest.error || 'effective tool contract mismatch', 503);
    this.latest = null;
  }
}

export function verifyCapturedProviderRequest(value: unknown): void {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'DJ_CONTRACT_MISMATCH', 'captured provider request must be an object', 503);
  const request = value as CapturedRequest;
  invariant(request.tool_choice === undefined || request.tool_choice === 'auto', 'DJ_CONTRACT_MISMATCH', 'provider request must not force tool_choice', 503);
  const tools = request.tools;
  invariant(Array.isArray(tools), 'DJ_CONTRACT_MISMATCH', 'provider request has no tools array', 503);
  const byName = new Map<string, Record<string, unknown>>();
  for (const raw of tools) {
    invariant(raw && typeof raw === 'object', 'DJ_CONTRACT_MISMATCH', 'provider tool is malformed', 503);
    const item = raw as Record<string, unknown>;
    const fn = (item.function && typeof item.function === 'object' ? item.function : item) as Record<string, unknown>;
    const name = String(fn.name || item.name || '');
    invariant(name && !byName.has(name), 'DJ_CONTRACT_MISMATCH', `duplicate or unnamed provider tool: ${name}`, 503);
    byName.set(name, fn);
  }
  const actual = [...byName.keys()].sort();
  const expected = [...DJ_TOOL_NAMES].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), 'DJ_CONTRACT_MISMATCH', `effective tools differ: ${actual.join(',')}`, 503);
  for (const name of DJ_TOOL_NAMES) {
    const fn = byName.get(name) as Record<string, unknown>;
    const parameters = fn.parameters as Record<string, unknown> | undefined;
    invariant(parameters?.type === 'object', 'DJ_CONTRACT_MISMATCH', `${name} parameters are not an object schema`, 503);
    // v1.17.13's project-tool adapter emits an object schema without
    // additionalProperties. Its Zod adapter strips unknowns, and the
    // automation gateway independently rejects unknown fields exactly.
    invariant(parameters.additionalProperties === undefined || parameters.additionalProperties === false,
      'DJ_CONTRACT_MISMATCH', `${name} schema unexpectedly permits additional properties`, 503);
    const properties = parameters.properties && typeof parameters.properties === 'object' ? Object.keys(parameters.properties as object).sort() : [];
    const expectedKeys = [...EXPECTED_TOOL_SCHEMA_KEYS[name as DjToolName]].sort();
    invariant(JSON.stringify(properties) === JSON.stringify(expectedKeys), 'DJ_CONTRACT_MISMATCH', `${name} schema properties differ`, 503);
  }
}

export const djContractCapture = new DjContractCapture();

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeClient as createOpencodeV2Client, type OpencodeClient as OpencodeV2Client } from '@opencode-ai/sdk/v2/client';
import type { AutomationConfig } from './types.js';
import { DomainError, invariant } from './errors.js';
import { djContractCapture } from './dj-contract.js';

export const REQUIRED_OPENCODE_VERSION = '1.17.13';

export interface DjPromptResult {
  sessionId: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  outcome: 'COMPLETED' | 'NOOP';
  toolActivity: number;
}

export interface DjGateway {
  verifyContract(): Promise<void>;
  runPrompt(runId: string, prompt: string, onSession: (sessionId: string) => void): Promise<DjPromptResult>;
}

export class OpenCodeGateway implements DjGateway {
  private readonly client: OpencodeClient;
  private readonly healthClient: OpencodeV2Client;

  constructor(private readonly config: AutomationConfig) {
    const authorization = `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString('base64')}`;
    const options = { baseUrl: config.opencodeUrl, headers: { authorization }, directory: '/scratch/work' };
    this.client = createOpencodeClient(options);
    this.healthClient = createOpencodeV2Client(options);
  }

  async verifyContract(): Promise<void> {
    const health = await this.healthClient.global.health({ throwOnError: true });
    assertOpenCodeHealth(health.data);
    const existing = await this.client.session.list({ throwOnError: true });
    for (const session of existing.data || []) await this.client.session.delete({ path: { id: session.id } }).catch(() => undefined);
    const started = Date.now();
    const session = await this.client.session.create({ body: { title: 'anomaly.fm DJ contract probe' }, throwOnError: true });
    invariant(session.data?.id, 'OPENCODE_SESSION_FAILED', 'OpenCode did not create a contract session', 503);
    const sessionId = session.data.id;
    try {
      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: 'dj-planner', model: { providerID: 'capture', modelID: 'dj-contract' },
          parts: [{ type: 'text', text: 'Inspect the current station queue and decide whether future programming needs refill.' }],
        },
        signal: AbortSignal.timeout(Math.min(this.config.djTimeoutMs, 30_000)), throwOnError: true,
      });
      djContractCapture.consume(started);
    } finally {
      await this.client.session.delete({ path: { id: sessionId } }).catch(() => undefined);
    }
  }

  async runPrompt(_runId: string, prompt: string, onSession: (sessionId: string) => void): Promise<DjPromptResult> {
    await this.verifyContract();
    const [providerID, ...modelParts] = this.config.djModel.split('/');
    const modelID = modelParts.join('/');
    invariant(providerID && modelID, 'DJ_MODEL_INVALID', 'AUTOMATION_DJ_MODEL must be provider/model', 503);
    const session = await this.client.session.create({ body: { title: `anomaly.fm DJ ${new Date().toISOString()}` }, throwOnError: true });
    invariant(session.data?.id, 'OPENCODE_SESSION_FAILED', 'OpenCode did not create a DJ session', 503);
    const sessionId = session.data.id;
    onSession(sessionId);
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.djTimeoutMs);
    try {
      const response = await this.client.session.prompt({
        path: { id: sessionId },
        body: { agent: 'dj-planner', model: { providerID, modelID }, parts: [{ type: 'text', text: prompt }] },
        signal: controller.signal, throwOnError: true,
      });
      // A tool-using prompt has one assistant message per provider round. The
      // synchronous prompt response describes only the final round, so budget
      // accounting must sum the session before cleanup rather than undercount
      // a multi-tool run as one tiny completion.
      const history = await this.client.session.messages({ path: { id: sessionId }, throwOnError: true });
      return { sessionId, ...classifyOpenCodeCompletion(response.data, history.data) };
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        await this.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
        throw new DomainError('DJ_TIMEOUT', 'OpenCode DJ run exceeded its deadline', 504);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      await this.client.session.delete({ path: { id: sessionId } }).catch(() => undefined);
    }
  }
}

type MessageEnvelope = {
  info?: {
    id?: string;
    role?: string;
    error?: { name?: string; data?: { statusCode?: number } };
    tokens?: { input?: number; output?: number };
    cost?: number;
  };
  parts?: Array<{ type?: string; text?: string; state?: { status?: string } }>;
};

/** Reduce OpenCode's response/session objects to safe accounting fields. Error
 * names/status are allowlisted; provider messages, bodies, headers and keys are
 * never copied into exceptions, logs, status or audit rows. */
export function classifyOpenCodeCompletion(response: unknown, sessionMessages: unknown): Omit<DjPromptResult, 'sessionId'> {
  const envelopes: MessageEnvelope[] = [];
  if (response && typeof response === 'object') envelopes.push(response as MessageEnvelope);
  if (Array.isArray(sessionMessages)) envelopes.push(...sessionMessages.filter((item): item is MessageEnvelope => Boolean(item && typeof item === 'object')));
  const unique = new Map<string, MessageEnvelope>();
  for (const item of envelopes) {
    if (item.info?.role !== 'assistant') continue;
    unique.set(item.info.id || `anonymous:${unique.size}`, item);
  }
  const assistants = [...unique.values()];
  if (!assistants.length) throw new DomainError('DJ_PROVIDER_EMPTY', 'OpenCode returned no assistant completion', 502);
  for (const message of assistants) if (message.info?.error) throw safeProviderError(message.info.error);

  let inputTokens = 0; let outputTokens = 0; let estimatedCostUsd = 0; let toolActivity = 0; let textActivity = 0;
  for (const message of assistants) {
    inputTokens += Number(message.info?.tokens?.input || 0);
    outputTokens += Number(message.info?.tokens?.output || 0);
    estimatedCostUsd += Number(message.info?.cost || 0);
    for (const part of message.parts || []) {
      if (part.type === 'tool' && ['completed', 'error'].includes(String(part.state?.status))) toolActivity++;
      if (part.type === 'text' && String(part.text || '').trim()) textActivity++;
    }
  }
  if (inputTokens + outputTokens === 0 && toolActivity === 0) {
    throw new DomainError('DJ_PROVIDER_EMPTY', textActivity ? 'OpenCode returned an unaccounted zero-token completion' : 'OpenCode returned an empty zero-token completion', 502);
  }
  return { inputTokens, outputTokens, estimatedCostUsd, toolActivity, outcome: toolActivity > 0 ? 'COMPLETED' : 'NOOP' };
}

function safeProviderError(error: { name?: string; data?: { statusCode?: number } }): DomainError {
  if (error.name === 'ProviderAuthError' || error.data?.statusCode === 401 || error.data?.statusCode === 403) {
    return new DomainError('DJ_PROVIDER_AUTH', 'OpenCode provider authentication failed', 502);
  }
  if (error.name === 'MessageAbortedError') return new DomainError('DJ_PROVIDER_ABORTED', 'OpenCode provider message was aborted', 502);
  if (error.name === 'MessageOutputLengthError') return new DomainError('DJ_PROVIDER_OUTPUT_LIMIT', 'OpenCode provider reached its output limit', 502);
  if (error.name === 'APIError' && [400, 404, 422].includes(Number(error.data?.statusCode))) {
    return new DomainError('DJ_PROVIDER_MODEL', 'OpenCode provider rejected the configured model/request', 502);
  }
  return new DomainError('DJ_PROVIDER_ERROR', 'OpenCode provider failed', 502);
}

/** Best-effort health probe for the admin DJ panel. This is itself a public
 * projection boundary: provider/HTTP exception strings are reduced to a
 * closed status enum and never returned, even to the admin proxy. */
export async function fetchOpenCodeHealth(config: AutomationConfig): Promise<{ healthy: boolean; status: 'OK' | 'NOT_CONFIGURED' | 'UNREACHABLE' | 'UPSTREAM_ERROR' | 'UNHEALTHY'; version?: string }> {
  if (!config.opencodePassword) return { healthy: false, status: 'NOT_CONFIGURED' };
  try {
    const authorization = `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString('base64')}`;
    const response = await fetch(`${config.opencodeUrl}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { healthy: false, status: 'UPSTREAM_ERROR' };
    const data = await response.json() as { healthy?: boolean; version?: string };
    const healthy = data.healthy === true;
    const version = typeof data.version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(data.version)
      ? data.version : undefined;
    return { healthy, status: healthy ? 'OK' : 'UNHEALTHY', version };
  } catch {
    return { healthy: false, status: 'UNREACHABLE' };
  }
}

export function assertOpenCodeHealth(value: unknown): void {
  const health = value as { healthy?: boolean; version?: string } | undefined;
  invariant(health?.healthy === true, 'OPENCODE_UNHEALTHY', 'OpenCode health check failed', 503);
  invariant(health.version === REQUIRED_OPENCODE_VERSION, 'OPENCODE_VERSION_MISMATCH', `expected OpenCode ${REQUIRED_OPENCODE_VERSION}, got ${health.version}`, 503);
}

/** Durable queue client and controller. Nothing here runs in the 20ms mixer path. */
import crypto from 'node:crypto';
import { Mixer, type ProgramFrameSource } from './mixer.js';
import { ProgramSource, SilenceSource, verifyProgramAsset } from './program.js';

type CueType = 'music' | 'spoken' | 'hotline' | 'rerun' | 'station_id' | 'silence';
interface ClaimedCue { cue_id: string; type: CueType; planned_duration_ms: number; claim_token: string; claim_expires_at: string; checksum?: string; locator?: string; last_offset_ms?: number; transition?: { kind: 'crossfade'; duration_ms: number } | null; public_metadata?: { title?: string; artist?: string }; }
interface ActiveCue { cue: ClaimedCue; source: ProgramFrameSource & { positionMs?: number; stop?: () => void; stalled?: boolean }; startedAt: number; leaseExpiresAt: number; }
interface PendingSettlement {
  cue: ClaimedCue;
  offsetMs: number;
  leaseExpiresAt: number;
  expectedRevision: number;
  idempotencyKey: string;
  attempts: number;
  revisionConflicts: number;
  timer: NodeJS.Timeout | null;
  abort: AbortController | null;
  abandoned: boolean;
}
interface PendingClaim {
  body: { expected_queue_revision: number; worker_id: string; idempotency_key: string; capabilities: string[] };
  crossfade: boolean;
  reconcileAfter: number;
  attempts: number;
  ambiguities: number;
  revisionConflicts: number;
  nextAttemptAt: number;
}
export interface PlayoutOptions { enabled: boolean; url: string; token: string; assetRoots: string[]; crossfadeMs: number; crossfadeLeadMs?: number; pollMs?: number; claimAmbiguityMs?: number; onStateChange?: () => void; }
export interface PublicPlayoutState { enabled: boolean; available: boolean; current: null | { type: CueType; title: string; artist: string; progress_ms: number; duration_ms: number }; next_depth: number | null; }

class AutomationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); }
  get leaseLost(): boolean { return this.code === 'CLAIM_EXPIRED' || this.code === 'CLAIM_OWNERSHIP'; }
  get transient(): boolean { return this.status === 0 || this.status >= 500 || this.code === 'REVISION_CONFLICT'; }
}
const key = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const MAX_PENDING_SETTLEMENTS = 4;
const SETTLEMENT_RETRY_BASE_MS = 250;
const SETTLEMENT_RETRY_MAX_MS = 4000;
const SETTLEMENT_EXPIRY_GUARD_MS = 50;
const REVISION_RETRY_LIMIT = 2;
const CLAIM_AMBIGUOUS_RETRY_LIMIT = 3;

export class PlayoutController {
  // The API's ID grammar intentionally excludes UUID hyphens.
  private readonly workerId = key('bot');
  private revision = 0;
  private active: ActiveCue | null = null;
  private incoming: ActiveCue | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastPresenceAt = 0;
  private depth: number | null = null;
  private nextType: CueType | null = null;
  private nextTransitionMs: number | null = null;
  private crossfadeTimer: NodeJS.Timeout | null = null;
  private crossfadeTimerCueId: string | null = null;
  private crossfadeTimerDurationMs: number | null = null;
  private crossfadeTimerDueAt = 0;
  private presenceKnown = false;
  private humans = 0;
  private available = true;
  private stationOverlayReserved = false;
  private pendingClaim: PendingClaim | null = null;
  private claimInFlight = false;
  private revisionConflictRetries = 0;
  private revisionConflictRecoveries = 0;
  private revisionConflictExhaustions = 0;
  private readonly pendingSettlements = new Map<string, PendingSettlement>();
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly mixer: Mixer, private readonly opts: PlayoutOptions) {
    mixer.onProgramRetired = (source) => {
      const retired = this.active;
      if (retired?.source === source) this.drained(retired, 'retired');
    };
    mixer.onProgramIncomingEnded = (source) => {
      const incoming = this.incoming;
      if (incoming?.source === source) this.drained(incoming, 'incoming');
    };
    mixer.onProgramEnded = (source) => {
      const active = this.active;
      if (active?.source === source) this.drained(active, 'active');
    };
  }
  get enabled(): boolean { return this.opts.enabled; }
  get conflictStats(): { retries: number; recoveries: number; exhausted: number } {
    return { retries: this.revisionConflictRetries, recoveries: this.revisionConflictRecoveries, exhausted: this.revisionConflictExhaustions };
  }
  publicState(): PublicPlayoutState {
    const cue = this.active; const meta = cue?.cue.public_metadata ?? {};
    return { enabled: this.enabled, available: this.available, current: cue ? { type: cue.cue.type, title: String(meta.title ?? 'automation'), artist: String(meta.artist ?? ''), progress_ms: this.offset(cue), duration_ms: cue.cue.planned_duration_ms } : null, next_depth: this.depth };
  }
  start(): void {
    if (!this.enabled || this.timer) return;
    this.stopped = false; void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 1000);
    this.heartTimer = setInterval(() => void this.heartbeat(), 10_000);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer); if (this.heartTimer) clearInterval(this.heartTimer);
    this.clearCrossfadeDeadline();
    this.timer = null; this.heartTimer = null;
    for (const pending of this.pendingSettlements.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.abort?.abort();
    }
    this.pendingSettlements.clear();
    this.pendingClaim = null;
    void this.run(() => this.loseLease('BOT_STOP'));
  }
  async setPresence(humans: number): Promise<void> {
    if (!this.enabled) return;
    this.presenceKnown = true; this.humans = humans;
    this.mixer.setAutomationDucked(humans > 0);
    const observed = Math.max(Date.now(), this.lastPresenceAt + 1); this.lastPresenceAt = observed;
    try { await this.request('PUT', '/internal/playout/presence', { humans, observed_at: new Date(observed).toISOString(), worker_id: this.workerId }); this.changed(); }
    catch (error) { this.warn('presence update failed', error); throw error; }
  }
  setPresenceUnknown(): void {
    if (!this.enabled) return;
    this.presenceKnown = false;
    const observed = Math.max(Date.now(), this.lastPresenceAt + 1); this.lastPresenceAt = observed;
    void this.request('PUT', '/internal/playout/presence-unknown', { observed_at: new Date(observed).toISOString(), worker_id: this.workerId }).catch((error) => this.warn('presence unknown update failed', error));
  }
  /** Existing hourly ident is a station overlay, never a second queued speech owner. */
  canAirStationOverlay(): boolean {
    return !this.stationOverlayReserved && !this.claimInFlight && !this.pendingClaim && this.presenceKnown && this.humans === 0 && this.pendingSettlements.size === 0
      && !this.incoming && (!this.active || ['music', 'rerun'].includes(this.active.cue.type))
      && !['spoken', 'hotline', 'station_id'].includes(this.nextType ?? 'music');
  }
  reserveStationOverlay(): (() => void) | null {
    if (!this.canAirStationOverlay()) return null;
    this.stationOverlayReserved = true; this.changed();
    let released = false;
    return () => { if (released) return; released = true; this.stationOverlayReserved = false; this.changed(); void this.tick(); };
  }
  async rerunState(): Promise<Record<string, unknown>> { return this.request('GET', '/internal/rerun/state') as Promise<Record<string, unknown>>; }
  async queueRerun(file: string): Promise<Record<string, unknown>> { return this.request('POST', '/internal/rerun/queue', { file }) as Promise<Record<string, unknown>>; }
  async unqueueRerun(index: number): Promise<Record<string, unknown>> { return this.request('POST', '/internal/rerun/unqueue', { index }) as Promise<Record<string, unknown>>; }
  async setRerunAuto(enabled: boolean, expectedVersion: number, idempotencyKey: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/internal/rerun/auto', { enabled, expected_version: expectedVersion, idempotency_key: idempotencyKey }) as Promise<Record<string, unknown>>;
  }
  async skipRerun(): Promise<Record<string, unknown>> {
    await this.run(async () => {
      const active = this.active;
      if (!active || active.cue.type !== 'rerun') return;
      // Reuse the same lease-aware, revision-refreshing settlement path as a
      // natural decoder drain. Skip marks the rerun played even under a
      // transient response loss instead of accidentally resuming it later.
      this.mixer.setProgramSource(null);
      this.drained(active, 'active');
    });
    return this.rerunState();
  }

  /** Serialized so a heartbeat cannot race a claim/start/complete revision. */
  private run(work: () => Promise<void>): Promise<void> {
    const next = this.serial.then(work, work);
    this.serial = next.catch(() => {});
    return next;
  }
  private async tick(): Promise<void> { return this.run(async () => {
    if (this.stopped || !this.presenceKnown || this.stationOverlayReserved) return;
    if (this.hasStalledDecoder()) { await this.loseLease('DECODER_STALLED'); return; }
    // A drained predecessor settles before an ambiguously claimed successor is
    // recovered, preserving strict cue/group order even if the source ended
    // while the claim response was unavailable.
    if (this.pendingSettlements.size > 0) return;
    if (this.pendingClaim) {
      this.claimInFlight = true;
      try {
        const recovered = await this.resolvePendingClaim();
        if (!recovered) return;
        await this.openAndStartClaim(recovered.cue, recovered.crossfade);
      } finally { this.claimInFlight = false; }
      return;
    }
    await this.snapshot();
    if (this.active) this.changed(); // publish bounded one-second progress
    this.scheduleCrossfadeDeadline();
    // A pending terminal transition is an ordering barrier. Continue audio
    // already admitted into the mixer, but do not claim farther into a group
    // until the server confirms (or reconciles) its predecessor.
    if (!this.active) await this.claimAndStart(false);
    else if (!this.incoming && this.active.cue.type === 'music' && this.nextType === 'music' && this.offset(this.active) >= Math.max(0, this.active.cue.planned_duration_ms - this.nextCrossfadeMs())) await this.claimAndStart(true);
  }).catch((error) => this.warn('playout tick failed; safety bed remains active', error)); }

  private async snapshot(timeoutMs = 5000, signal?: AbortSignal): Promise<void> {
    const state = await this.request('GET', '/internal/playout/snapshot', undefined, timeoutMs, signal) as { queue_revision?: number; ready_count?: number; cues?: Array<{ state?: string; type?: CueType; transition?: { kind?: string; duration_ms?: number } | null }> };
    const before = `${this.revision}:${this.depth}:${this.nextType}:${this.available}`;
    this.revision = Number(state.queue_revision ?? this.revision);
    this.depth = Number.isFinite(state.ready_count) ? Number(state.ready_count) : null;
    const next = state.cues?.find((cue) => cue.state === 'READY');
    this.nextType = next?.type ?? null;
    this.nextTransitionMs = next?.type === 'music' && next.transition?.kind === 'crossfade' && Number.isFinite(next.transition.duration_ms)
      ? Math.min(10_000, Math.max(500, Number(next.transition.duration_ms))) : null;
    this.available = true;
    if (before !== `${this.revision}:${this.depth}:${this.nextType}:${this.available}`) this.changed();
  }
  private async claimAndStart(crossfade: boolean): Promise<void> {
    if (this.claimInFlight || this.stopped) return;
    this.claimInFlight = true;
    const claimKey = key('claim');
    const attempt: PendingClaim = {
      body: { expected_queue_revision: this.revision, worker_id: this.workerId, idempotency_key: claimKey, capabilities: ['finite_pcm', 'crossfade_v1'] },
      crossfade, reconcileAfter: Date.now() + (this.opts.claimAmbiguityMs ?? 30_000), attempts: 0, ambiguities: 0, revisionConflicts: 0, nextAttemptAt: 0,
    };
    try {
      const result = await this.executeClaimAttempt(attempt);
      if (!result) return;
      await this.openAndStartClaim(result.cue, result.crossfade);
    } finally { this.claimInFlight = false; }
  }
  private async openAndStartClaim(cue: ClaimedCue | null, requestedCrossfade: boolean): Promise<void> {
    if (!cue) return;
    if (this.stopped) {
      await this.interrupt({ cue, source: new SilenceSource(1), startedAt: Date.now(), leaseExpiresAt: this.lease(cue) }, 'BOT_STOP');
      return;
    }
    // A crossfade claim may be recovered after its predecessor drained. Never
    // violate the settlement barrier or require a now-missing outgoing deck.
    const crossfade = requestedCrossfade && this.active !== null;
    let source: ActiveCue['source']; let active: ActiveCue | null = null;
    try {
      if (cue.type === 'silence') {
        source = new SilenceSource(cue.planned_duration_ms);
      } else {
        if (!cue.locator || !cue.checksum) throw new Error('asset claim lacks immutable locator/checksum');
        const verified = await verifyProgramAsset(cue.locator, cue.checksum, this.opts.assetRoots);
        const decoder = new ProgramSource(verified.path, cue.type === 'music' || cue.type === 'rerun' ? Number(cue.last_offset_ms ?? 0) : 0);
        decoder.onError = () => { if (active) void this.run(() => this.loseLease('DECODER_ERROR')); };
        await decoder.start(); source = decoder;
      }
    } catch (error) {
      const failed: ActiveCue = { cue, source: new SilenceSource(1), startedAt: Date.now(), leaseExpiresAt: this.lease(cue) };
      await this.interrupt(failed, 'ASSET_VALIDATION_FAILED'); throw error;
    }
    active = { cue, source, startedAt: Date.now(), leaseExpiresAt: this.lease(cue) };
    if (this.stopped) { source.stop?.(); await this.interrupt(active, 'BOT_STOP'); return; }
    const speech = !['music', 'rerun', 'silence'].includes(cue.type);
    // Decide synchronously before lifecycle start, so a spoken cue cannot be
    // terminally transitioned to PLAYING and then rejected by a busy mixer.
    if (!this.mixer.canAttachProgram(crossfade, speech)) { source.stop?.(); await this.interrupt(active, 'MIXER_SLOT_UNAVAILABLE'); return; }
    try {
      const startKey = key('start');
      const started = await this.withRevisionRetry(`start ${cue.cue_id}`, () => this.request('POST', `/internal/playout/${cue.cue_id}/start`, {
        expected_queue_revision: this.revision, worker_id: this.workerId, claim_token: cue.claim_token, idempotency_key: startKey,
      }) as Promise<{ queue_revision?: number }>);
      this.revision = Number(started.queue_revision ?? this.revision);
    } catch (error) { source.stop?.(); await this.interrupt(active, 'START_ACK_FAILED'); throw error; }
    if (this.stopped) { source.stop?.(); await this.interrupt(active, 'BOT_STOP'); return; }
    const attached = crossfade ? this.mixer.crossfadeProgramSource(source, this.crossfadeMsForCue(cue), speech) : this.mixer.setProgramSource(source, speech);
    if (!attached) { source.stop?.(); await this.interrupt(active, 'MIXER_SLOT_UNAVAILABLE'); return; }
    if (crossfade) { this.incoming = active; this.clearCrossfadeDeadline(); }
    else {
      this.active = active;
      if (cue.type === 'music') {
        const cueId = cue.cue_id;
        queueMicrotask(() => void this.run(async () => {
          if (this.stopped || this.active?.cue.cue_id !== cueId || this.incoming) return;
          await this.snapshot();
          this.scheduleCrossfadeDeadline();
        }).catch((error) => this.warn('crossfade discovery failed; normal polling remains armed', error)));
      }
    }
    this.changed();
  }
  private async executeClaimAttempt(attempt: PendingClaim): Promise<{ cue: ClaimedCue | null; crossfade: boolean } | null> {
    for (;;) {
      try {
        attempt.attempts += 1;
        const result = await this.request('POST', '/internal/playout/claim', attempt.body) as { queue_revision?: number; cue?: ClaimedCue | null };
        this.revision = Number(result.queue_revision ?? this.revision);
        this.pendingClaim = null;
        if (attempt.revisionConflicts > 0) {
          this.revisionConflictRecoveries += 1;
          this.info(`claim recovered after ${attempt.revisionConflicts} revision refresh${attempt.revisionConflicts === 1 ? '' : 'es'}`);
        }
        if (attempt.ambiguities > 0) this.info(`claim response ambiguity recovered by idempotent replay after ${attempt.attempts} attempts`);
        const cue = result.cue ?? null;
        if (cue && this.lease(cue) <= Date.now() + 250) {
          // Cached idempotency responses outlive claim leases. Ask the owned
          // claim endpoint to reconcile rather than starting stale audio.
          return this.reconcileOwnedClaim(attempt);
        }
        return { cue, crossfade: attempt.crossfade };
      } catch (error) {
        if (error instanceof AutomationError && error.code === 'REVISION_CONFLICT') {
          // An explicit CAS rejection proves this exact request did not commit,
          // so changing only expected_revision under the same logical key is
          // safe (there is no stored idempotency hash yet).
          attempt.revisionConflicts += 1;
          this.revisionConflictRetries += 1;
          if (attempt.revisionConflicts > REVISION_RETRY_LIMIT) { this.revisionConflictExhaustions += 1; throw error; }
          await this.snapshot();
          attempt.body = { ...attempt.body, expected_queue_revision: this.revision };
          continue;
        }
        if (!(error instanceof AutomationError) || !(error.status === 0 || error.status >= 500)) throw error;
        attempt.ambiguities += 1;
        this.pendingClaim = attempt;
        const backoff = Math.min(4000, 250 * (2 ** Math.max(0, attempt.attempts - 1)));
        attempt.nextAttemptAt = Date.now() + backoff;
        if (attempt.attempts === 1) this.info('claim response ambiguous; holding order and replaying the same logical request');
        return null;
      }
    }
  }
  private async resolvePendingClaim(): Promise<{ cue: ClaimedCue | null; crossfade: boolean } | null> {
    const attempt = this.pendingClaim;
    if (!attempt) return null;
    if (Date.now() < attempt.nextAttemptAt) return null;
    if (attempt.ambiguities < CLAIM_AMBIGUOUS_RETRY_LIMIT && Date.now() < attempt.reconcileAfter) return this.executeClaimAttempt(attempt);
    return this.reconcileOwnedClaim(attempt);
  }
  private async reconcileOwnedClaim(attempt: PendingClaim): Promise<{ cue: ClaimedCue | null; crossfade: boolean } | null> {
    try {
      const result = await this.request('GET', `/internal/playout/owned-claim?worker_id=${encodeURIComponent(this.workerId)}`) as { cue?: ClaimedCue | null; queue_revision?: number };
      this.revision = Number(result.queue_revision ?? this.revision);
      this.pendingClaim = null;
      if (result.cue) this.info('claim response ambiguity recovered from owned claim reconciliation');
      else this.info('claim response ambiguity reconciled with no owned claim; claiming may resume');
      return { cue: result.cue ?? null, crossfade: attempt.crossfade };
    } catch (error) {
      // No fresh claim is permitted until the server can prove this worker owns
      // none. Keep the looping bed and retry reconciliation at bounded cadence.
      attempt.nextAttemptAt = Date.now() + 4000;
      this.pendingClaim = attempt;
      if (!(error instanceof AutomationError) || error.status < 500 && error.status !== 0) throw error;
      return null;
    }
  }
  /** Mixer callbacks synchronously release audio ownership; HTTP settles later. */
  private drained(active: ActiveCue, slot: 'active' | 'incoming' | 'retired'): void {
    const offsetMs = Math.min(this.offset(active), active.cue.planned_duration_ms + 30_000);
    if (slot === 'incoming') {
      if (this.incoming !== active) return;
      this.incoming = null;
    } else {
      if (this.active !== active) return;
      this.active = slot === 'retired' ? this.incoming : null;
      this.incoming = null;
    }
    this.clearCrossfadeDeadline();
    active.source.stop?.();
    if (this.stopped) return;
    if (this.pendingSettlements.has(active.cue.cue_id)) return;
    if (this.pendingSettlements.size >= MAX_PENDING_SETTLEMENTS) {
      this.severe(`completion settlement cap exceeded; abandoning ${active.cue.cue_id}`, new Error('pending settlement cap reached'));
      void this.tick();
      return;
    }
    const pending: PendingSettlement = {
      cue: active.cue,
      offsetMs,
      leaseExpiresAt: active.leaseExpiresAt,
      expectedRevision: this.revision,
      idempotencyKey: key('complete'),
      attempts: 0,
      revisionConflicts: 0,
      timer: null,
      abort: null,
      abandoned: false,
    };
    this.pendingSettlements.set(active.cue.cue_id, pending);
    this.changed();
    if (this.pendingSettlements.size === 1) this.scheduleSettlement(pending, 0);
    void this.tick();
  }
  private scheduleSettlement(pending: PendingSettlement, delayMs: number): void {
    if (this.stopped || this.pendingSettlements.get(pending.cue.cue_id) !== pending || this.pendingSettlements.values().next().value !== pending) return;
    const available = pending.leaseExpiresAt - Date.now() - SETTLEMENT_EXPIRY_GUARD_MS;
    if (available <= 0) { this.expireSettlement(pending); return; }
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.run(() => this.trySettlement(pending));
    }, Math.min(Math.max(0, delayMs), available));
    pending.timer.unref();
  }
  private async trySettlement(pending: PendingSettlement): Promise<void> {
    if (this.stopped || pending.abandoned || this.pendingSettlements.get(pending.cue.cue_id) !== pending) return;
    const available = pending.leaseExpiresAt - Date.now() - SETTLEMENT_EXPIRY_GUARD_MS;
    if (available <= 0) { this.expireSettlement(pending); return; }
    pending.attempts += 1;
    pending.abort = new AbortController();
    try {
      const result = await this.request('POST', `/internal/playout/${pending.cue.cue_id}/complete`, {
        expected_queue_revision: pending.expectedRevision,
        worker_id: this.workerId,
        claim_token: pending.cue.claim_token,
        idempotency_key: pending.idempotencyKey,
        offset_ms: pending.offsetMs,
      }, Math.min(5000, available), pending.abort.signal) as { queue_revision?: number };
      const revision = Number(result.queue_revision);
      if (!Number.isFinite(revision)) throw new AutomationError('MALFORMED_RESPONSE', 'complete response omitted queue revision', 200);
      this.revision = revision;
      if (pending.revisionConflicts > 0) {
        this.revisionConflictRecoveries += 1;
        this.info(`complete ${pending.cue.cue_id} recovered after ${pending.revisionConflicts} revision refresh${pending.revisionConflicts === 1 ? '' : 'es'}`);
      }
      this.finishSettlement(pending);
      this.changed();
      return;
    } catch (error) {
      if (this.stopped || this.pendingSettlements.get(pending.cue.cue_id) !== pending) return;
      if (error instanceof AutomationError && error.code === 'REVISION_CONFLICT') {
        pending.revisionConflicts += 1;
        this.revisionConflictRetries += 1;
        if (pending.revisionConflicts > REVISION_RETRY_LIMIT) {
          this.revisionConflictExhaustions += 1;
          this.abandonSettlement(pending, 'completion revision retry limit exceeded', error);
          return;
        }
        try {
          const refreshWindow = pending.leaseExpiresAt - Date.now() - SETTLEMENT_EXPIRY_GUARD_MS;
          if (refreshWindow <= 0) { this.expireSettlement(pending); return; }
          await this.snapshot(Math.min(5000, refreshWindow), pending.abort.signal);
          // An explicit conflict is guaranteed not to have persisted an
          // idempotency result, so the logical key stays stable while only the
          // expected revision advances. Ambiguous network retries change neither.
          pending.expectedRevision = this.revision;
        } catch (refreshError) {
          if (!(refreshError instanceof AutomationError) || !refreshError.transient) {
            this.abandonSettlement(pending, 'revision refresh permanently failed', refreshError);
            return;
          }
        }
        // Explicit CAS rejection guarantees no lifecycle mutation or stored
        // idempotency result. Retry immediately with the same logical key and
        // refreshed revision; transport ambiguity still uses backoff below.
        this.scheduleSettlement(pending, 0);
        return;
      }
      if (error instanceof AutomationError && error.transient) {
        this.retrySettlement(pending, error);
        return;
      }
      this.abandonSettlement(pending, 'completion permanently rejected', error);
      return;
    } finally {
      pending.abort = null;
    }
  }
  private retrySettlement(pending: PendingSettlement, error: unknown): void {
    const delay = Math.min(SETTLEMENT_RETRY_MAX_MS, SETTLEMENT_RETRY_BASE_MS * (2 ** Math.max(0, pending.attempts - 1)));
    if (Date.now() + delay >= pending.leaseExpiresAt - SETTLEMENT_EXPIRY_GUARD_MS) {
      this.expireSettlement(pending);
      return;
    }
    this.warn(`completion retry ${pending.attempts} scheduled for ${pending.cue.cue_id}`, error);
    this.scheduleSettlement(pending, delay);
  }
  private finishSettlement(pending: PendingSettlement): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingSettlements.delete(pending.cue.cue_id);
    this.scheduleNextSettlement();
    void this.tick();
  }
  private expireSettlement(pending: PendingSettlement): void {
    if (this.pendingSettlements.get(pending.cue.cue_id) !== pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.abort?.abort();
    this.pendingSettlements.delete(pending.cue.cue_id);
    this.severe(`completion lease expired; server reconciliation required for ${pending.cue.cue_id}`, new Error('completion unconfirmed'));
    this.scheduleNextSettlement();
    void this.tick();
  }
  private scheduleNextSettlement(): void {
    const next = this.pendingSettlements.values().next().value as PendingSettlement | undefined;
    if (next && !next.abandoned) this.scheduleSettlement(next, 0);
  }
  private abandonSettlement(pending: PendingSettlement, message: string, error: unknown): void {
    pending.abandoned = true;
    pending.abort?.abort();
    this.severe(`${message} for ${pending.cue.cue_id}`, error);
    // Keep an ordering barrier but issue no more requests or heartbeats. At
    // local lease expiry, snapshot reconciliation can safely release it.
    this.scheduleAbandonedExpiry(pending);
  }
  private scheduleAbandonedExpiry(pending: PendingSettlement): void {
    if (pending.timer) clearTimeout(pending.timer);
    const delay = Math.max(0, pending.leaseExpiresAt - Date.now());
    pending.timer = setTimeout(() => this.expireSettlement(pending), delay);
    pending.timer.unref();
  }
  private async heartbeat(): Promise<void> { return this.run(async () => {
    if (!this.enabled || this.stopped) return;
    if (this.hasStalledDecoder()) { await this.loseLease('DECODER_STALLED'); return; }
    for (const cue of [this.active, this.incoming]) if (cue) await this.heartbeatOne(cue);
  }).catch((error) => this.warn('heartbeat failed', error)); }
  private async heartbeatOne(active: ActiveCue): Promise<void> {
    if (Date.now() >= active.leaseExpiresAt) { await this.loseLease('LEASE_EXPIRED_LOCAL'); return; }
    try {
      const heartbeatKey = key('heartbeat');
      await this.withRevisionRetry(`heartbeat ${active.cue.cue_id}`, () => this.heartbeatRequest(active, heartbeatKey));
    } catch (error) {
      if (error instanceof AutomationError && error.leaseLost) { await this.loseLease('LEASE_LOST'); return; }
      // Only transport and server failures preserve a lease. Auth, malformed
      // responses, validation, and every other 4xx are permanent ambiguity.
      if (!(error instanceof AutomationError) || !error.transient) { await this.loseLease('HEARTBEAT_REJECTED'); return; }
      if (Date.now() >= active.leaseExpiresAt) await this.loseLease('LEASE_EXPIRED_LOCAL');
      else this.warn(`transient heartbeat retained for ${active.cue.cue_id}`, error);
    }
  }
  private async heartbeatRequest(active: ActiveCue, idempotencyKey: string): Promise<void> {
    const result = await this.request('POST', `/internal/playout/${active.cue.cue_id}/heartbeat`, {
      expected_queue_revision: this.revision, worker_id: this.workerId, claim_token: active.cue.claim_token,
      idempotency_key: idempotencyKey, offset_ms: Math.min(this.offset(active), active.cue.planned_duration_ms + 30_000),
    }) as { queue_revision?: number; claim_expires_at?: string };
    this.revision = Number(result.queue_revision ?? this.revision);
    const expiry = typeof result.claim_expires_at === 'string' ? Date.parse(result.claim_expires_at) : NaN;
    if (!Number.isFinite(expiry)) throw new AutomationError('MALFORMED_RESPONSE', 'heartbeat response omitted claim expiry', 200);
    active.leaseExpiresAt = expiry;
  }
  private async loseLease(reason: string): Promise<void> {
    const cues = [this.active, this.incoming].filter((cue): cue is ActiveCue => cue !== null);
    this.active = null; this.incoming = null; this.clearCrossfadeDeadline(); this.mixer.setProgramSource(null);
    for (const cue of cues) cue.source.stop?.();
    await Promise.all(cues.map((cue) => this.interrupt(cue, reason)));
  }
  private async interrupt(active: ActiveCue, reason: string): Promise<void> {
    try {
      const interruptKey = key('interrupt');
      const result = await this.withRevisionRetry(`interrupt ${active.cue.cue_id}`, () => this.request('POST', `/internal/playout/${active.cue.cue_id}/interrupt`, {
        expected_queue_revision: this.revision, worker_id: this.workerId, claim_token: active.cue.claim_token,
        idempotency_key: interruptKey, reason, offset_ms: Math.min(this.offset(active), active.cue.planned_duration_ms + 30_000),
      }) as Promise<{ queue_revision?: number }>);
      this.revision = Number(result.queue_revision ?? this.revision);
    } catch (error) { this.warn(`interrupt failed for ${active.cue.cue_id}`, error); }
  }
  private hasStalledDecoder(): boolean { return [this.active, this.incoming].some((cue) => Boolean(cue?.source.stalled)); }
  private nextCrossfadeMs(): number { return this.nextTransitionMs ?? Math.min(10_000, Math.max(500, this.opts.crossfadeMs)); }
  private crossfadeMsForCue(cue: ClaimedCue): number {
    return cue.transition?.kind === 'crossfade' && Number.isFinite(cue.transition.duration_ms)
      ? Math.min(10_000, Math.max(500, Number(cue.transition.duration_ms)))
      : Math.min(10_000, Math.max(500, this.opts.crossfadeMs));
  }
  private scheduleCrossfadeDeadline(): void {
    const active = this.active;
    if (!active || active.cue.type !== 'music' || this.nextType !== 'music' || this.incoming || this.claimInFlight || this.pendingClaim || this.pendingSettlements.size > 0) {
      this.clearCrossfadeDeadline(); return;
    }
    const durationMs = this.nextCrossfadeMs();
    const leadMs = Math.min(1000, Math.max(0, this.opts.crossfadeLeadMs ?? 250));
    const delay = Math.max(0, active.cue.planned_duration_ms - this.offset(active) - durationMs - leadMs);
    const dueAt = Date.now() + delay;
    if (this.crossfadeTimer && this.crossfadeTimerCueId === active.cue.cue_id && this.crossfadeTimerDurationMs === durationMs
      && Math.abs(this.crossfadeTimerDueAt - dueAt) < 100) return;
    this.clearCrossfadeDeadline();
    this.crossfadeTimerCueId = active.cue.cue_id; this.crossfadeTimerDurationMs = durationMs;
    this.crossfadeTimerDueAt = dueAt;
    this.crossfadeTimer = setTimeout(() => {
      this.crossfadeTimer = null;
      void this.run(() => this.fireCrossfadeDeadline(active.cue.cue_id)).catch((error) => this.warn('crossfade deadline failed; normal polling remains armed', error));
    }, delay);
    this.crossfadeTimer.unref();
  }
  private async fireCrossfadeDeadline(cueId: string): Promise<void> {
    this.crossfadeTimerCueId = null; this.crossfadeTimerDurationMs = null; this.crossfadeTimerDueAt = 0;
    if (this.stopped || this.stationOverlayReserved) {
      if (!this.stopped && this.stationOverlayReserved) {
        this.crossfadeTimerCueId = cueId;
        this.crossfadeTimerDueAt = Date.now() + 100;
        this.crossfadeTimer = setTimeout(() => { this.crossfadeTimer = null; void this.run(() => this.fireCrossfadeDeadline(cueId)); }, 100);
        this.crossfadeTimer.unref();
      }
      return;
    }
    if (!this.active || this.active.cue.cue_id !== cueId || this.active.cue.type !== 'music' || this.incoming || this.pendingClaim || this.pendingSettlements.size > 0) return;
    await this.snapshot();
    if (this.stopped || this.stationOverlayReserved || this.nextType !== 'music') return;
    await this.claimAndStart(true);
  }
  private clearCrossfadeDeadline(): void {
    if (this.crossfadeTimer) clearTimeout(this.crossfadeTimer);
    this.crossfadeTimer = null; this.crossfadeTimerCueId = null; this.crossfadeTimerDurationMs = null; this.crossfadeTimerDueAt = 0;
  }
  private lease(cue: ClaimedCue): number { const value = Date.parse(cue.claim_expires_at); return Number.isFinite(value) ? value : Date.now(); }
  private offset(active: ActiveCue): number { return Math.max(0, Math.round(active.source.positionMs ?? (Date.now() - active.startedAt))); }
  private async withRevisionRetry<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    let conflicts = 0;
    for (;;) {
      try {
        const result = await operation();
        if (conflicts > 0) {
          this.revisionConflictRecoveries += 1;
          this.info(`${scope} recovered after ${conflicts} revision refresh${conflicts === 1 ? '' : 'es'}`);
        }
        return result;
      } catch (error) {
        if (!(error instanceof AutomationError) || error.code !== 'REVISION_CONFLICT') throw error;
        conflicts += 1;
        this.revisionConflictRetries += 1;
        if (conflicts > REVISION_RETRY_LIMIT) {
          this.revisionConflictExhaustions += 1;
          throw error;
        }
        await this.snapshot();
      }
    }
  }
  private async request(method: string, endpoint: string, body?: unknown, timeoutMs = 5000, externalSignal?: AbortSignal): Promise<unknown> {
    if (!this.opts.url || !this.opts.token) throw new AutomationError('UNCONFIGURED', 'automation client is not configured');
    let response: Response;
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
    try { response = await fetch(new URL(endpoint, this.opts.url), { method, headers: { authorization: `Bearer ${this.opts.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal }); }
    catch (error) { if (this.available) { this.available = false; this.changed(); } throw new AutomationError('NETWORK', error instanceof Error ? error.message : 'network failure'); }
    const data = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    if (!response.ok) throw new AutomationError(data.error?.code ?? 'HTTP_ERROR', data.error?.message ?? `automation HTTP ${response.status}`, response.status);
    if (!this.available) { this.available = true; this.changed(); }
    return data;
  }
  private changed(): void { queueMicrotask(() => this.opts.onStateChange?.()); }
  private info(message: string): void { console.info(`[playout] ${message}`); }
  private warn(message: string, error: unknown): void { console.warn(`[playout] ${message}:`, error instanceof Error ? error.message : String(error)); }
  private severe(message: string, error: unknown): void { console.error(`[playout] SEVERE ${message}:`, error instanceof Error ? error.message : String(error)); }
}

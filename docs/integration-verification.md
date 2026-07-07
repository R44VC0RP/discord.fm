# Automation integration verification report

Implemented locally without deployment: single-owner reruns with rollback
export, reservation-guarded hourly idents, fail-safe startup presence, atomic
cue-aware feed/TV projection, and a genuine no-credit pinned OpenCode tool-call
E2E. The completion soak flake came from assuming a 10 ms poll always preclaimed
the successor on a loaded host, then holding the predecessor behind an arbitrary
700 ms delay. Fault injection now fails the first real completion immediately;
overlap and serial settlement behavior are covered independently. The soak also
accepts one bounded resumable recovery after a real >5 s host suspension, while
still requiring exactly-once completion and no unbounded claim/interrupt churn.

The later full-soak `queue revision is stale` lines were isolated to the
`POST /internal/playout/claim` CAS window: the controller read revision N from
the snapshot, then a DJ/manual enqueue (the soak's next-cue insertion; the same
class includes generation completion or rerun admission) committed N+1 before
the claim arrived. Presence does not bump queue revision, and the observed
failure was not start, complete, heartbeat, or interrupt. The controller now
refreshes and retries explicit `REVISION_CONFLICT` at most twice with the same
logical idempotency key. The same bounded primitive protects start, heartbeat,
and interrupt; completion keeps its lease-aware settlement queue with the same
two-conflict cap. Successful recovery logs at info, while exhaustion and every
non-CAS error retain their prior failure path.

Claim response ambiguity is separately ordered. A claim keeps one request body
and idempotency key across network/timeout/5xx replay; an explicit CAS rejection
may update only the expected revision because it proves no idempotency result
was committed. While outcome is unknown the controller has a hard claim barrier
and leaves the bed up. After bounded replay/deadline it asks the authenticated
owned-claim endpoint; it permits a fresh claim only after the server reconciles
to “none”. Automation itself now holds later cues behind any other worker's
CLAIMED/PLAYING cue, while retaining same-worker music crossfade. This preserves
group order across response loss and bot restart.

Verification commands:

```sh
cd automation && npm test
cd bot && npm test && npm run build
cd admin && npm test
./scripts/opencode-tool-e2e.sh
./scripts/automation-restore-drill.sh
./scripts/rsync-survival-drill.sh
./scripts/playout-soak.sh
./scripts/deploy-preflight.sh --check-local
```

Base playout soak: **250/250 iterations over 900 seconds**. Final P1-focused
soak (ident duck/composition/collision/legacy plus real decoders): **364/364
iterations over 902 seconds**.

Final revision-CAS soak (including deterministic DJ enqueue racing a scheduled
rerun claim): **274/274 iterations over 900 seconds**, with
`unexpected_tick_failures=0`; every injected claim conflict recovered in one
refresh, below the two-refresh cap.

Final claim-response-loss soak: **208/208 iterations over 902 seconds**, with
`unexpected_tick_failures=0`. Every iteration dropped a committed group claim
response, replayed the identical logical request, exercised restart/lease hold,
and exercised deadline-based owned-claim recovery before later cues.

Proposed approval-gated production order: all-false service shadow; import and
backup; generation; DJ shadow; playout with DJ/hotline off; verify presence,
rerun and feed; then live tracks, commentary, and finally separately approved
hotline. Roll back in reverse and restore the exported rerun played set before
legacy reruns resume. Fake provider and AI-only archive always remain off.

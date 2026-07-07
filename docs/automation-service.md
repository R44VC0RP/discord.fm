# Durable automation, generation, and DJ services

`automation/` is the sole SQLite writer and the future internal API boundary
for catalog, durable queue, generation readiness, hotline eligibility, and bot
playout lifecycle. It is deliberately isolated from the mixer and is not
routed by Caddy. It now also owns ahead-of-air TTS, hotline import, and the
guarded OpenCode DJ. The authenticated control room now fronts it through a
fixed-allowlist admin proxy (asset library/upload, queue, DJ status, hotline
review); there is still no public private-data projection or AI-only archive.

## No-stream-impact rollout

The Compose service is behind the opt-in `automation` profile. Every automation
behavior flag defaults literally false, so adding or restarting it cannot
change the production audio path. Never deploy without the specific user
approval required by `AGENTS.md`.

Before creating `state/`, `generated/`, `music/originals/`, or `music/ready/`
on a target:

1. Set a long random `AUTOMATION_INTERNAL_TOKEN` only in the target `.env`.
2. Run `./scripts/deploy-preflight.sh host:app-directory`. It verifies the
   root-anchored git ignores, canonical rsync exclusions, and that no private
   durable file is tracked. Once a DB exists it refuses to proceed unless the
   running service can create and integrity-check an online pre-deploy backup.
3. Create host directories as the deployment user (`install -d -m 700 state
   generated`; existing `music/` remains private). Do not place placeholders,
   secrets, databases, WAL files, caller data, or generated audio in git.
4. Build/start only the isolated profile:
   `docker compose --profile automation up -d --build automation`.
5. Check container health. The idempotent existing-music import is either run
   at service startup with `AUTOMATION_IMPORT_MUSIC_ON_START=true`, or requested
   over authenticated `POST /internal/catalog/import-existing`. The offline CLI
   exists for recovery only and must never run while the service is running.

Uploads stage, probe, hash, and atomically rename bytes into an immutable
path before catalog insertion. The admin app owns upload HTTP: it streams the
browser body (size-capped, bounded concurrency, aggregate staging budget) to
`music/originals/.staging/<server-generated ast id>.part` on the same
filesystem, renames it to `music/originals/<ast id>.mp3`, then calls
authenticated `POST /internal/catalog/register-upload`, which ffprobes,
hashes, and catalogs the bytes. Registration is reconciliation-safe: the
call is idempotent (byte-identical retries dedupe to the same asset), so a
response lost after automation committed is resolved by retrying and, if
still ambiguous, by `GET /internal/catalog/assets/:id`. Files are deleted
only on a DEFINITIVE rejection (probe/validation failure, or a confirmed
catalog 404 after an outage) or when the bytes duplicate a different
existing asset; a fully ambiguous outcome keeps the file and journals it in
`.staging/unresolved.json` for automatic reconciliation at startup and
before each upload. Callers cannot supply arbitrary playout paths through
the queue API. Existing `/music/*.mp3` imports are checksum-idempotent and
never move or alter source files.

## Admin control-room surface

The admin server proxies a fixed allowlist of automation routes with the
broad internal token held server-side only; the browser never receives any
automation credential. Every proxied response is rebuilt from an explicit
per-field allowlist: worker IDs, lease owners, DJ run/session IDs,
cue/group/asset internals the UI does not use, locators, and checksums never
reach the browser (the DJ lease is exposed only as a `held` boolean). All
admin state mutations — existing controls, bodyless skips, and uploads —
additionally require a same-origin browser context (Sec-Fetch-Site
`same-origin`/`none`, else Origin must match Host; forged/`null`/text-plain
cross-origin posts get 403), while header-less non-browser callers (the
bot's mp4 render requests) and the signature-authenticated Twilio `/call/*`
webhooks are unaffected. Browser-facing routes: catalog list/search,
immutable asset-ID audio preview (Range-capable, hotline caller audio
excluded), queue snapshot + manual track/commentary enqueue (browser
supplies expected revision + idempotency key), `GET /internal/dj/status`
(mode OFF/SHADOW/LIVE, OpenCode health/version, last run tokens/cost,
budgets, watermarks, and the seven read-only tool names), hotline review
list (redacted transcripts only), and explicit hotline review actions. `POST /internal/hotline/review`
implements the operator restore endpoint anticipated below: approve
(NEEDS_REVIEW/REJECTED → ELIGIBLE, with an explicit consequence confirmation
in the UI), reject (ELIGIBLE/NEEDS_REVIEW/QUEUED → REJECTED, transactionally
canceling a queued group), and restore (unaired ARCHIVED only →
re-screened). Group mutations are atomic across the entire cue group: if ANY
child — intro, call, outro, or destination — is CLAIMED or PLAYING, the
whole action fails with a conflict and no cue is touched. Every action
requires the expected moderation version plus an idempotency key, bumps the
moderation version, and records a sticky `operator_override` that unchanged
source rescans cannot fight; AIRED stays terminal and cannot be restored.
Queue remove/reorder/skip and any playout control remain intentionally absent
from both the API and the UI.

## Internal contract

Health endpoints are `GET /healthz` and `GET /readyz`. Every `/internal/*`
request requires `Authorization: Bearer $AUTOMATION_INTERNAL_TOKEN`, accepts
bounded JSON only, and returns structured `{error:{code,message,details}}`
errors. APIs cover safe catalog/history/queue snapshots, manual track and
commentary enqueue, deterministic refill, safe hotline candidates and atomic
groups, generation completion, presence, and claim/start/heartbeat/complete/
interrupt. Queue mutations use expected revisions and idempotency keys.

Commentary and generated hotline children stay `GENERATING`; no placeholder
audio is READY. A hotline group is admitted in one transaction only after all
included generated children attach READY assets. Render completion replaces the
estimate with probed duration only if the resulting active horizon remains
within its cap; otherwise the cue/group fails atomically and an unaired hotline
candidate is restored. Expired unclaimed cues/groups are transactionally
canceled and stop consuming queue capacity. `AUTOMATION_HOTLINE_ENABLED`
must remain false until the operator supplies and tests a conservative
`AUTOMATION_HOTLINE_BADWORDS` policy and the separate consent/moderation work is
approved. Private transcript, path, probe, and provenance columns are never
returned by catalog/queue/public-safe candidate projections.

Asset locators must resolve beneath an approved private root with no symlink in
any path component. READY bytes are opened without following the final symlink,
hashed at catalog time, and realpath/checksum-validated again immediately before
a playout claim exposes the internal locator.

SQLite uses foreign keys, WAL, a five-second busy timeout, full synchronous
commits, numbered migrations, startup `quick_check`, and crash-safe
transactions. Authenticated `POST /internal/maintenance/backup` uses SQLite's
online backup API in the sole writer process and verifies the result. The
deploy preflight invokes this endpoint from inside the private container.
Off-box encrypted backup/restore and the
production-like `rsync --delete` survival drill remain rollout exit gates.

## Generation and DJ enablement

Every capability remains opt-in. Initial enablement requires all relevant
values in private `.env`: `AUTOMATION_GENERATION_ENABLED=true`, existing
`ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`; then, for the DJ,
`AUTOMATION_DJ_ENABLED=true`, a pinned `AUTOMATION_DJ_MODEL`, and a separate
long `OPENCODE_SERVER_PASSWORD`. Hotline scanning additionally requires
`AUTOMATION_HOTLINE_ENABLED=true`, `AUTOMATION_HOTLINE_IMPORT_ENABLED=true`,
and an operator-reviewed nonempty `AUTOMATION_HOTLINE_BADWORDS`. All defaults
are false. `AUTOMATION_DJ_SHADOW=true` validates mutations and rolls them back.
`AUTOMATION_DJ_TOOL_TOKEN` is a separate 32+ character credential accepted only
by the seven DJ gateway routes; it cannot call catalog/admin/playout APIs.

The private `opencode` Compose service pins CLI/plugin `1.17.13`, uses an empty
ephemeral scratch directory, mounts only reviewed config/tools read-only, and
has no host/public port, repository, state, or asset mount. The exact custom
tool IDs are `list_tracks`, `get_track_history`, `get_queue`, `enqueue_track`,
`enqueue_commentary`, `list_hotline_candidates`, and
`enqueue_hotline_group`. A wildcard deny precedes those seven allows; no MCP
server or resource is configured. Startup DJ enablement runs an ordinary prompt
through a local no-cost capture provider and fails closed unless the final
provider request contains exactly those tools and reviewed schemas. OpenCode
v1.17.13 represents an unforced tool choice as absent or `auto`; both normalize
to the same automatic behavior and any forced choice is rejected. Sessions are
deleted after each run and scratch is ephemeral.

The OpenCode container receives no broad `.env` file. Compose passes only its
server credentials, Zen provider key/model, automation URL, and scoped tool
token. OpenCode CLI/plugin/SDK are exact `1.17.13`; the v1.17.13 upstream
provider adapters are also pinned in the image as
`@ai-sdk/openai-compatible@2.0.41` (capture) and `@ai-sdk/openai@3.0.53` (Zen).
The capture provider uses a read-only `file://` adapter path, bypassing runtime
npm installation entirely. Zen remains OpenCode's built-in provider loader,
whose exact adapter version is pinned by upstream v1.17.13 and mirrored in the
image lock. Cold-start capture tests remain mandatory; adding any unknown custom
provider is prohibited because OpenCode may runtime-install its npm package.

Generation claims durable jobs with bounded retries, calls the configured
ElevenLabs voice, canonicalizes to 48 kHz stereo MP3, validates size/duration/
loudness, and atomically links checksum-named files under `generated/ready`.
No provider call occurs at cue claim/start. Failed renders leave no partial
READY file; group failure restores a still-eligible unaired call.

Existing `voicemails/vm-*.json` and matching MP3 files are scanned
idempotently. Caller phone/from and call SID are intentionally discarded;
only raw transcript remains private in SQLite and a deterministic PII-redacted
projection reaches the DJ. Empty, archived, badword-matched, stale, queued, or
aired calls cannot be selected again.

`AIRED` and playout-terminal `ARCHIVED` are sticky store states. Periodic source
rescans—including changed transcripts or `archived:false`—cannot make an
interrupted/partially aired call eligible again. `archive_reason` records source
archive versus interruption/lease-expiry provenance. The explicit
authenticated operator review endpoint (`POST /internal/hotline/review`,
described above) is the only restore path: it creates a reviewed new
moderation version for unaired ARCHIVED calls. No implicit restore exists,
and AIRED can never be restored.

Authenticated asset-library controls may retire or restore immutable music by
asset ID with queue-revision CAS and idempotency. Retire keeps bytes, blocks if
the asset or an atomic-group sibling is claimed/playing, and cancels every
unplayed reference/group transactionally. Restore rechecks realpath/symlinks,
regular-file identity, SHA-256, and ffprobe duration before returning READY.
Hashing streams from one `O_NOFOLLOW` descriptor into a bounded private copy;
ffprobe consumes that exact copy through an inherited descriptor. File and
parent-directory dev/inode/timestamps are pinned before/after, and final lstat
identity is checked inside the commit transaction, so pathname swap-and-restore
races fail closed.
There is intentionally no asset delete control.

Simple UTC-day circuit breakers can cap DJ tool calls/model tokens and TTS
characters (`AUTOMATION_DJ_DAILY_TOOL_LIMIT`,
`AUTOMATION_DJ_DAILY_MODEL_TOKEN_LIMIT`, and
`AUTOMATION_TTS_DAILY_CHARACTER_LIMIT`). Set any one to `0` to disable that
circuit breaker (the default); positive values enforce its cap. Negative,
non-integer, and out-of-range values fail configuration loading. Accounting is
still recorded while a breaker is disabled. Exhaustion defers work/backoff to
the next UTC day without touching current READY playout; daily-budget deferrals
are re-evaluated on automation restart, while provider/error backoff remains
durable. These are operational guardrails, not a provider billing ledger.

DJ completion accounting is fail-closed. The coordinator inspects every
assistant message plus tool parts before deleting the dedicated session.
Provider/auth/model error envelopes and zero-token/no-tool pseudo-completions
become safe `DJ_PROVIDER_*` failures with durable backoff; provider response
bodies, headers, messages, and credentials are never persisted or logged.
Positive-token, genuinely valid no-tool responses are recorded as `NOOP`, not
`COMPLETED`. Provider-class failures do not mutate the queue; the existing local
bed remains the fallback. The queue snapshot exposes only the normalized latest
run state/code, counters, and backoff timestamps.

Hourly identifiers remain the existing bot-owned station overlay. At `:00:05`
the announcer reserves the automation boundary before LLM/TTS work, so durable
speech/hotline cannot race it. It preserves Eastern/Pacific time, rotating
weather, all three platforms, and the catchphrase; live presence, collision,
failure, or expiry skips fail-soft.

When playout is enabled, automation is the sole rerun owner. It imports the
legacy played set once, preserves oldest-unaired/full-cycle rotation, pacing,
admin queue, skip, and resume, and continuously writes
`feed/rerun-state.automation-export.json` for rollback. The seven DJ tools
cannot select reruns. Automatic rerun admission is a versioned durable SQLite
setting, initialized ON by migration. The control room AUTO button changes it
with optimistic concurrency and idempotency; OFF immediately blocks new filler
and withdraws an unclaimed automatic rerun, but never interrupts a CLAIMED or
PLAYING rerun. Explicit operator queue entries are clearly labeled as an OFF
bypass. Re-enabling resumes the existing cycle and pacing timestamps without a
reset. When automation playout is disabled, the same button controls the legacy
bot `RerunManager`; an unreachable automation owner is shown as OFFLINE rather
than silently falling back to legacy.

Authenticated rerun control routes:

- `GET /internal/rerun/state` includes `auto`, `control_version`, owner and
  availability plus the safe queue/cycle projection.
- `POST /internal/rerun/auto` requires `enabled`, `expected_version`, and
  `idempotency_key`. A stale version returns `RERUN_VERSION_CONFLICT`.
- Manual queue/unqueue retain their existing behavior and manual queue is the
  deliberate operator override while AUTO is OFF.

Presence starts UNKNOWN in SQLite and the bot. Claims remain blocked until
Discord is ready, voice join succeeds, and initial membership is accepted;
reconnect gaps return to UNKNOWN. Public cue projection is serialized and
atomic, with no private fields.

## Integration verification

Unit 3 proves local schemas, migrations, generation/DJ/hotline domain behavior,
the exact effective OpenCode tool request, and failure isolation. It does **not**
claim the later production/integration gates are complete. Specifically:

- `scripts/opencode-tool-e2e.sh` proves genuine pinned OpenCode tool calls,
  scoped auth, queue/commentary/history behavior, and session cleanup.
- `scripts/automation-restore-drill.sh` compares migration, revision, cues,
  asset checksums, and integrity after an isolated online-backup restore.
- `scripts/playout-soak.sh` runs real decoder and deterministic transient
  completion coverage for 15 minutes by default.
- Production-volume rsync survival and a 24-hour staging/downstream observation
  remain rollout gates. No production change was made by these local drills.

`AUTOMATION_DJ_FAKE_PROVIDER_ENABLED` is test-only, defaults false, and must
never be enabled in production.

Music-to-music transitions default to a stored 6000ms equal-power crossfade.
The bot uses a one-shot local deadline roughly 250ms before the fade boundary
to absorb claim/checksum/ffmpeg startup without increasing normal 1s polling or
DB load. Existing queued 3000ms transition records remain authoritative and
continue to play at 3s; changing the environment affects newly queued cues.
`AUTOMATION_CROSSFADE_MS` is validated as 500–10000ms by automation and the
bot; HTTP, DJ gateway, and custom OpenCode schemas enforce the same bounds.

## Bot dependency audit note

The pre-existing Discord runtime tree pinned `undici@6.24.1` through
`discord.js@14.26.4` and `@discordjs/rest@2.6.1`. A same-major override to
`undici@6.27.0` is covered by the bot build/voice/playout tests and removes its
four advisories (and the derived Discord REST/WS audit findings). Five high
audit entries remain one underlying chain:
`@discordjs/voice@0.19.2 → prism-media@1.3.5 → @discordjs/opus@0.10.0 →
@discordjs/node-pre-gyp@0.4.5 → tar@6.2.1`. The maintained Discord packages
publish no newer compatible versions, node-pre-gyp declares `tar ^6.1.11`, and
all tar 6 releases are in the advisory range; the fix requires tar 7.5.16+.
Forcing that undeclared major could break native Opus installation and was
therefore deferred rather than weakening the required current Discord
voice/DAVE path. No `npm audit fix --force` was used.

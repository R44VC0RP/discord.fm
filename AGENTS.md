# AGENTS.md — anomaly.fm knowledge base + rules

Read this before touching anything. It contains the user's standing rules,
the full production architecture, and every hard-won operational finding.
This repo is public: **never put secrets in this file or anywhere in git.**

## Hard rules (user-given, do not violate)

1. **Never deploy to production without explicit user approval** for that
   specific change. Build and verify locally freely; ship only on a "yes".
2. **The stream is 24/7 and must never go offline because of a ship.**
   Follow the restart-impact table below.
3. **Do not commit or push to git unless explicitly asked.**
4. **No Cloudflare deployments** (Workers, Pages, Stream, Access).
   Cloudflare hosts DNS only (zones: anomaly.fm, anoma.ly).
5. **Secrets live only in `.env` on the production box** (tokens, stream
   keys, API keys, admin password). Never in the repo, never in images.

## What this is

A Discord bot that turns a voice channel into a 24/7 AM radio station:
voices are captured per-speaker, mixed with a ducking music bed and
voice-gated crackle, pushed through an AM-radio ffmpeg filter to Icecast,
served on the web with a retro player, recorded per-session, replayed as
reruns when idle, and simulcast as video (art + waveform + live status) to
YouTube and X. YouTube live chat bridges back into the Discord channel.

## Production

- Box: `ssh lagoon-to-equestrian.exe.xyz` — exe.dev VM, **4 vCPU / 15GB /
  25GB disk** (resized 2026-07-02), Ubuntu 24.04, Docker Compose v2.
  App dir: `~/anomaly.fm-discord`. SSH auth = user's key; agent has access.
- exe.dev platform facts:
  - Their edge terminates TLS and proxies ALL registered domains to ONE
    public VM port (ours: 8000, made public via `ssh exe.dev share
    set-public lagoon-to-equestrian`). Ports 3000-9999 are reachable only
    by authenticated exe.dev users.
  - Custom domains: `ssh exe.dev domain add <vm> <domain>` — requires DNS
    already pointing directly (CNAME/ALIAS to `<vm>.exe.xyz`, grey-cloud;
    apex domains need flattening). exe.dev issues certs.
  - Resize: exe.dev dashboard, then `sudo poweroff` in VM +
    `ssh exe.dev restart <vm>`. ~90s total downtime; all containers
    auto-start (restart: unless-stopped).
- Domains (Cloudflare DNS, all records DNS-only/grey):
  - `anomaly.fm`, `www.anomaly.fm` → station
  - `fm.anoma.ly` → control room (caddy basic_auth; creds in box `.env`
    as ADMIN_PASSWORD / ADMIN_PASSWORD_HASH)
- Discord: bot **AnomalyFM#6154**, app id 1522257266701631528, guild
  1391832426048651334 (OpenCode), voice channel 1522253272684036187
  (#anomaly-fm — private; bot allowed via channel override).
- Git: public repo `R44VC0RP/discord.fm` (github, gh CLI authed).
  Music (137MB) and recordings are gitignored.

## Architecture

```
Discord VC ── bot (DAVE E2EE, per-speaker Opus → 48k PCM)
                │  mixer (20ms frames): voices + crackle(voice-gated)
                │        + music bed (ducked when humans>0)
                │        + rerun deck (plays recordings when idle; bed→0)
                │  → ffmpeg AM chain (mono, 300-3.8kHz, compress, softclip,
                │     tremolo, pink-noise static) → mp3 96k mono
                ▼
             icecast /radio  (+ /station/fallback.mp3 fallback-override →
                │             bot restarts are seamless static, no drops)
                ├─ caddy :8000 (host router; PUBLIC port)
                │    anomaly.fm → icecast (player /, /radio, /feed/*, /og.png)
                │    fm.anoma.ly → admin app (basic_auth)
                ├─ recorder (humans>0 → -c copy session mp3 + meta json)
                └─ tv encoder (art + showwaves + drawtext onair.txt)
                     → mediamtx relay → push-yt → YouTube RTMP
                                      → push-x  → X RTMPS
bot also runs: control API :8090 (internal), YouTube chat → channel text,
periodic voice refresh, feed writer (status.json / feed.xml / onair.txt)
```

### Services & restart impact

| Service | Role | Restarting it |
| --- | --- | --- |
| caddy | host router on :8000 | drops ALL listeners. Config: edit `caddy/Caddyfile` (dir-mounted) then `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` = zero downtime |
| icecast | stream + static files | drops listeners (rare: config changes only) |
| bot | everything audio + Discord | SAFE — icecast fallback plays static for the gap. `docker compose up -d bot` after build |
| admin | control room (fm.anoma.ly) | safe |
| recorder | session capture + retention | safe (session continues as part file) |
| tv | video encoder → relay | video blip on BOTH platforms |
| mediamtx | local RTMP relay | video blip on BOTH platforms |
| push-yt / push-x | relay → platform (stream copy, ~1% CPU) | blips ONLY that platform — this split exists precisely so one platform can bounce alone |

### Deploy procedure (AFTER user approval)

```
rsync -az --delete --exclude node_modules --exclude dist --exclude .env \
  --exclude .git --exclude "music/*" --exclude "feed/*" \
  --exclude "recordings/*" --exclude "voicemails/*" \
  --exclude "web/current.html" ./ lagoon-to-equestrian.exe.xyz:anomaly.fm-discord/
ssh box 'cd anomaly.fm-discord && docker compose --profile tv build <svc> \
  && docker compose --profile tv up -d'
```
Verify after: `https://anomaly.fm/` 200, `/radio` streams, bot logs show
`[voice] live`, `docker stats` sane.

## Key operational findings (learned the hard way)

### Docker / compose
- `docker compose restart <svc>` does NOT re-read `.env` — envs bake at
  container creation. Env changes need `docker compose up -d <svc>`.
- Compose interpolates `$` inside `.env` values used in `environment:`
  mappings — bcrypt hashes get eaten. Escape as `$$` (ADMIN_PASSWORD_HASH
  is stored escaped).
- Single-file bind mounts go permanently stale when rsync replaces the file
  (new inode). Use directory mounts only (this bit us on the Caddyfile).

### Discord voice
- DAVE E2EE is mandatory on non-Stage voice channels since March 2026.
  `@snazzah/davey` must be installed; a 4017 close = DAVE handshake refused
  (outdated lib). Voice receive is undocumented-but-stable API.
- The gateway caches ALL guild channels regardless of visibility; REST
  `GET /channels/:id` returning 50001 Missing Access is the real
  permission truth. Private channels need a channel-level override.
- Join timeout ("entersState Ready") usually = missing Connect/View on a
  private channel, not networking.
- Bot's guild role: View+Connect+Speak; Send Messages inherited from
  @everyone (verified effective TRUE in #anomaly-fm — chat bridge works).

### Icecast
- The fallback file must match the live stream format EXACTLY (mp3, 48kHz,
  mono, 96k) — `web/fallback.mp3` is rendered from the AM chain with silence
  input. `<fallback-override>1</fallback-override>` switches listeners back.
- Icecast rejects HEAD requests on mounts with 400 — probe with GET.
- Static files served from webroot; `./web` is dir-mounted at
  `/station`, `./feed` at `/feed`. Aliases: `/` → `/station/player.html`,
  `/og.png` → `/station/og.png`.
- Internal consumers (tv, recorder) send user-agent `anomalyfm-internal`;
  the bot counts humans via admin listclients minus that UA.

### Presence model (single source of truth: the bot)
- humans>0 → music ducks (MUSIC_DUCK_GAIN), recorder starts a session,
  rerun pauses (position saved), status ON AIR.
- humans=0 → music back up. Rerun pacing (v2): RERUN_AFTER_LIVE_MIN (35)
  quiet time after live before any rerun; RERUN_GAP_MIN (35) of bed between
  reruns; rotation plays the OLDEST unaired session and repeats nothing
  until the whole archive has aired (state: feed/rerun-state.json). Admin
  queue bypasses the waits; paused reruns resume first; skip marks played.
  The post-live wait must exceed RECORDING_STOP_DELAY_S (120s) or reruns
  get re-recorded — trivially satisfied at 35min.
- Bot publishes `feed/status.json` (player + recorder consume),
  `feed/onair.txt` (tv drawtext), `feed/feed.xml` (RSS), and persists the
  active music track in `feed/music-track.txt`.

### YouTube
- Chat bridge: API-key-only (no OAuth) via videos.list →
  activeLiveChatId → liveChat/messages polling. **Quota math: ~5
  units/call, 10k/day free → 45s poll floor for 24/7** (YT_CHAT_POLL_S).
  Known upgrade path: `liveChatMessages.streamList` (server-push, near
  realtime, cheap) — not yet implemented.
- If the video feed gaps long enough the broadcast ENDS permanently and a
  new one gets a NEW video id → update YOUTUBE_VIDEO_ID in box `.env` +
  `docker compose up -d bot`. Stream key ≠ video id.
- 24/7 streams officially fine on YouTube.

### X (Twitter)
- NO documented duration cap for immediately-started broadcasts (6h cap is
  scheduled-only). Daily feed restarts are OFF (`X_RESTART_AT` empty);
  enable only if a real cap is proven.
- RTMP feeds a Media Studio *Source*; broadcasts are created manually in
  Producer. NO purchasable API exists (partner-only since Periscope died);
  Restream (~$19/mo) is the only ToS-clean automation.
- X survived a ~90s reboot gap once; grace window undocumented. If a
  broadcast dies (TIMED OUT) it cannot be resumed — re-publish manually.
- X chat: no official API. Unofficial read-only path:
  badlogic/twitter-broadcast-chat (Periscope-lineage WebSocket). Not built.
- Current X: account `anomalyco`, RTMPS rtmps://va.pscp.tv:443/x.

### TV pipeline
- Encoder: 1280x720@24 superfast x264 2500k + AAC (~50-85% of one core —
  the waveform makes every frame unique, no stillimage discount).
  Art regenerated from `web/tv.html` (screenshot 1280x720; toolbar/ghost
  cursor must be hidden — see git history). Pixel font baked into image.
- `tv/entrypoint.sh` waits for `feed/onair.txt` to exist before starting.
- Pushers auto-reconnect; a pusher connecting before the encoder publishes
  errors harmlessly and retries every 3s.

### Web / player skins
- The homepage rotates DAILY through `web/skins/*.html` (deterministic per
  station-timezone day; the bot copies the pick to `web/current.html`
  hourly + on boot; icecast alias `/` -> `/station/current.html`).
- `web/radio-core.js` is the invariant runtime (audio, autoplay, reconnect,
  volume, polling). Skins are self-contained HTML implementing the
  data-radio contract — see `web/skins/README.md` for the full spec,
  local-test workflow (localhost auto-targets the live station), and deploy
  rules. NEW SKINS TOUCH NO OTHER CODE.
- Preview any skin in prod without touching the homepage:
  `https://anomaly.fm/station/skins/<name>.html`.
- `web/current.html` is generated: gitignored AND excluded from rsync.
- Listener count prefers filtered `status.json.listeners` (web+youtube).
- OG image is DYNAMIC: the `og` service (og/generator.js, satori+resvg, no
  browser) polls feed/status.json and re-renders `web/og.png` on any
  air-state/skin change — who's on air, rerun label, receiver count, and the
  day's skin palette (og/themes.js, keyed by skin filename; unknown skins
  fall back to classic-receiver). Skin detected by byte-comparing
  web/current.html to web/skins/*. Caddy serves /og.png with
  Cache-Control max-age=60. Test: `cd og && npm i && node test-render.js`
  → /tmp/og-test/*.png for every theme x state. `web/og.html` remains only
  as a static design reference (no longer part of any workflow).
- og service restart impact: none (fully outside the audio/video path).

### Clips (/clip + archive mp4 downloads)

- Both render the SAME branded look: `web/clip.png` background (art source
  `web/clip.html`, tv.html layout with "STATION CLIP" footer; regenerate via
  screenshot like tv.png) + showwaves at 96:470 520x150 + blinking drawbox +
  drawtext label (font `web/fonts/PixelifySans.ttf`, served via the /web
  mount — bot and admin both read it, no image rebuild for art changes).
- `/clip [seconds]` (Discord, 5–300s, default 30): the bot's encoder ffmpeg
  has a SECOND mp3 output on stdout (asplit tee) feeding an in-memory ring
  buffer (`bot/src/clip.ts`, ~12KB/s, sliced by CBR byte math; mid-frame
  cuts resync within ~24ms). Render is capped-CRF sized to fit ≤~8.5MB
  (Discord bot upload limit 10MB). One render at a time.
- Archive mp4s: control room ARCHIVE row button → admin renders
  (`admin/server.js`, ffmpeg in admin image, `./web:/web:ro` mount) into
  `recordings/mp4/<session>.mp4` (cached; orphans pruned when source mp3 is
  retention-deleted; deleted with the recording). POST
  /api/recordings/:file/mp4 starts (429 busy if another render active), GET
  .../mp4/status polls, GET .../mp4 downloads. Fixed quality capped-CRF
  (crf 23, maxrate 1.5M, threads 2). ~6x realtime on the box.
- Auto-post: EVERY finished session is rendered + posted to Discord channel
  1522363822084587693 (#anomalyfm) by `bot/src/archivecast.ts`, @-mentioning
  participants ("📼 @user just finished their session — 12m34s"). Flow: bot
  polls recordings/ for new session-*.json (30s) → POSTs the admin render →
  polls status → posts archive mp4 if it fits the guild upload cap (tier
  0/1: 10MB), else requests `?variant=discord&budget=` (smaller res/fps,
  audio-first) and posts that. State in `feed/archive-posts.json` (seeded
  with existing archive on first boot so history is never spammed; delete an
  entry to force a re-post; 5 failed attempts marks "failed"). Mentions need
  `memberIds`, plumbed bot snapshot → status.json → recorder → session meta.
  Bot needs View/Send/Attach in the channel (was granted 2026-07-03).
- ffmpeg 5.x (Debian bookworm) GOTCHA: `-shortest` with a `-loop 1` image
  input HANGS (video generation never EOFs; fixed in ffmpeg 6+). Always pass
  an explicit output `-t`. Also: a timeout-killed ffmpeg leaves a giant
  partial file — render to .tmp then rename.
- macOS Homebrew ffmpeg lacks drawtext (no freetype); test drawtext filters
  in the containers, not locally.

### Hourly time checks (announcer)

- At :00:05 each hour, ONLY when humans=0 (bed or rerun playing): Claude
  Haiku (opencode zen, Anthropic Messages API) writes a <90-word ident —
  always Eastern+Pacific time, weather in a ROTATING major city
  (bot/src/weather.ts: 96-city shuffled deck, open-meteo keyless, no city
  repeats until the deck empties ~4 days; state in feed/weather-deck.json),
  the three platforms (X/YouTube/anomaly.fm), and the catchphrase "where
  the anomaly here is only YOU" — with a random tone flavor per hour.
  ElevenLabs voices it (keys in box .env), ffmpeg decodes to PCM, and
  `mixer.playAnnouncement()` airs it: bed ducks, rerun ducks to 20%,
  crackle applies. Fail-soft: no LLM → plain time check; no TTS → skip hour.
- Presence is re-checked after generation so it never talks over a live show.

## Control surfaces

- Discord: `/radio join|leave|status` (Manage Server required),
  `/clip [seconds]` (everyone), `/hotline list|play|air`.
- Control room `https://fm.anoma.ly`: archive (play/mp4 download/cue/
  delete), rerun queue + auto toggle + skip, music bed upload/activate
  (hot-swap, no restart). Basic auth; creds in box `.env`.
- Bot control API (internal :8090): GET /state, POST /rerun/{queue,unqueue,
  skip,auto}, POST /music/track.
- Feeds: https://anomaly.fm/feed/status.json (live/humans/members/rerun/
  listeners), /feed/feed.xml (RSS of joins/leaves), /feed/audience.jsonl
  (hourly audience samples).
- Audience history: `bot/src/audience.ts` samples web+youtube listeners at
  :00:10 every hour (catch-up sample on boot if >65min gap) into
  feed/audience.jsonl, 120-day retention. Bot API GET /audience?hours=N;
  control room AUDIENCE panel draws a 7-day canvas chart (total/web/youtube
  lines, live-show baseline dots). Weekly recaps can be built on this log.

## Local dev tricks

- `cd bot && npm run build` must pass before any deploy.
- Audio preview without deploying: render voice via macOS `say`, feed it
  through the mixer (real-time paced, ≤400ms buffer cap!) and the current
  AM graph extracted from `buildFfmpegArgs()`, then `afplay`. See session
  history; `/tmp/ffargs.json` pattern.
- Mixer/music/crackle smoke tests: instantiate `dist/mixer.js` etc. with
  a sink and count frames/peaks (no Discord needed).
- The bot cannot run twice against the same token/channel — never `npm
  start` locally while prod is up.

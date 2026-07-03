# anomaly.fm-discord

A Discord bot that sits in a voice channel, captures everyone speaking, runs the
mix through an AM-radio filter chain, and broadcasts it as an internet radio
station via Icecast. Embed it on any website with a single `<audio>` tag.

```
Discord VC --> bot (voice receive, per-speaker Opus)
          --> decode + 20ms mixer (silence when idle)
          --> ffmpeg (AM filter: mono, 300-3.8kHz, compression,
              saturation, carrier fade, pink-noise static)
          --> Icecast mount (/radio, MP3)
          --> your website: <audio src="https://stream.example.com/radio">
```

The station runs 24/7: when nobody is in the channel (or the bot is off air)
listeners hear the AM static bed instead of dead silence.

## Setup

### 1. Create the Discord application

1. <https://discord.com/developers/applications> -> **New Application**
2. **Bot** tab -> copy the **Token** (goes in `.env` as `DISCORD_TOKEN`).
   No privileged intents needed.
3. Invite it (replace `CLIENT_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=3146752
   ```

   (`3146752` = View Channels + Connect + Speak)

### 2. Configure

```sh
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_GUILD_ID, passwords; optionally
# DISCORD_VOICE_CHANNEL_ID for auto-join on boot
```

### 3. Run

```sh
docker compose up -d --build
```

Verify: `http://<box>:8000/radio` should play immediately (static until someone
talks). Icecast admin UI is at `http://<box>:8000/admin/` (user `admin`).

### 4. TLS for the website

Browsers block an `http://` stream on an `https://` page (mixed content), so
put TLS in front of Icecast. Either:

- **Included Caddy** (needs `STREAM_DOMAIN` DNS pointing at the box, ports 80/443 free):

  ```sh
  docker compose --profile tls up -d
  ```

- **Existing reverse proxy** on the box: proxy your domain to `:8000` with
  response buffering off (nginx: `proxy_buffering off;`).

### 5. The player

`web/player.html` is served by Icecast at `/` (directory-mounted, so player
edits apply on the next request — no restart). It talks to the stream and
status endpoints on its own origin. To host the player elsewhere, set
`window.STATION_ORIGIN = "https://your-station-host"` before the main script.

`https://<host>/` serves a minimal station player (`web/player.html`, aliased
by Icecast): tune in/out, on-air status with member names, and receiver count.
Autoplay is attempted; when the browser blocks it, the first click anywhere
tunes in.

To embed elsewhere instead:

```html
<audio src="https://stream.example.com/radio" preload="none" controls></audio>
```

See `examples/player.html` for a styled starting point.

## Commands

| Command | Effect |
| --- | --- |
| `/radio join [channel]` | Go on air. Falls back to `DISCORD_VOICE_CHANNEL_ID`, then your current VC |
| `/radio leave` | Off air (stream stays up, playing static) |
| `/radio status` | Connection, speakers, encoder, listener count |

Commands default to members with **Manage Server**.

## The AM sound

Applied entirely in ffmpeg (`bot/src/encoder.ts`), tunable via `.env`:

| Knob | Default | What it does |
| --- | --- | --- |
| `AM_LOWCUT_HZ` / `AM_HIGHCUT_HZ` | 300 / 3800 | Narrow AM broadcast bandwidth |
| `AM_NOISE_LEVEL` | 0.004 | Pink-noise static bed (0.01+ = distant station) |
| `AM_FLUTTER_HZ` / `AM_FLUTTER_DEPTH` | 0.3 / 0.08 | Slow carrier fade, like signal drift |
| `CRACKLE_LEVEL` / `CRACKLE_DENSITY` | 0.3 / 10 | Voice-gated dust and pops: rides on speech only, fades ~600ms after it stops. Works in any preset (mixed bot-side) |
| `RADIO_PRESET=clean` | -- | Bypass everything (untouched stereo) |

Plus fixed stages: mono fold-down, 4:1 broadcast compression, soft-clip
saturation, final limiter. Changes require a bot restart
(`docker compose restart bot`).

## Background music bed

Drop a track at `music/background.mp3`. It loops 24/7 through the same radio
filter as the voices, so the whole station sounds like one AM frequency:

- Channel empty: music at `MUSIC_GAIN` (default 0.9)
- Human joins: fades down to `MUSIC_DUCK_GAIN` (default 0.08) over
  `MUSIC_FADE_DOWN_MS` (1.2s) so speakers sit on top of a quiet bed
- Channel empties: fades back up over `MUSIC_FADE_UP_MS` (3s)

Set `MUSIC_FILE=off` to disable. Swapping the track requires
`docker compose restart bot`.

## Activity feed

The bot publishes channel activity as static files served by Icecast:

- `https://<host>/feed/feed.xml` -- RSS 2.0: "name joined -- 2 in channel"
  entries with timestamps (last `FEED_MAX_ITEMS`)
- `https://<host>/feed/status.json` -- current state for website widgets:
  `{ station, live, humans, members: [...], updated }`

Set `FEED_DIR=off` to disable. Note: this publishes member display names at a
public URL.

## Local development

```sh
cd bot
npm install
# terminal 1: an icecast to push to
docker compose up icecast
# terminal 2 (set ICECAST_HOST=localhost in .env)
npm run dev
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Voice WebSocket closes with `4017` | DAVE/E2EE handshake rejected -- `@snazzah/davey` missing or outdated. `npm update` + rebuild |
| `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`, zero audio | Old `@discordjs/voice` DAVE receive bug (discord.js #11419) -- update `@discordjs/voice` |
| Bot joins but hears nothing | Bot must not be server-deafened; check it shows undeafened in the channel |
| Stream URL 404s | Encoder not connected yet -- `docker compose logs bot` for ffmpeg/icecast auth errors |
| Listeners drop when nobody talks | Should never happen (mixer emits silence 24/7) -- check bot logs |

## Notes

- Everyone in the channel is being rebroadcast publicly: say so in the channel
  topic/name and get consent. Recording laws apply to you, not Discord.
- Voice receive is not officially documented by Discord; it is stable in
  practice (recording bots have used it for years) but treat it as best-effort.
- Latency end-to-end is roughly 5-20s (Icecast burst + player buffering).
  That's normal for internet radio.

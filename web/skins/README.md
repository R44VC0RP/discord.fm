# anomaly.fm player skins

The homepage rotates through the skins in this folder — a different one every
day (deterministic per station-timezone day; everyone sees the same skin).
**Adding a skin = dropping one self-contained `.html` file here.** No other
code changes, ever. The bot copies the day's pick to `web/current.html`
hourly and on boot; icecast serves that at `/`.

## The contract

A skin is a complete standalone HTML page (inline CSS/JS, no build step).
The core runtime (`/station/radio-core.js`) owns ALL behavior — audio,
autoplay, reconnect/backoff, volume persistence, status polling. Skins own
only looks. Include the core as the LAST script:

```html
<script src="/station/radio-core.js" onerror="var s=document.createElement('script');s.src='../radio-core.js';document.body.appendChild(s);"></script>
```

Mark elements with `data-radio` roles (omit any you don't want):

| Attribute | Element | Core behavior |
| --- | --- | --- |
| `data-radio="toggle"` | `<button>` | click = tune in/out; `aria-pressed` maintained |
| `data-radio="status"` | any | textContent = `ON AIR — names` / `RERUN — …` / `INTERMISSION — …` / `OFF AIR — static`. Add `data-ticker` for auto-scrolling overflow (core injects the animation) |
| `data-radio="signal"` | any | textContent = `RECEIVING` / `TUNING…` / `SIGNAL LOST — RETRYING` / `RECEIVER OFF` / `TAP TO TUNE IN` |
| `data-radio="listeners"` | any | textContent = combined listener count (number) |
| `data-radio="volume"` | `<input type="range" min="0" max="100">` | bound + persisted across visits |

Style off the state classes the core maintains on `<html>`:

| Class | Meaning |
| --- | --- |
| `radio-on` / `radio-off` | user tuned in / not |
| `radio-tuning` | connecting, buffering, or retrying |
| `radio-receiving` | audio flowing |
| `radio-live` | humans on air |
| `radio-rerun` | rerun playing |
| `radio-idle` | music through the static |
| `radio-offair` | bot disconnected |

Rules:
- One file, fully self-contained (external fonts OK). No shared CSS.
- Include the `<head>` meta block (copy from `classic-receiver.html`) so
  social embeds keep working.
- Never reimplement playback/polling — if you're writing `new Audio()` in a
  skin, stop.
- Respect `prefers-reduced-motion` for decorative animation.
- Palette is yours. The station brand is cream/teal/ink, but skins may go
  anywhere that still feels like anomaly.fm.

## Creating a skin from a source image

1. Study the reference image: identify where status, toggle, volume, and
   listener count live in that design.
2. Build the page: static layout first, then wire the five `data-radio`
   roles, then add state styling per the classes above.
3. Existing examples: `classic-receiver.html` (dial-as-toggle, knob rotates
   with state), `midnight-console.html` (terminal, text-driven states).

## Testing locally (no deploy)

```sh
cd web && python3 -m http.server 8080
open http://localhost:8080/skins/your-skin.html
```

On localhost the core automatically targets the LIVE station
(`https://anomaly.fm`) — real audio, real status. Checklist:

- [ ] auto-tunes or shows `TAP TO TUNE IN`; toggle works both ways
- [ ] status line shows the real current state and updates within 15s
- [ ] volume slider works and persists across a reload
- [ ] listener count appears
- [ ] kill the network briefly: `SIGNAL LOST — RETRYING`, then self-recovery
- [ ] looks right on a phone-width viewport

## OG image theme (optional)

The station's share image (`/og.png`) is re-rendered live by the `og`
service and themed to match the day's skin. When adding a skin, optionally
add a palette entry under your skin's filename in `og/themes.js` — otherwise
the OG image falls back to the classic-receiver palette. Preview with
`cd og && npm i && node test-render.js` (writes /tmp/og-test/*.png).

## Deploying

Drop the file in `web/skins/`, rsync to the box (standard deploy, requires
user approval per AGENTS.md). No container rebuilds: the rotation includes
it automatically. Preview any skin in production without touching the
homepage at `https://anomaly.fm/station/skins/<name>.html`.

/**
 * Dynamic OG image generator: polls feed/status.json and re-renders
 * web/og.png (1200x630) whenever the on-air state or the day's skin changes.
 *
 * - Who's talking: ON AIR members / RERUN label / INTERMISSION / OFF AIR,
 *   plus combined receiver count, straight from status.json.
 * - Theme: detected by byte-comparing web/current.html against web/skins/*,
 *   so it can never drift from the bot's rotation pick. Palettes in themes.js.
 *
 * Rendering is satori (JSX-free element trees) -> SVG -> resvg -> PNG.
 * No headless browser. Writes are atomic (tmp + rename) into the same dir
 * icecast serves via the /og.png alias. This service is fully independent of
 * the audio path: restarts have zero on-air impact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { THEMES, DEFAULT_THEME } from './themes.js';

const STATUS_FILE = process.env.STATUS_FILE || '/feed/status.json';
const WEB_DIR = process.env.WEB_DIR || '/web';
const POLL_MS = Number(process.env.OG_POLL_S || 15) * 1000;
const OUT_FILE = path.join(WEB_DIR, 'og.png');

const HOTLINE = process.env.HOTLINE_DISPLAY || '(361) 266-6259';
const WIDTH = 1200;
const HEIGHT = 630;

const fontDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const fonts = [
  { name: 'Pixelify Sans', data: fs.readFileSync(path.join(fontDir, 'PixelifySans-Regular.ttf')), weight: 400, style: 'normal' },
  { name: 'Pixelify Sans', data: fs.readFileSync(path.join(fontDir, 'PixelifySans-Bold.ttf')), weight: 700, style: 'normal' },
  { name: 'VT323', data: fs.readFileSync(path.join(fontDir, 'VT323.ttf')), weight: 400, style: 'normal' },
  { name: 'Inter', data: fs.readFileSync(path.join(fontDir, 'Inter-SemiBold.ttf')), weight: 600, style: 'normal' },
  { name: 'Inter', data: fs.readFileSync(path.join(fontDir, 'Inter-Bold.ttf')), weight: 700, style: 'normal' },
];

// --- helpers ---------------------------------------------------------------

const h = (type, style, ...children) => ({
  type,
  props: { style: { display: 'flex', ...style }, children: children.length === 1 ? children[0] : children },
});
const text = (style, content) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children: content } });

const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '\u2026' : s);

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Detect today's skin by byte-comparing current.html with each skin file. */
function detectSkin() {
  try {
    const current = fs.readFileSync(path.join(WEB_DIR, 'current.html'));
    const skinDir = path.join(WEB_DIR, 'skins');
    for (const f of fs.readdirSync(skinDir)) {
      if (!f.endsWith('.html')) continue;
      if (current.equals(fs.readFileSync(path.join(skinDir, f)))) return f.replace(/\.html$/, '');
    }
  } catch { /* fall through */ }
  return DEFAULT_THEME;
}

/** Reduce status.json to what the image shows. */
function airState(s) {
  if (!s) return { kind: 'offair', line: 'OFF AIR \u2014 static', sub: 'music through the static returns soon' };
  if (s.humans > 0) {
    return {
      kind: 'live',
      line: 'ON AIR \u2014 ' + truncate((s.members || []).join(', ') || 'the anomaly', 44),
      sub: `${s.humans} IN BOOTH \u00b7 live now`,
    };
  }
  if (s.stationIdent) return { kind: 'idle', line: 'STATION ID \u2014 ' + truncate(String(s.stationIdent.title || 'Anomaly FM'), 44), sub: 'from somewhere inside the anomaly' };
  const cue = s.automation && s.automation.current;
  if (cue) {
    const title = truncate(String(cue.title || 'Anomaly FM'), 44);
    const artist = cue.artist ? truncate(String(cue.artist), 36) : '';
    if (cue.type === 'rerun') return { kind: 'rerun', line: 'RERUN \u2014 ' + title, sub: artist || 'from the archive' };
    if (cue.type === 'hotline') return { kind: 'idle', line: 'HOTLINE \u2014 ' + title, sub: artist || 'listener transmission' };
    if (cue.type === 'music') return { kind: 'idle', line: 'NOW PLAYING \u2014 ' + title, sub: artist || 'through the static' };
    return { kind: 'idle', line: 'ANOMALY FM \u2014 ' + title, sub: artist || 'station transmission' };
  }
  if (s.rerun) return { kind: 'rerun', line: 'RERUN \u2014 ' + truncate(String(s.rerun), 44), sub: 'from the archive' };
  if (s.live) return { kind: 'idle', line: 'INTERMISSION', sub: 'music through the static' };
  return { kind: 'offair', line: 'OFF AIR \u2014 static', sub: 'music through the static returns soon' };
}

// --- layout ----------------------------------------------------------------

const BAR_HEIGHTS = [18, 34, 52, 28, 44, 60, 38, 50, 24, 42, 56, 30, 46, 20, 36, 54, 26, 40];

function image(t, air, listeners) {
  const liveColor = air.kind === 'live' ? t.live : air.kind === 'offair' ? t.offair : t.accent;
  const isPixel = t.bodyFont === 'Pixelify Sans';
  // Fit the status line into the space left of the spectrum (~660px), using
  // an average glyph-width factor per font. Falls back to wrapping at 26px.
  const lineLen = ((t.prompt || '') + air.line).length;
  const charFactor = isPixel ? 0.58 : 0.45;
  const statusSize = Math.max(26, Math.min(52, Math.floor(660 / (lineLen * charFactor))));
  const chipBorder = t.chipBorder ? `3px solid ${t.chipBorder}` : `3px solid ${t.panelBorder}`;

  const bgStyle = { backgroundColor: t.bg };
  if (t.bgGradient) bgStyle.backgroundImage = t.bgGradient;

  return h('div', {
    width: WIDTH, height: HEIGHT, flexDirection: 'column', justifyContent: 'space-between',
    ...bgStyle,
    padding: '56px 72px 48px', fontFamily: t.bodyFont, color: t.ink,
  },
    // top: chip + wordmark + tagline
    h('div', { flexDirection: 'column' },
      h('div', { alignItems: 'center', gap: 24 },
        text({
          backgroundColor: t.chipBg, color: t.chipText, border: chipBorder,
          padding: '6px 22px', fontSize: 34, letterSpacing: 2,
        }, '610 kHz AM'),
        text({ color: t.dim, fontSize: 34, letterSpacing: 3 }, 'EST \u00b7 PST \u00b7 WORLDWIDE'),
      ),
      text({
        fontFamily: t.wordmarkFont, fontSize: isPixel ? 118 : 132, fontWeight: 700,
        color: t.wordmarkColor || t.ink, marginTop: 18, letterSpacing: isPixel ? 0 : 4,
      }, 'ANOMALY.FM'),
      text({ fontSize: 33, letterSpacing: 5, color: t.dim, marginTop: 6 },
        'LIVE AM RADIO FROM A DISCORD VOICE CHANNEL'),
    ),

    // middle: status panel
    h('div', {
      flexDirection: 'column', backgroundColor: t.panel,
      border: `4px solid ${t.panelBorder}`, borderRadius: t.panelRadius,
      padding: '30px 40px 26px', marginTop: 30,
    },
      h('div', { alignItems: 'center', justifyContent: 'space-between', gap: 32 },
        text({ fontSize: statusSize, fontWeight: 700, color: liveColor },
          (t.prompt || '') + air.line),
        // decorative spectrum
        h('div', { alignItems: 'flex-end', gap: 6, height: 64, flexShrink: 0 },
          ...BAR_HEIGHTS.map((v) => text({
            width: 10, height: air.kind === 'offair' ? 8 : v, backgroundColor: liveColor,
          }, '')),
        ),
      ),
      h('div', { alignItems: 'center', justifyContent: 'space-between', gap: 40, marginTop: 14 },
        text({ fontSize: 30, color: t.dim, letterSpacing: 2 },
          (t.prompt || '') + air.sub.toUpperCase()),
        text({ fontSize: 30, color: t.ink, letterSpacing: 2, whiteSpace: 'nowrap', flexShrink: 0 },
          typeof listeners === 'number' ? `${listeners} RECEIVERS TUNED IN` : ' '),
      ),
    ),

    // bottom: call-in + platforms
    h('div', { alignItems: 'center', justifyContent: 'space-between' },
      h('div', {
        alignItems: 'center', gap: 18, backgroundColor: t.ink, color: t.bg,
        borderRadius: t.panelRadius > 12 ? 999 : 6, padding: '12px 34px',
      },
        text({ fontSize: 34, fontWeight: 700, letterSpacing: 2 }, 'CALL IN'),
        text({ fontFamily: t.numberFont, fontSize: 36, fontWeight: 700 }, HOTLINE),
      ),
      text({ fontSize: 32, color: t.dim, letterSpacing: 3 }, 'X \u00b7 YOUTUBE \u00b7 ANOMALY.FM'),
    ),
  );
}

// --- render loop -------------------------------------------------------------

async function render(skin, status) {
  const t = THEMES[skin] || THEMES[DEFAULT_THEME];
  const air = airState(status);
  const listeners = status && typeof status.listeners === 'number' ? status.listeners : null;
  const svg = await satori(image(t, air, listeners), { width: WIDTH, height: HEIGHT, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
  const tmp = path.join(WEB_DIR, '.og.png.tmp');
  fs.writeFileSync(tmp, png);
  fs.renameSync(tmp, OUT_FILE);
  return png.length;
}

let lastKey = '';

async function tick() {
  const status = readStatus();
  const skin = detectSkin();
  const air = airState(status);
  const key = JSON.stringify([skin, air.line, air.sub, status ? status.listeners : null]);
  if (key === lastKey) return;
  try {
    const bytes = await render(skin, status);
    lastKey = key;
    console.log(`[og] rendered ${OUT_FILE} (${bytes}b) skin=${skin} state="${air.line}"`);
  } catch (err) {
    console.error('[og] render failed:', err);
  }
}

console.log(`[og] watching ${STATUS_FILE}, writing ${OUT_FILE} every ${POLL_MS / 1000}s on change`);
await tick();
setInterval(tick, POLL_MS);

/**
 * Hourly time checks: at the top of each hour, when nobody is live (music
 * bed or rerun only), a short AI-written radio blurb is voiced by ElevenLabs
 * and aired through the mixer (bed/rerun duck under it, crackle applies).
 *
 * Script: Claude Haiku via opencode zen (Anthropic Messages API). Always
 * states the time in Eastern AND Pacific plus the weather in a rotating
 * major city (shuffled deck, no repeats until the deck runs out); may weave
 * in one extra detail (current rerun, audience size). If the LLM is
 * unreachable, a plain deterministic time check airs instead.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { config } from './config.js';
import type { PresenceSnapshot } from './feed.js';
import type { ListenerBreakdown } from './listeners.js';
import type { Mixer } from './mixer.js';
import { CityDeck, fetchWeather } from './weather.js';
import { prepareElevenLabsTts } from './tts.js';

interface AnnouncerDeps {
  mixer: Mixer;
  getSnapshot: () => PresenceSnapshot;
  getListeners: () => Promise<ListenerBreakdown>;
  /** Mutual exclusion with durable automation speech/hotline boundaries. */
  canStart?: () => boolean;
  reserve?: () => (() => void) | null;
  onStateChange?: (active: boolean, title: string | null) => void;
}

const SYSTEM_PROMPT = `You write spoken idents for anomaly.fm, a mysterious late-night AM radio station broadcasting "from somewhere inside the anomaly". Write ONLY the words to be spoken - no quotes, no stage directions, no emojis. 3-5 short sentences, under 90 words. Calm, warm, slightly uncanny late-night DJ energy.

Every ident MUST:
- state the current time in both Eastern and Pacific (spell times naturally, e.g. "eleven o'clock Eastern, eight o'clock Pacific")
- report the weather for the city provided, naming the city on air like a roving late-night weather desk checking in on some far-flung place
- mention that the station is on X, YouTube, and anomaly.fm (weave it in naturally, vary the phrasing)
- include the catchphrase exactly once: "where the anomaly here is only YOU" (lean into the YOU)

Every hour must feel DIFFERENT: vary the sentence order, openings, and phrasing. Follow the "tone for this hour" given by the user, and include one small moment of personality that fits it - a dry joke, a strange aside, a made-up micro-bulletin from inside the anomaly, radio-nerd trivia, or a warm word to whoever is still awake. Never reuse stock phrasing beyond the required catchphrase. If extra details are provided, weave in AT MOST ONE of them naturally.

For delivery, you may use [pause], [long pause], or [sigh] sparingly (at most six total, and at most two long pauses). Use no other bracketed or XML/SSML-style tags.`;

/** One is rolled each hour so consecutive idents never share a mood. */
const FLAVORS = [
  'deadpan dry humor - one understated joke',
  'cryptic: slip in a tiny fictional "transmission report" from inside the anomaly',
  'warm and sincere - a kind word for the night owls and insomniacs',
  'radio-nerd: one tiny true fact about AM radio, static, or the ionosphere',
  'playful conspiracy wink - the static knows more than it lets on',
  "weather-forward: banter about tonight's weather city like a cheerful old-timey weatherman",
  'sleepy surrealism - one image that is almost, but not quite, normal',
  'brisk and classic - clean top-of-the-hour energy like a 1960s station break',
];

const timeIn = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date());

/** Decode any audio buffer to the mixer's 48kHz stereo s16le PCM. */
export function decodeToPcm(audio: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ]);
    const out: Buffer[] = [];
    ff.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0 && out.length > 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`tts decode failed (code ${code})`)),
    );
    ff.stdin.on('error', () => {});
    ff.stdin.end(audio);
  });
}

export class Announcer {
  private timer: NodeJS.Timeout | null = null;
  private readonly cities = new CityDeck(config.feed.dir ? join(config.feed.dir, 'weather-deck.json') : '');

  constructor(private readonly deps: AnnouncerDeps) {}

  start(): void {
    console.log('[announcer] hourly time checks armed');
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Fires at :00:05 every hour. */
  private scheduleNext(): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 5, 0);
    this.timer = setTimeout(() => {
      void this.fire().finally(() => this.scheduleNext());
    }, next.getTime() - now.getTime());
  }

  async fire(_force = false, expiresAt = Date.now() + 115_000): Promise<{ fired: boolean; reason?: string }> {
    let release: (() => void) | null = null;
    let airing = false;
    try {
      if (this.deps.getSnapshot().humans > 0) {
        console.log('[announcer] live show on air; skipping time check');
        return { fired: false, reason: 'live show on air' };
      }
      if (!this.deps.canStart?.() && this.deps.canStart) return { fired: false, reason: 'automation speech pending or active' };
      if (this.deps.reserve) {
        release = this.deps.reserve();
        if (!release) return { fired: false, reason: 'automation speech reservation unavailable' };
      }
      const script = await this.writeScript();
      console.log(`[announcer] script: ${script}`);
      const pcm = await this.speak(script);
      // Someone may have gone live while we were generating.
      if (this.deps.getSnapshot().humans > 0) {
        console.log('[announcer] went live during generation; discarding');
        return { fired: false, reason: 'went live during generation' };
      }
      if (Date.now() >= expiresAt) return { fired: false, reason: 'ident expired before air' };
      if (!release && !this.deps.canStart?.() && this.deps.canStart) return { fired: false, reason: 'automation speech became pending' };
      if (!this.deps.mixer.tryPlayAnnouncement(pcm)) return { fired: false, reason: 'announcement slot busy' };
      airing = true;
      this.deps.onStateChange?.(true, 'Hourly time check');
      this.deps.mixer.onAnnouncementEnded = () => { this.deps.onStateChange?.(false, null); release?.(); };
      console.log(`[announcer] on air (~${Math.round(pcm.length / (48000 * 4))}s)`);
      return { fired: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn('[announcer] skipped:', reason);
      return { fired: false, reason };
    } finally {
      if (!airing) release?.();
    }
  }

  async writeScript(): Promise<string> {
    const eastern = timeIn('America/New_York');
    const pacific = timeIn('America/Los_Angeles');
    const fallback = `It's ${eastern} Eastern, ${pacific} Pacific. Weather is unavailable this hour. Find us on X, YouTube, and anomaly.fm, where the anomaly here is only YOU.`;
    const { zenKey, zenUrl, zenModel } = config.announcer;
    if (!zenKey) return fallback;

    const extras: string[] = [];
    const snapshot = this.deps.getSnapshot();
    if (snapshot.rerun) extras.push(`Currently replaying a past broadcast: "${snapshot.rerun}"`);
    try {
      const listeners = await this.deps.getListeners();
      if (listeners.total !== null && listeners.total > 0) {
        extras.push(`${listeners.total} listener${listeners.total === 1 ? '' : 's'} tuned in right now`);
      }
    } catch { /* optional */ }
    const city = await this.cities.next();
    const weather = await fetchWeather(city);

    const user = [
      `Current time: ${eastern} Eastern / ${pacific} Pacific.`,
      weather
        ? `Weather in ${city.name}: ${weather}.`
        : 'Weather unavailable this hour (skip it).',
      `Tone for this hour: ${FLAVORS[Math.floor(Math.random() * FLAVORS.length)]}.`,
      extras.length ? `Optional details (use at most one):\n- ${extras.join('\n- ')}` : 'No extra details this hour.',
    ].join('\n');

    try {
      const res = await fetch(zenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': zenKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: zenModel,
          max_tokens: 250,
          temperature: 1,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`zen HTTP ${res.status}`);
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = data.content?.find((c) => c.type === 'text')?.text?.trim().replace(/\s+/g, ' ');
      if (!text) throw new Error('zen returned no text');
      // Strip accidental LLM markup before it can become either an audit line
      // or provider input. The allowed directions remain human-readable.
      return prepareElevenLabsTts(text.slice(0, 500), config.announcer.modelId, 'strip').auditText;
    } catch (error) {
      console.warn('[announcer] llm failed, using plain time check:', error instanceof Error ? error.message : error);
      return fallback;
    }
  }

  async speak(text: string): Promise<Buffer> {
    const { elevenLabsKey, voiceId, modelId, speechSpeed } = config.announcer;
    const tts = prepareElevenLabsTts(text, modelId);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': elevenLabsKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: tts.requestText,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: speechSpeed },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`elevenlabs HTTP ${res.status}`);
    return decodeToPcm(Buffer.from(await res.arrayBuffer()));
  }

}

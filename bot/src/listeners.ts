/**
 * Listener counting. Internal consumers (TV encoder, session recorder) connect
 * to Icecast with a marker user-agent; when the admin password is available we
 * count via the admin API and exclude them, so public counts reflect humans.
 */

import { config } from './config.js';

export const INTERNAL_USER_AGENT = 'anomalyfm-internal';

interface IcecastSource {
  listenurl?: string;
  listeners?: number;
}

function mountPath(): string {
  return config.icecast.mount.startsWith('/') ? config.icecast.mount : `/${config.icecast.mount}`;
}

async function fetchFiltered(): Promise<number | null> {
  if (!config.icecast.adminPassword) return null;
  try {
    const auth = Buffer.from(`admin:${config.icecast.adminPassword}`).toString('base64');
    const res = await fetch(
      `http://${config.icecast.host}:${config.icecast.port}/admin/listclients?mount=${mountPath()}`,
      { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return null;
    const xml = await res.text();
    const total = (xml.match(/<listener>/gi) ?? []).length;
    const internal = (xml.match(new RegExp(`<useragent>[^<]*${INTERNAL_USER_AGENT}[^<]*</useragent>`, 'gi')) ?? []).length;
    return Math.max(0, total - internal);
  } catch {
    return null;
  }
}

async function fetchPublic(): Promise<number | null> {
  try {
    const res = await fetch(
      `http://${config.icecast.host}:${config.icecast.port}/status-json.xsl`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return null;
    const stats = (await res.json()) as { icestats?: { source?: IcecastSource | IcecastSource[] } };
    const source = stats.icestats?.source;
    if (!source) return 0;
    const sources = Array.isArray(source) ? source : [source];
    const match = sources.find((entry) => entry.listenurl?.endsWith(mountPath()));
    return match?.listeners ?? 0;
  } catch {
    return null;
  }
}

/** Human listener count: admin-filtered when possible, raw public count otherwise. */
export async function fetchListeners(): Promise<number | null> {
  return (await fetchFiltered()) ?? (await fetchPublic());
}

// YouTube concurrent viewers, cached 5 minutes to respect API quota
// (~288 units/day at 1 unit/call, alongside the chat bridge's ~9.6k).
const YT_VIEWERS_TTL_MS = 5 * 60_000;
let ytCache = { at: 0, viewers: null as number | null };

async function fetchYouTubeViewers(): Promise<number | null> {
  const { apiKey, videoId } = config.youtube;
  if (!apiKey || !videoId) return null;
  if (Date.now() - ytCache.at < YT_VIEWERS_TTL_MS) return ytCache.viewers;
  ytCache = { at: Date.now(), viewers: ytCache.viewers };
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return (ytCache.viewers = null);
    const data = (await res.json()) as {
      items?: { liveStreamingDetails?: { concurrentViewers?: string } }[];
    };
    const raw = data.items?.[0]?.liveStreamingDetails?.concurrentViewers;
    ytCache.viewers = raw !== undefined ? Number(raw) : null;
  } catch {
    ytCache.viewers = null;
  }
  return ytCache.viewers;
}

export interface ListenerBreakdown {
  web: number | null;
  youtube: number | null;
  /** web + youtube; null only when neither source is reachable. */
  total: number | null;
}

export async function fetchAllListeners(): Promise<ListenerBreakdown> {
  const [web, youtube] = await Promise.all([fetchListeners(), fetchYouTubeViewers()]);
  const total = web === null && youtube === null ? null : (web ?? 0) + (youtube ?? 0);
  return { web, youtube, total };
}

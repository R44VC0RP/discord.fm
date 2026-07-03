/**
 * YouTube live chat -> Discord bridge.
 *
 * Uses API-key-only access (works for public streams): resolve the video's
 * activeLiveChatId, then poll liveChat/messages with page tokens. Quota math:
 * liveChatMessages.list costs ~5 units and the default budget is 10k/day, so
 * the poll floor defaults to 45s (~9.6k units/day for a 24/7 stream).
 *
 * X (Twitter) has no public API for broadcast chat, so there is no X bridge.
 */

const API = 'https://www.googleapis.com/youtube/v3';
const RESOLVE_RETRY_MS = 5 * 60_000;

interface ChatMessage {
  id: string;
  snippet?: { displayMessage?: string };
  authorDetails?: { displayName?: string };
}

interface ChatResponse {
  items?: ChatMessage[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
}

export class YouTubeChatBridge {
  private liveChatId: string | null = null;
  private pageToken: string | undefined;
  private skipBacklog = true;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastErrorLog = 0;

  constructor(
    private readonly apiKey: string,
    private readonly videoId: string,
    private readonly pollFloorMs: number,
    private readonly post: (text: string) => void,
  ) {}

  start(): void {
    console.log(`[ytchat] bridge armed for video ${this.videoId} (poll floor ${this.pollFloorMs / 1000}s)`);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    let delay = this.pollFloorMs;
    try {
      if (!this.liveChatId) {
        await this.resolveChatId();
        if (!this.liveChatId) delay = RESOLVE_RETRY_MS;
      } else {
        delay = await this.poll();
      }
    } catch (error) {
      const now = Date.now();
      if (now - this.lastErrorLog > 60_000) {
        this.lastErrorLog = now;
        console.warn('[ytchat]', error instanceof Error ? error.message : error);
      }
    }
    this.timer = setTimeout(() => void this.loop(), delay);
  }

  private async resolveChatId(): Promise<void> {
    const url = `${API}/videos?part=liveStreamingDetails&id=${this.videoId}&key=${this.apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`videos.list HTTP ${res.status}`);
    const data = (await res.json()) as {
      items?: { liveStreamingDetails?: { activeLiveChatId?: string } }[];
    };
    const chatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
    if (chatId && chatId !== this.liveChatId) {
      this.liveChatId = chatId;
      this.pageToken = undefined;
      this.skipBacklog = true;
      console.log('[ytchat] live chat connected');
    } else if (!chatId) {
      console.warn('[ytchat] video has no active live chat (stream offline?); retrying later');
    }
  }

  private async poll(): Promise<number> {
    const params = new URLSearchParams({
      liveChatId: this.liveChatId!,
      part: 'snippet,authorDetails',
      maxResults: '200',
      key: this.apiKey,
    });
    if (this.pageToken) params.set('pageToken', this.pageToken);
    const res = await fetch(`${API}/liveChat/messages?${params}`, { signal: AbortSignal.timeout(10_000) });

    if (res.status === 403 || res.status === 404) {
      // liveChatEnded / liveChatNotFound: broadcast rolled over, re-resolve.
      console.warn(`[ytchat] chat ended (HTTP ${res.status}); re-resolving`);
      this.liveChatId = null;
      return this.pollFloorMs;
    }
    if (!res.ok) throw new Error(`liveChat.messages HTTP ${res.status}`);

    const data = (await res.json()) as ChatResponse;
    this.pageToken = data.nextPageToken;

    if (this.skipBacklog) {
      // First page returns chat history; start bridging from "now".
      this.skipBacklog = false;
    } else {
      for (const item of data.items ?? []) {
        const author = item.authorDetails?.displayName ?? 'someone';
        const text = item.snippet?.displayMessage ?? '';
        if (text) this.post(`[YT] ${author}: ${text}`);
      }
    }

    if (data.offlineAt) {
      this.liveChatId = null;
      return RESOLVE_RETRY_MS;
    }
    return Math.max(data.pollingIntervalMillis ?? 0, this.pollFloorMs);
  }
}

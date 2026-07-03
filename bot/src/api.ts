/**
 * Internal control API, consumed by the admin panel over the docker network.
 * Never exposed publicly (the Caddy host-router only forwards the admin app,
 * which authenticates before proxying here).
 */

import http from 'node:http';
import type { PresenceSnapshot } from './feed.js';
import type { ListenerBreakdown } from './listeners.js';
import type { Mixer } from './mixer.js';
import type { RerunManager } from './rerun.js';

export interface ApiDeps {
  mixer: Mixer;
  rerun: RerunManager;
  getSnapshot: () => PresenceSnapshot;
  getListeners: () => Promise<ListenerBreakdown>;
  getMusicTrack: () => string;
  setMusicTrack: (file: string) => Promise<void>;
  queueVoicemail: (file: string) => number;
  getVoicemailQueue: () => string[];
  voicemailReceived: (file: string) => Promise<void>;
  announce: (force: boolean) => Promise<{ fired: boolean; reason?: string }>;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function startApi(deps: ApiDeps, port = 8090): void {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const route = `${req.method} ${url.pathname}`;

      switch (route) {
        case 'GET /state':
          return send(200, {
            snapshot: deps.getSnapshot(),
            music: { state: deps.mixer.musicState, track: deps.getMusicTrack() },
            listeners: await deps.getListeners(),
            rerun: await deps.rerun.state(),
            voicemails: { queue: deps.getVoicemailQueue(), airing: deps.mixer.announcing },
          });
        case 'POST /rerun/queue': {
          const body = await readJson(req);
          if (typeof body.file !== 'string' || !/^[\w.-]+\.mp3$/.test(body.file)) {
            return send(400, { error: 'invalid file' });
          }
          deps.rerun.enqueue(body.file);
          return send(200, await deps.rerun.state());
        }
        case 'POST /rerun/unqueue': {
          const body = await readJson(req);
          deps.rerun.unqueue(Number(body.index));
          return send(200, await deps.rerun.state());
        }
        case 'POST /rerun/skip':
          deps.rerun.skip();
          return send(200, await deps.rerun.state());
        case 'POST /rerun/auto': {
          const body = await readJson(req);
          deps.rerun.setAuto(Boolean(body.enabled));
          return send(200, await deps.rerun.state());
        }
        case 'POST /voicemail/received': {
          const body = await readJson(req);
          if (typeof body.file !== 'string' || !/^[\w.-]+\.mp3$/.test(body.file)) {
            return send(400, { error: 'invalid file' });
          }
          await deps.voicemailReceived(body.file);
          return send(200, { ok: true });
        }
        case 'POST /announce': {
          const body = await readJson(req);
          return send(200, await deps.announce(Boolean(body.force)));
        }
        case 'POST /voicemail/play': {
          const body = await readJson(req);
          if (typeof body.file !== 'string' || !/^[\w.-]+\.mp3$/.test(body.file)) {
            return send(400, { error: 'invalid file' });
          }
          const position = deps.queueVoicemail(body.file);
          return send(200, { queued: position });
        }
        case 'POST /music/track': {
          const body = await readJson(req);
          if (typeof body.file !== 'string' || !/^[\w.-]+\.mp3$/.test(body.file)) {
            return send(400, { error: 'invalid file' });
          }
          await deps.setMusicTrack(body.file);
          return send(200, { track: deps.getMusicTrack() });
        }
        default:
          return send(404, { error: 'not found' });
      }
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : 'internal error' });
    }
  });
  server.listen(port, '0.0.0.0', () => console.log(`[api] control api on :${port}`));
}

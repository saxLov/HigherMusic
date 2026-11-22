import { artwork, backgrounds } from '../gallery.mjs';

export function createMediaRoutes({ json, audioProxy, artworkGateway, kugouMediaFetch, resolveLyrics, sessions, call, localFiles, audioCache }) {
  return {
    "GET /api/audio": async ({ req, res, s, u }) => {
      return audioProxy(req, res, s, u.searchParams.get('ticket'), undefined, kugouMediaFetch, audioCache);
    },
    "GET /api/artwork": async ({ res, s, u }) => {
      return artworkGateway.serve(res, s, u.searchParams.get('ticket'));
    },
    "GET /api/proxy": async ({ req, res, s, u }) => {
      const ticket = u.searchParams.get('ticket');
      if (localFiles && /^[a-f0-9]{48}$/.test(ticket ?? '') && s.localMedia?.has(ticket))
        return localFiles.serve(req, res, s, ticket);
      if (s.user && /^[a-f0-9]{48}$/.test(ticket ?? '') && s.media?.has(ticket))
        return audioProxy(req, res, s, ticket, undefined, kugouMediaFetch, audioCache);
      if (s.user && /^[a-f0-9]{64}$/.test(ticket ?? '') && s.artwork?.has(ticket))
        return artworkGateway.serve(res, s, ticket);
      return json(res, 404, { error: '资源票据不可用' });
    },
    "GET /api/audio-status": async ({ res, s, u }) => {
      const item = s.user && s.media?.get(u.searchParams.get('ticket'));
      return item && item.expires > Date.now()
        ? json(res, 200, { failure: item.failure ?? null,
            protocols: item.protocols, attempts: item.attempts ?? [] })
        : json(res, 404, { error: '播放凭据已失效' });
    },
    "GET /api/lyrics": async ({ res, s, u, sid }) => {
      if (!s.user) return json(res, 401, { error: '请先扫码登录' });
      const id = u.searchParams.get('track');
      const track = s.tracks.get(id) ?? s.searchTracks?.get(id);
      if (!track) return json(res, 404, { error: '歌曲不属于当前会话' });
      const control = new AbortController();
      res.once('close', () => control.abort());
      const result = await resolveLyrics(s, track, s.playbackSources?.get(id), control.signal);
      if (res.destroyed) return;
      if (sessions.get(sid) !== s) return json(res, 401, { error: '登录已失效' });
      return json(res, 200, result);
    },
    "GET /api/backgrounds": async ({ res }) => {
      return json(res, 200, { images: await backgrounds() });
    },
    "GET /api/cover": async ({ res, s, u }) => {
      const id = u.searchParams.get('track');
      const track = s.tracks.get(id) ?? s.searchTracks?.get(id);
      if (!track) return json(res, 404, { error: '歌曲不属于当前会话' });
      if (track.provider && track.provider !== 'kugou') return json(res, 200, { cover: track.cover }, s);
      return json(res, 200, { cover: await artwork(s, track, call) }, s);
    },
  };
}

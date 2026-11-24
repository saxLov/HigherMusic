import http from 'node:http';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLocalLibrary, LibraryError } from './lib/local-library.mjs';
import { createHistoryReporter, HistoryError } from './lib/history.mjs';
import { createMusicSources } from './lib/sources/index.mjs';
import { createLyricsResolver } from './lib/lyrics.mjs';
import { createNeteaseSource } from './lib/sources/netease.mjs';
import { createKugouSearch } from './lib/sources/kugou.mjs';
import { createInspector } from './lib/inspection.mjs';
import { proxyAudio } from './lib/media-proxy.mjs';
import { createArtworkGateway } from './lib/gateway/artwork.mjs';
import { call as providerCall } from './lib/provider.mjs';
import { openSession, sessionExpiry, createSessionRoutes } from './lib/routes/session.mjs';
import { createMediaRoutes } from './lib/routes/media.mjs';
import { createPlaybackRoutes } from './lib/routes/playback.mjs';
import { createHistoryRoutes } from './lib/routes/history.mjs';
import { createLibraryRoutes } from './lib/routes/library.mjs';
import { createPlatformRoutes } from './lib/routes/platform.mjs';
import { createLocalFileRoutes } from './lib/routes/local-files.mjs';
import { createCacheRoutes } from './lib/routes/cache.mjs';
import { createLocalFileSource } from './lib/local-files.mjs';
import { policy, serveStatic } from './lib/routes/static.mjs';

async function loadAdapter(name) {
  const url = new URL(`./lib/${name}.mjs`, import.meta.url);
  const file = await stat(url);
  return import(url.href + '?v=' + file.mtimeMs);
}

// These endpoints own their own authorization and do not occupy the business lock.
const independent = new Set([
  'GET /api/session', 'POST /api/logout',
  'GET /api/audio', 'GET /api/artwork', 'GET /api/proxy', 'GET /api/audio-status', 'GET /api/lyrics',
  'POST /api/play-started', 'POST /api/source-unavailable', 'POST /api/report_history',
]);
const parallel = new Set(['POST /api/play', 'POST /api/prepare', 'GET /api/playlists', 'GET /api/tracks', 'POST /api/rights-warm']);
const loginActions = new Set(['POST /api/login', 'GET /api/login/status']);
const localActions = new Set(['GET /api/providers', 'GET /api/local-files', 'POST /api/local-play',
  'POST /api/local-remove', 'GET /api/local-lyrics', 'POST /api/local-started', 'POST /api/local-inspect']);

export function createMusicServer({
  request = providerCall,
  loginStore,
  inspectAccess,
  localLibrary,
  sources,
  localFiles,
  audioCache,
  adapters = loadAdapter,
  audioProxy = proxyAudio,
  artworkFetch,
  audioPrefetch = process.env.HIGHER_MUSIC_AUDIO_PREFETCH !== '0',
  audioPrefetchDelayMs,
  kugouMediaFetch,
  authorize = () => true,
} = {}) {
  const ownsLibrary = localLibrary === undefined;
  localLibrary ??= createLocalLibrary(process.env.HIGHER_MUSIC_LIBRARY);
  sources ??= createMusicSources([
    createKugouSearch(request, async (...args) => (await adapters('access')).checkAccess(...args)),
    createNeteaseSource(), ...(localFiles ? [createLocalFileSource(localFiles)] : []),
  ], { library: localLibrary });
  const sessions = new Map();
  const artworkGateway = createArtworkGateway(artworkFetch);
  const inspect = createInspector(inspectAccess || (async (...args) =>
    (await adapters('access')).checkAccess(...args)));
  const cleanup = setInterval(() => {
    for (const [key, s] of sessions)
      if (Date.now() - s.touched > sessionExpiry) { s.playRequest?.abort(); s.cancelPreparation?.(); s.rightsWarmControl?.abort(); sessions.delete(key); }
  }, 60000).unref();

  function json(res, status, data, coverSession) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, coverSession
      ? (key, value) => key === 'cover' ? artworkGateway.issue(coverSession, value) : value
      : undefined));
  }

  const routes = new Map(Object.entries({
    ...createSessionRoutes({ json, call: request, sessions, loginStore }),
    ...createMediaRoutes({ json, audioProxy, artworkGateway, kugouMediaFetch, localFiles, audioCache,
      resolveLyrics: createLyricsResolver({ call: request, sources }), sessions, call: request }),
    ...createPlaybackRoutes({ json, localLibrary, sessions, adapter: adapters, sources,
      audioPrefetch, audioPrefetchDelayMs, audioCache }),
    ...createHistoryRoutes({ json, sessions, reportHistory: createHistoryReporter(request) }),
    ...createLibraryRoutes({ json, localLibrary, adapter: adapters, call: request, inspect, sources, audioCache, sessions }),
    ...createPlatformRoutes({ json, call: request, adapter: adapters, sources }),
    ...createLocalFileRoutes({ json, files: localFiles, sources }),
    ...createCacheRoutes({ json, audioCache }),
  }));

  const server = http.createServer(async (req, res) => {
    if (!authorize(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', policy());
    const u = new URL(req.url, 'http://localhost');
    try {
      if (!u.pathname.startsWith('/api/')) return await serveStatic(req, res, u, json);
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}` && origin !== process.env.PUBLIC_ORIGIN) ||
          req.headers['sec-fetch-site'] === 'cross-site')
        return json(res, 403, { error: '请求来源无效' });

      const { sid, s } = openSession(req, res, sessions);
      const action = `${req.method} ${u.pathname}`;
      if (/^\/api\/(?:local-|cache(?:$|\/)|search$|remember$)/.test(u.pathname)) return json(res, 404, { error: '此功能不可用' });
      const context = { req, res, s, sid, u, action };
      const handler = routes.get(action);
      if (independent.has(action) || localActions.has(action) || action === 'GET /api/cache' || action === 'POST /api/cache') return await handler(context);

      if (parallel.has(action)) {
        if (!s.user) throw new Error('请先扫码登录。');
        return await handler(context);
      }
      if (s.busy) return json(res, 429, { error: '上一个操作尚未完成，请稍候。' });
      s.busy = true;
      try {
        if (!s.user && !loginActions.has(action)) throw new Error('请先扫码登录。');
        if (handler) return await handler(context);
        return json(res, 404, { error: '接口不存在' });
      } finally { s.busy = false; }
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof HistoryError || error instanceof LibraryError ? error.status : 502,
        { error: error instanceof Error ? error.message : '请求失败，请重试' });
    }
  });
  server.on('close', () => {
    clearInterval(cleanup);
    for (const s of sessions.values()) { s.playRequest?.abort(); s.cancelPreparation?.(); s.rightsWarmControl?.abort(); }
    if (ownsLibrary) localLibrary.close();
  });
  return server;
}

export const server = createMusicServer();
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3211);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`音乐网页已启动：http://${host}:${port}`));
}

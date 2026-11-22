import { readHistoryBody } from '../history.mjs';
import { instrumentalLyrics } from '../gallery.mjs';

export function createLocalFileRoutes({ json, files, sources }) {
  const requireFiles = () => { if (!files) throw new Error('本地文件功能仅在桌面版启用'); };
  return {
    'GET /api/providers': ({ res }) => json(res, 200, { providers: sources.describe?.() ?? [] }),
    'GET /api/local-files': async ({ res }) => {
      requireFiles(); return json(res, 200, await files.list());
    },
    'POST /api/local-remove': async ({ res, u }) => {
      requireFiles(); files.remove(u.searchParams.get('track')); return json(res, 200, { ok: true });
    },
    'POST /api/local-play': async ({ res, s, u }) => {
      requireFiles();
      const control = new AbortController();
      res.once('close', () => control.abort());
      try {
        const result = await sources.play(s, { provider: 'local', id: u.searchParams.get('track') }, { signal: control.signal });
        if (!res.destroyed) return json(res, 200, files.issue(s, result));
      } catch {
        if (!res.destroyed) return json(res, 200, { state: 'unknown', playbackState: 'unavailable',
          reason: '本地文件不可用，请重新导入' });
      }
    },
    'POST /api/local-inspect': async ({ res, u }) => {
      requireFiles();
      try {
        await files.detail({ id: u.searchParams.get('track') });
        return json(res, 200, { state: 'allowed', playbackState: 'allowed', playable: true });
      } catch { return json(res, 200, { state: 'unknown', playbackState: 'unavailable', playable: false,
        reason: '本地文件不可用，请重新导入' }); }
    },
    'GET /api/local-lyrics': async ({ res, u }) => {
      requireFiles();
      const lyrics = await files.lyrics({ id: u.searchParams.get('track') });
      const track = await files.detail({ id: u.searchParams.get('track') });
      const instrumental = instrumentalLyrics(lyrics) ||
        /[（(【\[]\s*(?:instrumental(?:\s+version)?|纯音乐|伴奏(?:版)?)\s*[）)】\]]\s*$/iu.test(track.title);
      return json(res, 200, { lyrics, state: instrumental ? 'instrumental' : lyrics ? 'ready' : 'missing' });
    },
    'POST /api/local-started': async ({ req, res, s }) => {
      requireFiles(); const { songId, playbackToken } = await readHistoryBody(req);
      return files.started(s, songId, playbackToken) ? json(res, 200, { ok: true })
        : json(res, 403, { error: '播放凭据已失效' });
    },
  };
}

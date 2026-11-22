import { readHistoryBody } from '../history.mjs';

export function createHistoryRoutes({ json, sessions, reportHistory }) {
  return {
    "POST /api/report_history": async ({ req, res, s, sid }) => {
      if (!s.user) return json(res, 401, { error: '请先扫码登录' });
      const body = await readHistoryBody(req);
      // 读取请求体期间另一标签页可能已经退出；旧 session 不能再发起上报。
      if (sessions.get(sid) !== s || !s.user) return json(res, 401, { error: '登录已失效' });
      const source = s.playbackSources?.get(body.songId);
      if (source?.provider && source.provider !== 'kugou')
        return json(res, 200, { ok: true, skipped: 'foreign_source' });
      if (!source || !source.started || !source.history || source.playbackToken !== body.playbackToken ||
          source.expiresAt < Date.now())
        return json(res, 403, { error: '当前播放凭据已失效' });
      return json(res, 200, await reportHistory(s, body));
    },
  };
}

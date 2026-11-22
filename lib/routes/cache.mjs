import { readHistoryBody } from '../history.mjs';
export function createCacheRoutes({ json, audioCache }) {
  return {
    'GET /api/cache': ({ res }) => json(res, 200, audioCache?.stats() ?? { available: false }),
    'POST /api/cache': async ({ req, res }) => {
      if (!audioCache) return json(res, 503, { error: '磁盘缓存不可用' });
      const input = await readHistoryBody(req);
      if (input.action === 'clear') audioCache.clear();
      else if (input.action === 'enabled') audioCache.setEnabled(input.value);
      else return json(res, 400, { error: '缓存操作无效' });
      return json(res, 200, audioCache.stats());
    },
  };
}

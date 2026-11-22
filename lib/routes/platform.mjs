export function createPlatformRoutes({ json, call, adapter, sources }) {
  return {
    "GET /api/search": async ({ res, s, u }) => {
      const query = (u.searchParams.get('q') ?? '').trim();
      if (!query || query.length > 140 || /[\u0000-\u001f]/.test(query))
        return json(res, 400, { error: '请输入 1–140 字的歌名或歌手' });
      const result = await sources.search(s, query);
      s.searchTracks ??= new Map();
      for (const track of result.tracks) {
        s.searchTracks.delete(track.id);
        s.searchTracks.set(track.id, track);
      }
      while (s.searchTracks.size > 256) s.searchTracks.delete(s.searchTracks.keys().next().value);
      return json(res, 200, result, s);
    },
    "GET /api/account-diagnostics": async ({ res, s }) => {
      const mod = await adapter('account');
      return json(res, 200, await mod.diagnostics(s, call));
    },
    "GET /api/legacy-diagnostics": async ({ res, s }) => {
      const shape = (v, depth = 0) => {
        if (depth > 6) return '…';
        if (Array.isArray(v))
          return {
            length: v.length,
            sample: v.slice(0, 1).map((x) => shape(x, depth + 1)),
          };
        if (v && typeof v === 'object')
          return Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !/token|cookie|auth|userid|openid|url/i.test(k))
              .map(([k, x]) => [k, shape(x, depth + 1)]),
          );
        return typeof v === 'string' ? `string(${v.length})` : v;
      };
      const output = {};
      for (const name of [
        'user_purchased_songs',
        'user_purchased_albums',
        'user_vip_detail',
      ]) {
        try {
          output[name] = shape(await call(s, name, { page: 1, pagesize: 100 }));
        } catch (e) {
          output[name] = { error: e.message };
        }
      }
      return json(res, 200, output);
    },
  };
}

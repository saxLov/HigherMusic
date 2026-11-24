import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../scripts/preview.mjs';

test('歌词HTTP链路：注册歌曲、实际播放来源、缓存、未知歌曲与退出隔离', async () => {
  const { server, calls } = createPreview();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  try {
    const start = await fetch(base + 'session');
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const send = async (route, method = 'GET') => {
      const response = await fetch(base + route, { method, headers: { Cookie: cookie } });
      return { status: response.status, data: await response.json() };
    };
    assert.notEqual((await send('lyrics?track=1001')).status, 200);
    await send('login', 'POST'); await send('login/status');
    await send('playlists');
    const tracks = (await send('tracks?playlist=1')).data.tracks;
    const firstId = encodeURIComponent(tracks[0].id), fallbackId = encodeURIComponent(tracks[25].id);
    const first = await send('lyrics?track=' + firstId);
    assert.equal(first.status, 200);
    assert.equal(first.data.state, 'ready');
    assert.equal(first.data.provider, 'kugou');
    assert.match(first.data.lyrics, /\[00:05\]/);
    const count = calls.length;
    assert.equal((await send('lyrics?track=' + firstId)).data.cached, true);
    assert.equal(calls.length, count);
    const play = await send('play?track=' + fallbackId, 'POST');
    assert.equal(play.data.playbackSource.provider, 'netease');
    assert.equal((await send('lyrics?track=' + fallbackId)).data.provider, 'netease');
    assert.equal((await send('lyrics?track=unknown')).status, 404);
    await send('logout', 'POST');
    assert.notEqual((await send('lyrics?track=' + firstId)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('慢歌词不占会话业务锁，退出后迟到结果不能返回给旧会话', async () => {
  let started, finish;
  const lyricStarted = new Promise(resolve => { started = resolve; });
  const pendingLyrics = new Promise(resolve => { finish = resolve; });
  const { server } = createPreview({
    sources: {
      search: async () => ({ tracks: [{ id: 'netease:7', provider: 'netease', sourceId: '7' }] }),
      lyrics: () => { started(); return pendingLyrics; },
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  try {
    const cookie = (await fetch(base + 'session')).headers.get('set-cookie').split(';')[0];
    const send = (route, method = 'GET') => fetch(base + route, { method, headers: { Cookie: cookie } });
    await send('login', 'POST');
    await send('login/status');
    await send('search?q=track');
    const lyric = send('lyrics?track=netease%3A7');
    await lyricStarted;
    assert.equal((await send('playlists')).status, 200);
    await send('logout', 'POST');
    finish('[00:01]test');
    assert.equal((await lyric).status, 401);
  } finally {
    finish('');
    await new Promise(resolve => server.close(resolve));
  }
});

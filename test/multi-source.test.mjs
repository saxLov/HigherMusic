import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseRecording } from '../lib/sources/match.mjs';
import { createNeteaseSource } from '../lib/sources/netease.mjs';
import { createPreview } from '../scripts/preview.mjs';

test('自动降级拒绝错歌手、DJ、翻唱、时长差和无专辑证据的同名多版本', () => {
  const original = { title: 'Singer - Gravity.mp3', artist: 'Singer', duration: 240, album: 'First' };
  const match = { id: '1', title: 'Gravity', artist: 'Singer', duration: 241, album: 'First' };
  const wrong = [
    { ...match, id: '2', title: 'Gravity (DJ Mix)' },
    { ...match, id: '3', artist: 'Singer Two' },
    { ...match, id: '4', isCover: true },
    { ...match, id: '5', version: 'Live' },
    { ...match, id: '6', duration: 246 },
  ];
  assert.equal(chooseRecording(original, wrong), null);
  assert.equal(chooseRecording(original, [...wrong, match]), match);
  const closest = { ...match, id: '8', duration: 240 };
  assert.equal(chooseRecording(original, [match, closest]), closest);
  assert.equal(chooseRecording({ ...original, album: '' }, [match, { ...match, id: '7' }]), null);
  assert.equal(chooseRecording(original, [match, { ...match, id: '7', album: 'Second' }]), match);
});

test('网易云播放只接受授权状态明确的完整音源，并限制 CDN', async () => {
  const valid = { id: 7, code: 200, fee: 8, time: 240000, url: 'http://m10.music.126.net/full.mp3' };
  const track = { sourceId: '7', duration: 240 };
  for (const change of [{ fee: 1 }, { freeTrialInfo: {} }, { id: 8 }, { time: 30000 },
    { url: 'https://m10.music.126.net.evil.invalid/full.mp3' }, { url: 'https://127.0.0.1/file' }]) {
    const source = createNeteaseSource(async () => ({ data: [{ ...valid, ...change }] }));
    assert.equal(await source.resolve(track), null);
  }
  const source = createNeteaseSource(async () => ({ data: [valid] }));
  assert.equal((await source.resolve(track)).url, 'https://m10.music.126.net/full.mp3');
});

test('搜索与备用播放走同源票据；试听候选失败；跨源播放不记酷狗历史', async () => {
  const { server, calls } = createPreview();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const start = await fetch(base + '/api/session');
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const send = async (route, method = 'GET', body) => {
      const r = await fetch(base + '/api/' + route, { method, headers: { Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    };
    await send('login', 'POST'); await send('login/status');
    assert.equal((await send('play?track=netease%3A26', 'POST')).status, 404);
    const found = (await send('search?q=' + encodeURIComponent('测试歌曲 26'))).data;
    assert.deepEqual(found.tracks.map((t) => t.provider), ['kugou', 'netease']);
    const direct = (await send('play?track=netease%3A26', 'POST')).data;
    assert.equal(direct.playbackSource.fallback, false);
    assert.match(direct.url, /^\/api\/proxy\?ticket=/);
    const audio = await fetch(base + direct.url, { headers: { Cookie: cookie, Range: 'bytes=0-43' } });
    assert.equal(audio.status, 206);
    assert.equal((await audio.arrayBuffer()).byteLength, 44);
    const created = (await send('local-playlists', 'POST', { action: 'create', name: '测试收藏' })).data;
    const id = created.playlists[0].id;
    assert.equal((await send('local-playlists', 'POST', { action: 'add', id, track: 'netease:26' })).status, 200);
    const saved = (await send('tracks?playlist=' + encodeURIComponent(id))).data.tracks[0];
    assert.equal(saved.id, 'netease:26');
    assert.equal((await send('inspect?track=netease%3A26&fresh=1', 'POST')).data.playable, true);
    const reopened = (await send('tracks?playlist=' + encodeURIComponent(id))).data.tracks[0];
    assert.equal(reopened.inspection.playable, true);
    await send('playlists');
    const { tracks } = (await send('tracks?playlist=1')).data;
    const local = tracks[25];
    const inspected = (await send('inspect?track=' + encodeURIComponent(local.id), 'POST')).data;
    assert.equal(inspected.playable, true);
    assert.match(inspected.playbackReason, /网易云同录音/);
    assert.ok(!(await send('tracks?playlist=local%3Aunauthorized')).data.tracks.some(t => t.id === local.id));
    const play = (await send('play?track=' + encodeURIComponent(local.id), 'POST')).data;
    assert.equal(play.audioScheduling.backup, 'selected');
    assert.deepEqual(play.playbackSource, { provider: 'netease', name: '网易云', id: '26', fallback: true });
    assert.equal(play.entitlement, undefined);
    const history = (await send('report_history', 'POST', { songId: local.id, hash: local.hash,
      playbackId: '12345678-1234-1234-1234-123456789012' })).data;
    assert.equal(history.skipped, 'foreign_source');
    assert.equal(calls.some((x) => x.name === 'playhistory_upload'), false);
    const authorized = (await send('play?track=' + encodeURIComponent(local.id) + '&retry=authorized', 'POST')).data;
    assert.equal(authorized.audioScheduling, undefined);
    assert.equal(authorized.url, undefined);
    const unavailable = (await send('play?track=' + encodeURIComponent(tracks[26].id), 'POST')).data;
    assert.equal(unavailable.url, undefined);
    assert.ok((await send('tracks?playlist=local%3Aunauthorized')).data.tracks.some(t => t.id === tracks[26].id));
    const retired = await send('source-unavailable', 'POST', { songId: local.id, playbackToken: play.playbackToken });
    assert.equal(retired.status, 200);
    assert.ok((await send('tracks?playlist=local%3Aunauthorized')).data.tracks.some(t => t.id === local.id));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


test('网易云按无损、320k、128k探测并以实际返回音质为准', async () => {
  const requested = [];
  const source = createNeteaseSource(async (_, params) => {
    requested.push(params.br);
    return { data: [{ id: 7, code: 200, fee: 8, time: 240000, br: 128000,
      url: params.br === 128000 ? 'https://m10.music.126.net/full.mp3' : null }] };
  });
  assert.equal((await source.resolve({ sourceId: '7', duration: 240 })).quality, '128k');
  assert.deepEqual(requested, [999000, 320000, 128000]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalLibrary } from '../lib/local-library.mjs';
import { createAccessChecker } from '../lib/access.mjs';
import { createPlaybackRoutes } from '../lib/routes/playback.mjs';

test('本地歌单顺序和检查摘要跨重启保存，账号隔离且不保存取链凭据', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'higher-library-'));
  try {
    const a = { jar: { userid: 1, token: 'secret-account' }, tracks: new Map([
      ['a', { id: 'a', title: '第一首', hash: 'a', audio: 'secret-link' }],
      ['b', { id: 'b', title: '第二首', provider: 'netease', sourceId: '2' }],
    ]) };
    const b = { ...a, jar: { userid: 2 } };
    const first = createLocalLibrary(directory);
    const [{ id }] = first.edit(a, { action: 'create', name: '收藏' });
    for (const track of ['a', 'b']) first.edit(a, { action: 'add', id, track });
    first.edit(a, { action: 'move', id, track: 'b', direction: -1 });
    first.edit(a, { action: 'rename', id, name: '夜间收藏' });
    first.record(a, 'a', { state: 'unknown', playbackState: 'unknown', url: 'secret-link' });
    first.recordHistory(a, 'secret-token', a.tracks.get('b'), 'netease');
    first.recordHistory(a, 'secret-token', a.tracks.get('b'), 'netease');
    first.close();
    const afterRestart = createLocalLibrary(directory);
    assert.equal(afterRestart.list(a)[0].name, '夜间收藏');
    assert.deepEqual(afterRestart.tracks(a, id).map((track) => track.id), ['b', 'a']);
    assert.equal(afterRestart.cached(a, 'a').state, 'unknown');
    assert.deepEqual(afterRestart.list(b), []);
    assert.equal(afterRestart.cached(b, 'a'), undefined);
    assert.deepEqual(afterRestart.history(a).map(item => item.provider), ['netease']);
    assert.deepEqual(afterRestart.history(b), []);
    afterRestart.edit(a, { action: 'remove', id, track: 'a' });
    assert.deepEqual(afterRestart.tracks(a, id).map((track) => track.id), ['b']);
    afterRestart.close();
    assert.doesNotMatch(await readFile(path.join(directory, 'library.sqlite3'), 'utf8'), /secret-/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('旧 JSON 导入可重试且只执行一次，保留曲序、原文件和同账号已购证据', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'higher-migration-'));
  const s = { jar: { userid: 11 } };
  const prefix = process.env.platform === 'lite' ? 'lite:' : 'standard:';
  const account = createHash('sha256').update(prefix + '11').digest('hex');
  const legacyPath = path.join(directory, account + '.json');
  const old = { lists: [{ id: 'local:old', name: '旧收藏', tracks: [
    { id: 'one', title: 'First' }, { id: 'two', title: 'Second' },
  ] }], checks: { one: { state: 'allowed', eligible: true, entitlement: 'purchased',
    playbackState: 'allowed', checkedAt: 123, url: 'secret-old-link' } } };
  const library = createLocalLibrary(directory);
  try {
    await writeFile(legacyPath, JSON.stringify({ ...old, checks: { one: null } }));
    assert.throws(() => library.list(s), { status: 500 });
    await writeFile(legacyPath, JSON.stringify(old));
    assert.deepEqual(library.tracks(s, 'local:old').map(track => track.id), ['one', 'two']);
    assert.equal(library.cached(s, 'one').checkedAt, 123);
    assert.equal(library.cached(s, 'one').url, undefined);
    library.record(s, 'one', { state: 'unknown', eligible: false, playbackState: 'unknown', playable: false });
    assert.equal(library.cached(s, 'one').entitlement, 'purchased');
    assert.equal(library.cached(s, 'one').eligible, true);
    assert.equal(library.cached(s, 'one').playable, false);
    assert.equal(library.cached({ jar: { userid: 12 } }, 'one'), undefined);
    library.edit(s, { action: 'rename', id: 'local:old', name: '新版收藏' });
    library.close();
    assert.equal(library.list(s)[0].name, '新版收藏');
    assert.deepEqual(JSON.parse(await readFile(legacyPath, 'utf8')), old);
    library.record(s, 'one', { state: 'unavailable', eligible: false, entitlement: 'catalogue' });
    assert.equal(library.cached(s, 'one').eligible, false);
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});

test('复查已购曲遇到购买接口失败仍可验证当前同版本音源，明确下架仍拒绝', async () => {
  let publish = 1;
  const track = { hash: 'same-version', albumAudioId: 3, albumId: 2, duration: 240 };
  const check = createAccessChecker(async (_, name) => {
    if (name === 'privilege_lite') return { data: [{ hash: track.hash, album_audio_id: 3, album_id: 2, publish }] };
    if (name === 'song_url') return { url: 'https://example.com/full', timeLength: 240 };
    throw new Error('upstream unavailable');
  });
  const options = { knownPurchase: { state: 'allowed', eligible: true, entitlement: 'purchased' } };
  assert.equal((await check({}, track, true, options)).state, 'allowed');
  publish = 0;
  const delisted = await check({}, track, true, options);
  assert.equal(delisted.eligibilityState, 'unavailable');
  assert.equal(delisted.url, undefined);
});

test('旧待确认摘要不会阻止播放入口重新查权益并签发完整音源', async () => {
  const localLibrary = createLocalLibrary();
  const track = { id: 'same', hash: 'same-version' };
  const s = { user: {}, jar: { userid: 1 }, tracks: new Map([[track.id, track]]) };
  localLibrary.record(s, track.id, { state: 'unknown', eligible: false, playbackState: 'unknown' });
  const routes = createPlaybackRoutes({ localLibrary, sessions: new Map([['session', s]]),
    json: (_, status, data) => ({ status, data }),
    sources: { fallback: async () => null },
    adapter: async () => ({ checkAccess: async (_, __, ___, { cachedAccess }) => {
      assert.equal(cachedAccess, undefined);
      return { state: 'allowed', eligible: true, entitlement: 'purchased', playbackState: 'allowed',
        url: 'https://example.com/full' };
    } }),
  });
  const action = 'POST /api/play';
  const result = await routes[action]({ res: { once() {} }, s, sid: 'session',
    u: new URL('http://localhost/api/play?track=same'), action });
  assert.match(result.data.url, /^\/api\/proxy\?ticket=/);
  assert.equal(localLibrary.cached(s, track.id).entitlement, 'purchased');
});

test('已缓存权益的播放只获取新音源，不重复购买和单曲权限查询', async () => {
  const calls = [];
  const check = createAccessChecker(async (_, name) => {
    calls.push(name);
    if (name === 'song_url') return { url: 'https://example.com/full', timeLength: 240 };
    throw new Error('unexpected request');
  });
  const result = await check({}, { hash: 'a', duration: 240 }, true, {
    cachedAccess: { state: 'allowed', eligible: true, reason: '已购', entitlement: 'purchased' },
  });
  assert.equal(result.state, 'allowed');
  assert.deepEqual(calls, ['song_url']);
});


test('酷狗账号接口超时时停止其他账号查询，仍尝试当前与旧接口取链', async () => {
  const calls = [];
  const timeout = Object.assign(new Error('超时'), { httpStatus: 408 });
  const check = createAccessChecker(async (_, name) => { calls.push(name); throw timeout; });
  const result = await check({}, { hash: 'a' }, true, { fastFallback: true });
  assert.equal(result.state, 'unknown');
  assert.deepEqual(calls, ['user_purchased_songs', 'privilege_lite', 'song_url', 'legacy_play_info']);
});

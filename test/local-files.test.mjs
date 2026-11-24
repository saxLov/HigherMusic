import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalFiles, createLocalFileSource } from '../lib/local-files.mjs';
import { createMusicServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/sources/registry.mjs';
import { createMusicSources } from '../lib/sources/index.mjs';
import { createKugouSearch } from '../lib/sources/kugou.mjs';

function wave() {
  const data = Buffer.alloc(16044);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16000, 40);
  return data;
}

test('本地导入验证音频、去重和重启保留；仅公开 ID，缺失/变更进入待确认；移出不删除原文件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'higher-local-'));
  let files = createLocalFiles(root);
  try {
    const song = path.join(root, '歌曲.wav'), invalid = path.join(root, 'invalid.mp3');
    await writeFile(song, wave()); await writeFile(invalid, '<html>error</html>');
    assert.deepEqual(await files.importFiles([song, invalid]), { imported: 1, failed: 1 });
    await files.importFiles([song]);
    let { tracks } = await files.list();
    assert.equal(tracks.length, 1); assert.equal(tracks[0].duration, 1);
    assert.equal(tracks[0].title, '歌曲'); assert.equal(JSON.stringify(tracks).includes(root), false);
    const id = tracks[0].id;
    files.close(); files = createLocalFiles(root);
    assert.equal((await files.list()).tracks[0].id, id);
    await writeFile(path.join(root, '歌曲.lrc'), '[00:00]纯音乐，请欣赏');
    assert.match(await files.lyrics({ id }), /纯音乐/);
    await writeFile(song, Buffer.concat([wave(), Buffer.from('changed')]));
    assert.equal((await files.list()).tracks.length, 0);
    assert.equal((await files.list()).unavailable.length, 1);
    await assert.rejects(files.resolve({ id }));
    await files.importFiles([song]); assert.equal((await files.list()).tracks.length, 1);
    await rename(song, song + '.moved'); assert.equal((await files.list()).unavailable.length, 1);
    await rename(song + '.moved', song);
    files.remove(id); assert.equal((await files.list()).tracks.length, 0);
    assert.ok((await readFile(song)).length > 0);
    assert.deepEqual(await files.importFiles(['relative.wav', '\\\\server\\share\\song.wav']), { imported: 0, failed: 2 });
  } finally { files.close(); await rm(root, { recursive: true, force: true }); }
});

test('免登录本地播放支持 Range、会话隔离和撤销；不调用云端、不接受客户端文件路径', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'higher-local-http-'));
  const files = createLocalFiles(root); let cloudCalls = 0;
  const server = createMusicServer({ localFiles: files, request: async () => { cloudCalls++; throw new Error('No cloud'); } });
  try {
    const filename = path.join(root, 'song.wav'); await writeFile(filename, wave());
    await files.importFiles([filename]);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const session = await fetch(base + '/api/session');
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const send = (route, method = 'GET', headers = {}) => fetch(base + route, { method, headers: { Cookie: cookie, ...headers } });
    const track = (await (await send('/api/local-files')).json()).tracks[0];
    const result = await (await send('/api/local-play?track=' + track.id, 'POST')).json();
    assert.equal(result.playbackSource.provider, 'local'); assert.equal(result.playbackSource.history, false);
    assert.equal(result.expectedDuration, 1); assert.equal(JSON.stringify(result).includes(root), false);
    const started = () => fetch(base + '/api/local-started', { method: 'POST', headers: {
      Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ songId: track.id, playbackToken: result.playbackToken }) });
    assert.equal((await started()).status, 200);
    assert.equal((await started()).status, 200);
    const partial = await send(result.url, 'GET', { Range: 'bytes=16-31' });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 16-31/16044');
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), wave().subarray(16, 32));
    const suffix = await send(result.url, 'GET', { Range: 'bytes=-12' });
    assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 12);
    for (const range of ['bytes=999999-', 'bytes=8-2', 'bytes=0-1,3-5', 'bytes=-0', 'items=0-1'])
      assert.equal((await send(result.url, 'GET', { Range: range })).status, 416);
    assert.equal((await fetch(base + result.url)).status, 404);
    const denied = await (await send('/api/local-play?track=' + encodeURIComponent(filename), 'POST')).json();
    assert.equal(denied.playbackState, 'unavailable');
    assert.equal((await send('/api/tracks?playlist=test')).status, 502);
    assert.equal((await send('/api/proxy?ticket=' + 'a'.repeat(48))).status, 404);
    const providers = await (await send('/api/providers')).json();
    assert.deepEqual(providers.providers.map(item => item.id), ['kugou', 'netease', 'local']);
    assert.equal(providers.providers[0].capabilities.accountAccess, true);
    await send('/api/local-remove?track=' + track.id, 'POST');
    assert.equal((await send(result.url)).status, 404);
    assert.equal((await started()).status, 403);
    assert.equal(cloudCalls, 0);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    files.close(); await rm(root, { recursive: true, force: true });
  }
});

test('酷狗适配器原样传递已购证据、授权重试选项与取消信号，不被通用备用源取代', async () => {
  const session = { jar: { userid: 'buyer', token: 'private' } }, track = { id: 'paid', provider: 'kugou' };
  const options = { authorizedOnly: true, cachedAccess: { entitlement: 'purchased', eligible: true }, signal: new AbortController().signal };
  const evidence = { state: 'allowed', entitlement: 'purchased', url: 'https://music.kugou.com/paid' };
  let calls = 0;
  const sources = createMusicSources([createKugouSearch(async () => { throw new Error('Do not search'); }, async (s, t, playing, o) => {
    assert.equal(s, session); assert.equal(t, track); assert.equal(playing, true); assert.equal(o, options);
    calls++; return evidence;
  })]);
  assert.equal(sources.canAuthorize('kugou'), true);
  assert.equal(await sources.authorize(session, track, true, options), evidence);
  assert.equal(calls, 1);
});

test('音源注册拒绝重复和无效接口；新增适配器遵守统一播放/歌词流程，本地不参加网络搜索及自动降级', async () => {
  assert.throws(() => createProviderRegistry([{ id: 'x' }, { id: 'x' }]), /duplicate/);
  assert.throws(() => createProviderRegistry([{ id: '../x' }]), /Invalid/);
  assert.throws(() => createProviderRegistry([{ id: 'x', resolve() {} }]), /detail/);
  assert.throws(() => createProviderRegistry([{ id: 'x', search: true }]), /method/);
  const track = { id: 'example:1', provider: 'example', title: 'Song', artist: 'Singer', duration: 60, album: 'Album' };
  let localCalls = 0;
  const sources = createMusicSources([{ id: 'example', name: 'Example',
    search: async () => [track], detail: async () => track,
    resolve: async () => ({ url: 'https://example.invalid/audio' }), lyrics: async () => '[00:00]Song' },
  { ...createLocalFileSource({ detail: async () => { localCalls++; } }), search: async () => { localCalls++; return []; } }]);
  const session = {};
  assert.deepEqual((await sources.search(session, 'Song')).tracks, [track]);
  assert.equal((await sources.play(session, track)).playbackSource.name, 'Example');
  assert.equal(await sources.lyrics(track), '[00:00]Song');
  assert.equal(await sources.fallback(session, track), null);
  assert.equal(localCalls, 0);
  const control = new AbortController(); control.abort();
  await assert.rejects(sources.play(session, track, { signal: control.signal }), { name: 'AbortError' });
});

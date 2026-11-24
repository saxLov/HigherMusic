import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerBody } from '../lib/provider.mjs';
import { lyrics, timedLyrics } from '../lib/gallery.mjs';
import { createLyricsResolver } from '../lib/lyrics.mjs';
import { createMusicSources } from '../lib/sources/index.mjs';

const track = { id: '1', hash: 'hash', title: 'Song (Acoustic)', artist: 'Singer', duration: 212, album: 'One' };
const lrc = '[00:00.00]Test line\n[00:12.00]Second line';
const hit = { id: 1, accesskey: 'private-key', duration: 212897 };

test('纯音乐歌词标识与明确版本名称返回纯音乐，普通无歌词仍为 missing', async () => {
  const resolve = createLyricsResolver({ sources: {}, call: async (_, name) =>
    name === 'search_lyric' ? { candidates: [hit] } : { decodeContent: '[00:00.00]纯音乐，请欣赏' } });
  assert.equal((await resolve({}, track)).state, 'instrumental');
  const empty = createLyricsResolver({ sources: {}, call: async () => ({ candidates: [] }) });
  assert.equal((await empty({}, { ...track, title: 'Song (Instrumental)' })).state, 'instrumental');
  assert.equal((await empty({}, track)).state, 'missing');
});

test('歌词真实返回结构的 errcode 200 表示成功，但其他接口不接受该码', () => {
  const result = { status: 200, body: { status: 200, errcode: 200, candidates: [hit] } };
  assert.equal(providerBody('search_lyric', result), result.body);
  assert.equal(providerBody('lyric', { status: 200, body: { status: 200, decodeContent: lrc } }).decodeContent, lrc);
  for (const name of ['song_url', 'privilege_lite', 'login_qr_key'])
    assert.throws(() => providerBody(name, result), { platformCode: 200 });
  for (const change of [{ error_code: 20028 }, { errcode: 403 }, { status: 0 }, { error: '本次请求需要验证' }])
    assert.throws(() => providerBody('search_lyric', { ...result, body: { ...result.body, ...change } }));
  assert.throws(() => providerBody('search_lyric', { ...result, status: 403 }));
});

test('歌词搜索404空候选是正常无歌词，下载404和非空异常仍失败', () => {
  const result = { status: 200, body: { status: 404, errcode: 404, candidates: [] } };
  assert.deepEqual(providerBody('search_lyric', result).candidates, []);
  assert.throws(() => providerBody('lyric', result));
  assert.throws(() => providerBody('search_lyric', { ...result, body: { ...result.body, candidates: [hit] } }));
});

test('同hash候选可省略remix标题，按时长排除错误录音，过期候选后继续下载', async () => {
  const downloaded = [];
  const result = await lyrics({}, track, async (_, name, params) => {
    if (name === 'search_lyric') return { candidates: [{ ...hit, id: 'wrong', duration: 30000 }, hit, { ...hit, id: 2 }] };
    downloaded.push(params.id);
    if (params.id === 1) throw Object.assign(new Error('expired'), { platformCode: 404 });
    return { decodeContent: lrc };
  });
  assert.equal(result, lrc);
  assert.deepEqual(downloaded, [1, 2]);
  assert.equal(timedLyrics('[ti:Song]\n[00:00]'), false);
  assert.equal(timedLyrics('<html>error</html>'), false);
});

test('候选下载限流后不继续请求其他候选', async () => {
  let downloads = 0;
  await assert.rejects(lyrics({}, track, async (_, name) => {
    if (name === 'search_lyric') return { candidates: [hit, { ...hit, id: 2 }] };
    downloads++;
    throw Object.assign(new Error('rate limit'), { httpStatus: 429 });
  }), { httpStatus: 429 });
  assert.equal(downloads, 1);
});

test('歌词备用匹配保留版本歌手时长，取歌词不取音频或改播放记录', async () => {
  const matched = { ...track, provider: 'netease', id: 'netease:7', sourceId: '7' };
  let candidates = [{ ...matched, title: 'Song' }, { ...matched, artist: 'Other' }, { ...matched, duration: 100 }];
  let reads = 0;
  const sources = createMusicSources([{ id: 'netease',
    search: async () => candidates,
    lyrics: async () => { reads++; return lrc; },
    detail: () => { throw Error('must not query audio rights'); },
    resolve: () => { throw Error('must not fetch audio'); },
  }]);
  assert.equal(await sources.matchedLyrics({}, 'netease', track), '');
  assert.equal(reads, 0);
  candidates = [matched];
  const session = { playbackSources: new Map([['1', { provider: 'kugou', id: '1' }]]) };
  const resolve = createLyricsResolver({ call: async () => ({ candidates: [] }), sources });
  const result = await resolve(session, track, session.playbackSources.get('1'));
  assert.equal(result.lyrics, lrc);
  assert.equal(result.provider, 'netease');
  assert.equal(session.playbackSources.get('1').provider, 'kugou');
});

test('成功歌词合并并发和缓存，隔离会话、音源与版本，过期重新读取', async () => {
  let requests = 0, clock = 0;
  const resolve = createLyricsResolver({ now: () => clock, sources: {}, call: async (_, name) => {
    requests++;
    return name === 'search_lyric' ? { candidates: [hit] } : { decodeContent: lrc };
  } });
  const session = {};
  await Promise.all([resolve(session, track), resolve(session, track)]);
  assert.equal(requests, 2);
  assert.equal((await resolve(session, track)).cached, true);
  await resolve({}, track);
  await resolve(session, { ...track, hash: 'other-hash' });
  assert.equal(requests, 6);
  clock += 30 * 60 * 1000 + 1;
  await resolve(session, track);
  assert.equal(requests, 8);
});

test('失败不缓存；诊断保留数字码但不泄漏歌词key、URL或凭据', async () => {
  let fail = true;
  const resolve = createLyricsResolver({ sources: {}, call: async (_, name) => {
    if (fail) throw Object.assign(new Error('secret https://example.com/?token=secret'), { httpStatus: 403, platformCode: 123, accesskey: 'secret' });
    return name === 'search_lyric' ? { candidates: [hit] } : { decodeContent: lrc };
  } });
  const session = {};
  const failed = await resolve(session, track);
  assert.equal(failed.state, 'unavailable');
  assert.deepEqual(failed.attempts, [{ provider: 'kugou', outcome: 'failed', httpStatus: 403, platformCode: 123 }]);
  assert.doesNotMatch(JSON.stringify(failed), /secret|token|accesskey/);
  fail = false;
  assert.equal((await resolve(session, track)).state, 'ready');
});

test('网易云音频先使用该录音歌词；失败时可读取原酷狗精确录音的歌词', async () => {
  let primary = lrc, kugouReads = 0;
  const resolve = createLyricsResolver({ sources: { lyrics: async t => {
    assert.equal(t.sourceId, '7'); return primary;
  } }, call: async (_, name) => {
    kugouReads++;
    return name === 'search_lyric' ? { candidates: [hit] } : { decodeContent: lrc };
  } });
  assert.equal((await resolve({}, track, { provider: 'netease', id: '7' })).provider, 'netease');
  assert.equal(kugouReads, 0);
  primary = '';
  assert.equal((await resolve({}, track, { provider: 'netease', id: '7' })).provider, 'kugou');
  assert.equal(kugouReads, 2);
});

test('主源快时不访问备用源；主源慢时采用匹配歌词并通知主源取消', async () => {
  let backupReads = 0, slow = false, cancelled = false;
  const resolve = createLyricsResolver({
    fallbackDelayMs: 0,
    call: async (_, name, _params, { signal }) => {
      if (!slow) return name === 'search_lyric' ? { candidates: [hit] } : { decodeContent: lrc };
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        cancelled = true;
        reject(signal.reason);
      }, { once: true }));
    },
    sources: { matchedLyrics: async () => { backupReads++; return lrc; } },
  });
  assert.equal((await resolve({}, track)).provider, 'kugou');
  assert.equal(backupReads, 0);
  slow = true;
  const result = await resolve({}, track);
  assert.equal(result.provider, 'netease');
  assert.deepEqual(result.attempts, [
    { provider: 'kugou', outcome: 'cancelled' },
    { provider: 'netease', outcome: 'ready' },
  ]);
  assert.equal(cancelled, true);
  assert.equal(backupReads, 1);
});

test('同一首歌并发读取歌词时，取消一方不会中止另一方', async () => {
  const start = Promise.withResolvers(), finish = Promise.withResolvers();
  let upstreamSignal;
  const resolve = createLyricsResolver({ call: async (_, name, _params, { signal }) => {
    upstreamSignal = signal;
    start.resolve();
    if (name === 'search_lyric') { await finish.promise; return { candidates: [hit] }; }
    return { decodeContent: lrc };
  }, sources: {} });
  const session = {};
  const controller = new AbortController();
  const first = assert.rejects(resolve(session, track, undefined, controller.signal), { name: 'AbortError' });
  const second = resolve(session, track);
  await start.promise;
  controller.abort();
  await first;
  assert.equal(upstreamSignal.aborted, false);
  finish.resolve();
  assert.equal((await second).lyrics, lrc);
});

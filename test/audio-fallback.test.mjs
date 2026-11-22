import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { prepareAudioFallback } from '../lib/scheduler/audio-fallback.mjs';
import { createMusicSources } from '../lib/sources/index.mjs';

const complete = (provider) => ({
  state: 'allowed', playbackState: 'allowed', url: `https://${provider}.example.com/full.mp3`,
});
const missing = { state: 'unknown', playbackState: 'unknown' };

test('酷狗快速取得完整音源时不访问备用平台；禁用预取时按顺序检查', async () => {
  const primary = complete('kugou');
  let reads = 0;
  const backup = async () => { reads++; return complete('netease'); };
  const fast = await prepareAudioFallback(async () => primary, backup, { delayMs: 0 });
  assert.equal(fast.original, primary);
  assert.equal(fast.scheduling.backup, 'not_started');
  assert.equal(reads, 0);
  const pending = Promise.withResolvers();
  const sequential = prepareAudioFallback(() => pending.promise, backup, { delayMs: 0, prefetch: false });
  await nextTurn();
  assert.equal(reads, 0);
  pending.resolve(missing);
  assert.equal((await sequential).scheduling.backup, 'selected');
  assert.equal(reads, 1);
});

test('备用在慢主源等待期间准备；仍优先采用验证通过的酷狗', async () => {
  const primary = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const run = prepareAudioFallback(() => primary.promise, async () => {
    ready.resolve();
    return complete('netease');
  }, { delayMs: 0 });
  await ready.promise;
  await nextTurn();
  primary.resolve(complete('kugou'));
  const result = await run;
  assert.equal(result.original.url, 'https://kugou.example.com/full.mp3');
  assert.equal(result.candidate, null);
  assert.equal(result.scheduling.backup, 'unused');
});

test('主源没有完整音源时采用已就绪的备用；试听或待确认结果无法获选', async () => {
  const primary = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const backup = complete('netease');
  const run = prepareAudioFallback(() => primary.promise, async () => {
    ready.resolve();
    return backup;
  }, { delayMs: 0 });
  await ready.promise;
  primary.resolve(missing);
  assert.equal((await run).candidate, backup);
  const rejected = await prepareAudioFallback(async () => missing, async () => ({
    ...backup, playbackState: 'preview',
  }));
  assert.equal(rejected.candidate, null);
  assert.equal(rejected.scheduling.backup, 'unavailable');
});

test('已采用主源时中止正在准备的备用，搜索晚到不继续查询权益或取链', async () => {
  const primary = Promise.withResolvers(), searching = Promise.withResolvers();
  const matches = Promise.withResolvers();
  const track = { id: 'original', title: 'Song (Acoustic)', artist: 'Singer', duration: 180 };
  let detailed = false, backup;
  const sources = createMusicSources([{ id: 'netease',
    search: () => { searching.resolve(); return matches.promise; },
    detail: async () => { detailed = true; },
    resolve: async () => complete('netease'),
  }]);
  const selected = prepareAudioFallback(() => primary.promise, (signal) => {
    backup = sources.fallback({}, track, { signal });
    return backup;
  }, { delayMs: 0 });
  await searching.promise;
  primary.resolve(complete('kugou'));
  assert.equal((await selected).scheduling.backup, 'cancelled');
  matches.resolve([{ ...track, provider: 'netease', sourceId: '7', id: 'netease:7' }]);
  assert.equal(await backup, null);
  assert.equal(detailed, false);
});

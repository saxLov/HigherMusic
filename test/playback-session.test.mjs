import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../public/playback-session.js';

const { PlaybackSession } = globalThis.HigherPlayback;
const hooks = { onReply() {}, onRejected() {}, onDiagnostic() {} };
const source = (id, provider = 'kugou') => ({
  url: '/api/proxy?ticket=' + id, playbackToken: id, playbackSource: { provider, history: true },
});

function fixture({ resolve, load }) {
  const started = [];
  const session = new PlaybackSession({
    resolve, load,
    normalize: (_, reply) => ({ audio: reply.url, urls: [reply.url], duration: 240 }),
    isPlayable: (reply) => !!reply.url,
    media: { release() {} },
  });
  const begin = id => session.begin({ id }, {
    onStarted: (active, historyAllowed) => started.push({ id, active, historyAllowed }),
  });
  return { session, begin, started };
}

test('连切后旧取链和旧媒体即使迟到成功，也只有最后一轮能起播', async () => {
  const delayedUrl = Promise.withResolvers(), delayedMedia = Promise.withResolvers();
  const enteredMedia = Promise.withResolvers();
  const loads = [];
  const { session, begin, started } = fixture({
    resolve: async id => id === 'old-url' ? delayedUrl.promise : source(id),
    load: async (url, signal) => {
      loads.push(url);
      if (url.endsWith('old-media')) {
        enteredMedia.resolve(signal);
        await delayedMedia.promise;
      }
    },
  });
  const first = begin('old-url'), pending = session.run(first, hooks);
  const second = begin('old-media'), loading = session.run(second, hooks);
  const mediaSignal = await enteredMedia.promise;
  const latest = begin('latest');
  await session.run(latest, hooks);
  assert.equal(first.signal.aborted, true);
  assert.equal(mediaSignal.aborted, true);
  delayedMedia.resolve();
  delayedUrl.resolve(source('old-url'));
  await Promise.all([pending, loading]);
  assert.deepEqual(loads, ['/api/proxy?ticket=old-media', '/api/proxy?ticket=latest']);
  assert.deepEqual(started.map(result => result.id), ['latest']);
  assert.equal(session.loadedId, 'latest');
});

test('酷狗候选未起播时只提交实际起播的网易云，禁止酷狗历史', async () => {
  const requests = [];
  const { session, begin, started } = fixture({
    resolve: async (_, query) => {
      requests.push(query);
      return query === '&alternate=1' ? source('backup', 'netease') : source('primary');
    },
    load: async url => { if (url.endsWith('primary')) throw new Error('connection failed'); },
  });
  const round = begin('song');
  await session.run(round, { ...hooks, onDiagnostic: () => ({ code: 'http', status: 403 }) });
  assert.deepEqual(requests, ['', '&alternate=1']);
  assert.equal(started.length, 1);
  assert.equal(started[0].active.playbackToken, 'backup');
  assert.equal(started[0].historyAllowed, false);
});

test('需要用户手势时保留候选，收到实际起播事件后只提交一次', async () => {
  const { session, begin, started } = fixture({
    resolve: async () => source('primary'),
    load: async () => { throw new DOMException('blocked', 'NotAllowedError'); },
  });
  const round = begin('song');
  await session.run(round, hooks);
  assert.equal(round.phase, 'gesture');
  assert.equal(round.active, undefined);
  assert.equal(started.length, 0);
  session.mediaPlaying();
  session.mediaPlaying();
  assert.equal(started.length, 1);
  assert.equal(started[0].historyAllowed, true);
});

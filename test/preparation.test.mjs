import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackPreparation } from '../lib/scheduler/playback-preparation.mjs';
const tick = () => new Promise(setImmediate);
const track = id => ({ id, hash: id, title: id, duration: 240 });
const selected = (url = 'https://example.com/full') => ({ result: { state: 'allowed', playbackState: 'allowed', url } });

test('shared resolution survives one canceled reader and caches the result', async () => {
  const prep = createPlaybackPreparation(), s = {}, gate = Promise.withResolvers();
  let count = 0;
  const control = new AbortController(), run = async () => { count++; return gate.promise; };
  const a = prep.get(s, track('a'), { run, signal: control.signal });
  const b = prep.get(s, track('a'), { run });
  const canceled = assert.rejects(a, { name: 'AbortError' });
  await tick(); control.abort(); await canceled;
  gate.resolve(selected()); await b; await tick();
  assert.equal(count, 1);
  assert.equal((await prep.get(s, track('a'), { run })).selectionHit, true);
});

test('signed URL expiry and account isolation override the default five minutes', async () => {
  let clock = 1700000000000, count = 0;
  const prep = createPlaybackPreparation({ now: () => clock }), s = {};
  const run = async () => { count++; return selected('https://example.com/full?expires=1700000060'); };
  await prep.get(s, track('a'), { run });
  assert.equal((await prep.get(s, track('a'), { run })).selectionHit, true);
  await prep.get({}, track('a'), { run });
  clock += 31000;
  assert.equal((await prep.get(s, track('a'), { run })).selectionHit, undefined);
  assert.equal(count, 3);
});

test('foreground cancels unrelated background jobs and preparation is bounded to two', async () => {
  const prep = createPlaybackPreparation(), s = {}, calls = [];
  const plan = prep.prepare(s, ['a','b','c','d','e'].map(track), async (t, signal) => {
    calls.push(t.id);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await tick(); assert.deepEqual(calls, ['a']); assert.equal(plan.planned, 2);
  await prep.get(s, track('c'), { run: async () => selected() });
  await plan.completion;
  assert.deepEqual(calls, ['a']); prep.cancel(s);
});

test('playing a preparing song promotes the same job without duplicate work', async () => {
  const prep = createPlaybackPreparation(), s = {}, gate = Promise.withResolvers(); let calls = 0;
  const plan = prep.prepare(s, [track('a')], async () => { calls++; return gate.promise; });
  await tick();
  const front = prep.get(s, track('a'), { run: async () => { throw Error('duplicate'); } });
  prep.prepare(s, [], async () => {});
  gate.resolve(selected()); await front; await plan.completion;
  assert.equal(calls, 1);
});

test('canceling last reader aborts the upstream and never caches canceled work', async () => {
  const prep = createPlaybackPreparation(), s = {}, control = new AbortController(); let aborted = false;
  const a = prep.get(s, track('a'), { signal: control.signal, run: signal => new Promise((_,reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once:true });
  }) });
  const canceled = assert.rejects(a, { name:'AbortError' });
  await tick(); control.abort(); await canceled; await tick();
  assert.equal(aborted,true);
  assert.equal((await prep.get(s,track('a'),{run:async()=>selected()})).selectionHit,undefined);
});

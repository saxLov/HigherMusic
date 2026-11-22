import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/api-client.js', import.meta.url), 'utf8');

test('an already running slow inspection never blocks a play request', async () => {
  let release;
  const context = vm.createContext({ AbortController, DOMException, queueMicrotask, setTimeout, clearTimeout,
    fetch: url => url.includes('inspect') ? new Promise(resolve => { release = resolve; }) :
      Promise.resolve({ok:true,json:async()=>({played:true})}) });
  vm.runInContext(source,context);
  const request=context.HigherApi.createApiClient('');
  const slow=request('inspect?track=a','POST');
  await new Promise(setImmediate);
  try { assert.equal((await request('play?track=b','POST')).played,true); }
  finally { release({ok:true,json:async()=>({})}); await slow; }
});
test('播放优先于批量检查，JSON正确编码；过期上报出队前取消，失败不阻断后续请求', async () => {
  const calls = [], resolvers = [];
  const context = vm.createContext({ AbortController, DOMException, queueMicrotask, setTimeout, clearTimeout,
    fetch: (url, options) => { calls.push({ url, options }); return new Promise((resolve) => resolvers.push(resolve)); } });
  vm.runInContext(source, context);
  const request = context.HigherApi.createApiClient('');
  let valid = true;
  const inspect = request('inspect?track=1', 'POST', () => true, { priority: -10 });
  const play = request('play?track=1', 'POST');
  const report = request('report_history', 'POST', () => valid, { body: { songId: 'a' }, priority: 5 });
  const canceled = request('report_history', 'POST', () => false, { priority: 5 }).catch((e) => e.name);
  await new Promise(setImmediate);
  assert.equal(calls[0].url, '/api/play?track=1');
  resolvers.shift()({ ok: true, json: async () => ({ ok: true }) }); await play;
  await new Promise(setImmediate);
  assert.equal(calls[1].url, '/api/report_history');
  assert.equal(calls[1].options.body, '{"songId":"a"}');
  assert.equal(calls[1].options.credentials, 'include');
  const rejected = assert.rejects(report, /失败/);
  resolvers.shift()({ ok: false, json: async () => ({ error: '失败' }) }); await rejected;
  await new Promise(setImmediate);
  assert.equal(await canceled, 'AbortError');
  assert.equal(calls[2].url, '/api/inspect?track=1');
  resolvers.shift()({ ok: true, json: async () => ({ playable: true }) }); await inspect;
});

test('切歌中止已发出的请求并释放队列，取消不被显示为超时', async () => {
  const started = Promise.withResolvers();
  const routes = [];
  const context = vm.createContext({ AbortController, DOMException, queueMicrotask, setTimeout, clearTimeout,
    fetch: (url, options) => {
      routes.push(url);
      if (!url.endsWith('old')) return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      started.resolve();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () =>
        reject(options.signal.reason), { once: true }));
    } });
  vm.runInContext(source, context);
  const request = context.HigherApi.createApiClient('');
  const controller = new AbortController();
  const old = assert.rejects(request('play?track=old', 'POST', () => true, { signal: controller.signal }),
    { name: 'AbortError' });
  await started.promise;
  const next = request('play?track=new', 'POST');
  controller.abort();
  await old;
  assert.equal((await next).ok, true);
  assert.deepEqual(routes, ['/api/play?track=old', '/api/play?track=new']);
});

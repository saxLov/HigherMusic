import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPlatformJson } from '../lib/gateway/json.mjs';
import { createSourceQueue } from '../lib/scheduler/source-queue.mjs';

test('平台 JSON 禁止跳转，限制实际读取体积，并保留限流等待时间', async () => {
  const policy = { timeoutMs: 1000, maxBytes: 32 };
  const read = (make) => readPlatformJson('https://music.163.com/weapi/song/lyric', {}, policy,
    async (_, options) => {
      assert.equal(options.redirect, 'error');
      return make();
    });
  assert.deepEqual(await read(() => Response.json({ code: 200 })), { code: 200 });
  await assert.rejects(read(() => new Response('x'.repeat(33))), /平台响应无法读取/);
  await assert.rejects(read(() => new Response('', { status: 429, headers: { 'Retry-After': '2' } })),
    { httpStatus: 429, retryAfterMs: 2000 });
});

test('平台限流仅冷却对应操作；时间到后串行试探，成功恢复', async () => {
  let now = 0;
  const run = createSourceQueue({ now: () => now, spacingMs: 0 });
  const fail = (status, extra) => async () => {
    throw Object.assign(new Error('upstream'), { httpStatus: status, ...extra });
  };
  const ok = async () => 'ok';
  await assert.rejects(run('lyrics', fail(429, { retryAfterMs: 2000 })), { httpStatus: 429 });
  await assert.rejects(run('lyrics', ok), { cooling: true });
  assert.equal(await run('search', ok), 'ok');
  assert.equal(await run('audio', ok), 'ok');
  now = 2000;
  const results = await Promise.allSettled([run('lyrics', fail(429)), run('lyrics', ok)]);
  assert.equal(results[0].reason.httpStatus, 429);
  assert.equal(results[1].reason.cooling, true);
  now += 60000;
  assert.equal(await run('lyrics', ok), 'ok');
  await assert.rejects(run('audio', fail(403)), { httpStatus: 403 });
  assert.equal(await run('audio', ok), 'ok');
});

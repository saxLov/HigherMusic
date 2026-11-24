/* 自动检查：平台数据适配：不同列表字段、未知结构与毫秒时长规范化。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listFrom, normalizeTrack, providerError, withDeviceRecovery } from '../lib/provider.mjs';
test('私人歌单接口 file 数组可以读取', () =>
  assert.equal(listFrom({ data: { file: [{ filename: 'test' }] } }).length, 1));
test('空歌单和未知格式区别处理', () => {
  assert.deepEqual(listFrom({ data: { file: [] } }), []);
  assert.throws(() => listFrom({ data: { unexpected: 1 } }), /格式/);
});
test('歌单毫秒时长规范化', () =>
  assert.equal(
    normalizeTrack({ fileinfo: { hash: 'test', filename: 'test', timelen: 196000 } })
      .duration,
    196,
  ));

test('同一会话收到酷狗设备验证后合并注册，再用新凭据重试各自的原请求', async () => {
  const session = { jar: { dfid: 'old-device', token: 'account-token' } };
  const calls = [];
  const request = withDeviceRecovery(async (s, name, params) => {
    calls.push({ name, params });
    if (name === 'register_dev') return { data: { dfid: 'new-device' } };
    if (s.jar.dfid !== 'new-device') throw providerError({ status: 200, body: { errcode: 20028 } });
    return params;
  });
  const params = [{ hash: 'a' }, { hash: 'b' }];
  assert.deepEqual(await Promise.all(params.map((p) => request(session, 'song_url', p))), params);
  assert.equal(calls.filter((c) => c.name === 'register_dev').length, 1);
  assert.equal(calls.filter((c) => c.name === 'song_url').length, 4);
  assert.equal(session.jar.token, 'account-token');
});

test('持续设备验证有冷却，不重试历史写入或HTTP限流', async () => {
  const session = { jar: { dfid: 'old-device' } };
  const calls = [];
  const request = withDeviceRecovery(async (_, name) => {
    calls.push(name);
    if (name === 'register_dev') return { data: { dfid: 'new-device' } };
    const status = name === 'search' ? 429 : 200;
    throw providerError({ status, body: { msg: '本次请求需要验证' } });
  });
  for (const name of ['song_url', 'song_url', 'playhistory_upload', 'search'])
    await assert.rejects(request(session, name), { platformCode: 20028 });
  assert.deepEqual(calls, ['song_url', 'register_dev', 'song_url', 'song_url', 'playhistory_upload', 'search']);
});

test('注册失败恢复原凭据，且不重发取链请求', async () => {
  const session = { jar: { dfid: 'old-device' } };
  let reads = 0;
  const request = withDeviceRecovery(async (s, name) => {
    if (name === 'register_dev') {
      s.jar.dfid = 'invalid-response-cookie';
      return {};
    }
    reads++;
    throw providerError({ status: 200, body: { error_code: 20028 } });
  });
  await assert.rejects(request(session, 'song_url'), { platformCode: 20028 });
  assert.equal(reads, 1);
  assert.equal(session.jar.dfid, 'old-device');
});

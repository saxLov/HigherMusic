import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKugouPlaybackResolver } from '../lib/kugou-playback.mjs';
import { createAccessChecker } from '../lib/access.mjs';
import { providerError } from '../lib/provider.mjs';

const track = { hash: 'abc', albumAudioId: 123, albumId: 5, duration: 240 };
const session = () => ({ jar: { userid: 'user-id', token: 'private-account-token' } });
const full = { hash: 'abc', album_audio_id: 123, album_id: 5,
  url: ['https://audio.example/full?signature=private-link'], timeLength: 240 };
function fixture(overrides = {}) {
  const calls = [];
  const request = async (s, name, params = {}) => {
    calls.push({ name, params });
    if (overrides[name]) return overrides[name](s, params);
    switch (name) {
      case 'register_dev': return { data: { dfid: 'private-device-id' } };
      case 'song_url': return {};
      case 'user_verify': return { data: { auth: 'private-user-auth' } };
      case 'song_auth': return { data: { auth: 'private-song-auth', open_time: 123456 } };
      case 'song_url_auth':
        assert.equal(s.jar.dfid, 'private-device-id');
        assert.equal(params.auth, 'private-song-auth');
        assert.equal(params.open_time, 123456);
        assert.equal(params.album_audio_id, 123);
        assert.equal(params.album_id, 5);
        assert.equal(params.quality, 128);
        assert.equal(params.free_part, false);
        return full;
      case 'user_purchased_songs': return { data: { info: [{ album_audio_id: 123 }] } };
      case 'user_purchased_albums': return { data: { info: [] } };
      case 'user_vip_detail': return { data: { is_vip: 0 } };
      case 'privilege_lite': return { data: [{ hash: 'abc', album_audio_id: 123, status: 0 }] };
      default: throw new Error('Unexpected test request');
    }
  };
  return { calls, request };
}
const options = { duration: 240, allowAuthorization: true };

test('非VIP已购版本通过设备、用户与单曲授权取得128k完整音源', async () => {
  const { calls, request } = fixture();
  const result = await createAccessChecker(request)(session(), track, true);
  assert.equal(result.state, 'allowed');
  assert.equal(result.entitlement, 'purchased');
  assert.equal(result.playbackState, 'allowed');
  assert.deepEqual(result.playbackIdentity, { hash: 'abc', albumId: 5, albumAudioId: 123 });
  assert.deepEqual(calls.slice(-6).map(c => c.name),
    ['register_dev', 'song_url', 'song_url', 'user_verify', 'song_auth', 'song_url_auth']);
  const diagnostic = JSON.stringify(result.diagnostics);
  for (const secret of ['private-', 'https:', 'user-id', 'signature']) assert.equal(diagnostic.includes(secret), false);
});

test('明确免费歌曲可走授权链；没有购买或免费证据时不提升资格', async () => {
  const { request } = fixture({
    user_purchased_songs: () => ({ data: { info: [] } }),
    privilege_lite: () => ({ data: [{ hash: 'abc', album_audio_id: 123, quality: '128',
      status: 1, pay_type: 0, price: 0, privilege: 0 }] }),
  });
  assert.equal((await createAccessChecker(request)(session(), track, true)).entitlement, 'free');
  const unknown = fixture({ user_purchased_songs: () => ({ data: { info: [] } }) });
  const result = await createAccessChecker(unknown.request)(session(), track, true);
  assert.equal(result.eligible, false);
  assert.equal(result.state, 'unknown');
  assert.equal(unknown.calls.some(c => c.name === 'song_auth'), false);
});

test('设备凭据先于常规取链取得；常规完整音源不调用额外鉴权', async () => {
  const { calls, request } = fixture({ song_url: () => full });
  const s = session(), resolve = createKugouPlaybackResolver(request);
  await resolve(s, track, options);
  await resolve(s, track, options);
  assert.deepEqual(calls.map(c => c.name), ['register_dev', 'song_url', 'song_url']);
});

test('同一会话复用设备和短期用户凭据，账号与token变化后重新验证', async () => {
  const { calls, request } = fixture();
  const resolve = createKugouPlaybackResolver(request), s = session();
  await resolve(s, track, options);
  await resolve(s, track, options);
  assert.equal(calls.filter(c => c.name === 'register_dev').length, 1);
  assert.equal(calls.filter(c => c.name === 'user_verify').length, 1);
  assert.equal(calls.filter(c => c.name === 'song_auth').length, 2);
  s.jar.token = 'new-private-token';
  await resolve(s, track, options);
  await resolve(session(), track, options);
  assert.equal(calls.filter(c => c.name === 'register_dev').length, 3);
  assert.equal(calls.filter(c => c.name === 'user_verify').length, 3);
});

test('并发任务合并设备注册和用户验证，不合并不同歌曲的授权', async () => {
  const { calls, request } = fixture();
  const resolve = createKugouPlaybackResolver(request), s = session();
  const results = await Promise.all([resolve(s, track, options), resolve(s, track, options)]);
  assert.equal(results.every(r => r.state === 'allowed'), true);
  assert.equal(calls.filter(c => c.name === 'register_dev').length, 1);
  assert.equal(calls.filter(c => c.name === 'user_verify').length, 1);
});

test('授权音源仍拦截试听、错误hash、另一专辑及另一MixSongID', async () => {
  for (const patch of [{ is_free_part: 1 }, { timeLength: 30 }, { hash: 'other' },
    { album_id: 6 }, { album_audio_id: 124 }]) {
    const { request } = fixture({ song_url_auth: () => ({ ...full, ...patch }) });
    const result = await createKugouPlaybackResolver(request)(session(), track, options);
    assert.notEqual(result.state, 'allowed');
    assert.equal(result.canAttempt, undefined);
  }
});

test('不完整或错版本单曲授权不发送授权取链；失败会短期冷却', async () => {
  for (const grant of [{ auth: 'secret' }, { open_time: 123 }, { auth: 'secret', open_time: 0 },
    { auth: 'secret', open_time: 123, album_audio_id: 999 }]) {
    let clock = 0;
    const { calls, request } = fixture({ song_auth: () => ({ data: grant }) });
    const resolve = createKugouPlaybackResolver(request, () => clock), s = session();
    await resolve(s, track, options);
    await resolve(s, track, options);
    assert.equal(calls.filter(c => c.name === 'song_auth').length, 1);
    assert.equal(calls.some(c => c.name === 'song_url_auth'), false);
    clock = 30001;
    await resolve(s, track, options);
    assert.equal(calls.filter(c => c.name === 'song_auth').length, 2);
  }
});

test('设备注册失败保留常规兼容路径，不伪造dfid或发起授权链', async () => {
  let clock = 0;
  const { calls, request } = fixture({ register_dev: () => ({ data: {} }) });
  const resolve = createKugouPlaybackResolver(request, () => clock), s = session();
  await resolve(s, track, options);
  await resolve(s, track, options);
  assert.equal(calls.filter(c => c.name === 'register_dev').length, 1);
  assert.equal(calls.some(c => c.name === 'user_verify'), false);
  assert.equal(s.jar.dfid, undefined);
  clock = 30001;
  await resolve(s, track, options);
  assert.equal(calls.filter(c => c.name === 'register_dev').length, 2);
});

test('HTTP429或403后停止本曲取链，只有明确限流进入冷却', async () => {
  for (const status of [429, 403]) {
    let clock = 0;
    const { calls, request } = fixture({ song_url: () => { throw providerError({ status, body: { error_code: 1234 } }); } });
    const resolve = createKugouPlaybackResolver(request, () => clock), s = session();
    const result = await resolve(s, track, options);
    await resolve(s, track, options);
    assert.equal(calls.length, status === 429 ? 2 : 3);
    assert.equal(result.diagnostics.at(-1).httpStatus, status);
    assert.equal(result.diagnostics.at(-1).platformCode, 1234);
    clock = 30001;
    await resolve(s, track, options);
    assert.equal(calls.length, status === 429 ? 3 : 4);
  }
});

test('用户凭据过期后更新；失败诊断不反射上游错误文本', async () => {
  let clock = 0;
  const { calls, request } = fixture();
  const resolve = createKugouPlaybackResolver(request, () => clock), s = session();
  await resolve(s, track, options);
  clock = 600001;
  await resolve(s, track, options);
  assert.equal(calls.filter(c => c.name === 'user_verify').length, 2);
  const broken = fixture({ user_verify: () => { throw new Error('平台 private-account-token https://private.example/?auth=secret'); } });
  const result = await createKugouPlaybackResolver(broken.request)(session(), track, options);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('组件错误保留数字代码并丢弃伪装成本地错误的秘密文本', () => {
  const error = providerError({ providerFailure: true, message: '平台 secret', status: 401,
    body: { error_code: 20001, error: 'private-account-token https://private.example/' } });
  assert.equal(error.httpStatus, 401);
  assert.equal(error.platformCode, 20001);
  assert.equal(error.message.includes('secret'), false);
  assert.equal(error.message.includes('private-'), false);
  assert.equal(providerError(error), error);
});


test('已购歌曲常规返回错版本仍尝试当前版本授权，快速模式也能恢复', async () => {
  const { calls, request } = fixture({ song_url: () => ({ ...full, album_audio_id: 999 }) });
  const result = await createAccessChecker(request)(session(), track, true, { fastFallback: true });
  assert.equal(result.entitlement, 'purchased');
  assert.equal(result.state, 'allowed');
  assert.deepEqual(result.diagnostics.filter(d => d.stage.endsWith('_url')).map(d => d.outcome), ['wrong_recording', 'wrong_recording', 'complete']);
  assert.equal(calls.filter(c => c.name === 'song_auth').length, 1);
});

test('常规与授权都返回错版本时仍拒绝，未知权益不尝试已购授权', async () => {
  for (const purchased of [true, false]) {
    const f = fixture({
      user_purchased_songs: () => ({data: purchased ? [{album_audio_id:123}] : []}),
      song_url: () => ({...full, album_audio_id:999}),
      song_url_auth: () => ({...full, album_audio_id:999}),
    });
    const result = await createAccessChecker(f.request)(session(), track, true, {fastFallback:true});
    assert.notEqual(result.state,'allowed');
    assert.equal(f.calls.some(c => c.name === 'song_auth'), purchased);
  }
});

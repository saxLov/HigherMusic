import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessChecker } from '../lib/access.mjs';
import { createLyricsResolver } from '../lib/lyrics.mjs';
import { normalizeTrack } from '../lib/provider.mjs';
import { recordingMetadata, rememberRecordingMetadata, readRecordingMetadata, cachedRecordingMetadata } from '../lib/recording-metadata.mjs';

// Whitelisted public metadata read from KuGou on 2026-11-13. No URL or credentials.
const purchased = { hash: '0C806D7698AA8AFB31CF073CF16A3856', albumId: '983818', albumAudioId: 32253934, duration: 245.76 };
const resource = { hash: purchased.hash, album_id: purchased.albumId, album_audio_id: purchased.albumAudioId,
  info: { duration: 245760 }, trans_param: { language: '韩语', ogg_128_hash: '4C680B497CF6CE7D7F059FE17C3B8A0A', ogg_320_hash: 'DBEE57D7140D9EA18713EFA2FA4DEBAE' },
  relate_goods: [{ quality: '128', hash: '220E3C5EA998F1AEB7EC5C1A7EF8D077', album_id: '983818', album_audio_id: 32253934, info: { duration: 245760 }, privilege: 10, status: 0, pay_type: 3 }] };
const book = { hash: 'A7E525877D99F0397F4AC377C704AAC0', albumId: '1010570', albumAudioId: 32608618,
  title: '横山克 - 書店ガール (书店女孩)(Positive ver.).mp3', duration: 196.205 };
const bookResource = { hash: book.hash, album_id: book.albumId, album_audio_id: book.albumAudioId,
  trans_param: { language: '纯音乐', ogg_128_hash: '70914EDAA40D629AA335FE67BF76990F' } };
const full = { hash: resource.trans_param.ogg_128_hash, album_id: purchased.albumId, album_audio_id: purchased.albumAudioId,
  timeLength: 245760, url: ['https://example.com/fixture.ogg'] };
function fixture({ response = full, detail = resource, authorized = false } = {}) {
  const names = [];
  return { names, request: async (_, name) => {
    names.push(name);
    if (name === 'user_purchased_songs') return { data: [{ album_audio_id: purchased.albumAudioId }] };
    if (name === 'user_purchased_albums') return { data: [] };
    if (name === 'user_vip_detail') return { data: { is_vip: 0 } };
    if (name === 'privilege_lite') return { data: [detail] };
    if (name === 'song_url') return authorized ? {} : response;
    if (name === 'user_verify') return { data: { auth: 'fixture' } };
    if (name === 'song_auth') return { data: { auth: 'fixture', open_time: 123 } };
    if (name === 'song_url_auth') return response;
    throw Error('unexpected ' + name);
  } };
}
const session = () => ({ jar: { userid: 'fixture', token: 'fixture', dfid: 'fixture' } });
const cachedAccess = { eligible: true, state: 'allowed', entitlement: 'purchased' };

test('真实已购录音的普通与授权OGG响应按平台格式对应关系通过，不改变购买资格', async () => {
  for (const authorized of [false, true]) for (const cached of [false, true]) {
    const f = fixture({ authorized });
    const result = await createAccessChecker(f.request)(session(), purchased, true, { fastFallback: true, ...(cached ? { cachedAccess } : {}) });
    assert.equal(result.state, 'allowed');
    assert.equal(result.entitlement, 'purchased');
    assert.equal(result.diagnostics.at(-1).encodingMatched, true);
    assert.equal(f.names.filter(x => x === 'privilege_lite').length, 1);
    assert.equal(result.playbackIdentity.hash, purchased.hash);
  }
});

test('同录音MP3关联格式通过；320格式、陌生hash、另一专辑或录音和试听继续拒绝', async () => {
  const ok = fixture({ response: { ...full, hash: resource.relate_goods[0].hash } });
  assert.equal((await createAccessChecker(ok.request)(session(), purchased, true)).state, 'allowed');
  for (const patch of [{ hash: resource.trans_param.ogg_320_hash }, { hash: 'unrelated' }, { album_id: '999' },
    { album_audio_id: 999 }, { is_free_part: 1 }, { timeLength: 30000 }]) {
    const f = fixture({ response: { ...full, ...patch } });
    const r = await createAccessChecker(f.request)(session(), purchased, true, { cachedAccess, fastFallback: true });
    assert.notEqual(r.state, 'allowed');
    assert.equal(r.canAttempt, false);
  }
});

test('不借用错误专辑的格式映射或关联记录，时长明显不符的格式也不采用', () => {
  assert.equal(recordingMetadata(purchased, { ...resource, album_id: 'other' }), null);
  const bad = recordingMetadata(purchased, { ...resource, info: { duration: 30000 }, relate_goods: [
    { ...resource.relate_goods[0], album_audio_id: 999 }, { ...resource.relate_goods[0], hash: 'short', info: { duration: 30000 } }] });
  assert.deepEqual(bad.hashes, [purchased.hash.toLowerCase()]);
});

test('格式映射失败时保留未知并显示失败，不把映射视为购买证据', async () => {
  const f = fixture({ detail: { ...resource, album_id: 'wrong' } });
  const r = await createAccessChecker(f.request)(session(), purchased, true, { cachedAccess, fastFallback: true });
  assert.notEqual(r.state, 'allowed');
  assert.deepEqual(r.diagnostics.find(d => d.outcome === 'wrong_recording').mismatch, ['hash']);
  const noRights = fixture();
  const noPurchase = (s, name, ...args) => name === 'user_purchased_songs' ? { data: [] } : noRights.request(s, name, ...args);
  const available = await createAccessChecker(noPurchase)(session(), purchased, true);
  assert.equal(available.state, 'allowed');
  assert.equal(available.eligible, false);
  assert.equal(available.entitlement, 'unknown');
});

test('元数据缓存按会话、录音、刷新与登录凭据隔离，未成功查询不缓存', async () => {
  const s = session(), f = fixture();
  await readRecordingMetadata(s, purchased, f.request);
  await readRecordingMetadata(s, purchased, f.request);
  assert.equal(f.names.length, 1);
  s.sourceRevision = 1;
  await readRecordingMetadata(s, purchased, f.request);
  s.jar.token = 'new';
  await readRecordingMetadata(s, purchased, f.request);
  await readRecordingMetadata(session(), purchased, f.request);
  assert.equal(f.names.length, 4);
});

test('书店女孩排除平台返回的错误时长歌词后，依据精确录音的语种标记显示纯音乐', async () => {
  const names = [];
  const resolve = createLyricsResolver({ sources: {}, call: async (_, name) => {
    names.push(name);
    if (name === 'search_lyric') return { candidates: [{ id: '19525574', accesskey: 'fixture', duration: 320317 }] };
    if (name === 'privilege_lite') return { data: [bookResource] };
    throw Error('must not download another recording');
  } });
  assert.equal((await resolve({}, book)).state, 'instrumental');
  assert.deepEqual(names, ['search_lyric', 'privilege_lite']);
  assert.equal(normalizeTrack(bookResource).instrumental, true);
});

test('已确认的纯音乐无需再查歌词，普通缺失与错误录音的标记不能冒充纯音乐', async () => {
  const s = {}, resolve = createLyricsResolver({ sources: {}, call: async (_, name) =>
    name === 'search_lyric' ? { candidates: [] } : { data: [{ ...bookResource, album_audio_id: 999 }] } });
  rememberRecordingMetadata(s, book, bookResource);
  assert.equal((await resolve(s, book)).state, 'instrumental');
  assert.equal((await resolve({}, book)).state, 'missing');
  assert.equal((await resolve({}, purchased)).state, 'missing');
  assert.equal(normalizeTrack({ language: '日语' }).instrumental, undefined);
});

test('刷新期间迟到的元数据与权益检查不能重新填充旧的格式映射', async () => {
  for (const viaAccess of [false,true]) {
    const started=Promise.withResolvers(), finish=Promise.withResolvers(), s=session();
    const f=fixture();
    const request=async(...args)=>{
      if(args[1]==='privilege_lite'){started.resolve();await finish.promise;}
      return f.request(...args);
    };
    const pending=viaAccess ? createAccessChecker(request)(s,purchased,true) : readRecordingMetadata(s,purchased,request);
    await started.promise;s.sourceRevision=1;finish.resolve();await pending;
    assert.equal(cachedRecordingMetadata(s,purchased),null);
  }
});

test('后续取得明确纯音乐元数据后，不再复用先前缓存的文字歌词', async () => {
  const s={}, resolve=createLyricsResolver({sources:{},call:async(_,name)=>name==='search_lyric'
    ? {candidates:[{id:1,accesskey:'fixture',duration:196205}]} : {decodeContent:'[00:01]Earlier result'}});
  assert.equal((await resolve(s,book)).state,'ready');
  rememberRecordingMetadata(s,book,bookResource);
  assert.equal((await resolve(s,book)).state,'instrumental');
});

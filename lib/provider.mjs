/* 酷狗连接组件适配层。按需加载 .runtime 内的固定版本组件，统一 Cookie、超时和错误脱敏。
 * 负责把平台不同字段形状规范成项目字段；不决定某首歌是否有完整播放权限。 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverUrl } from './gallery.mjs';
import { instrumentalMetadata } from './recording-metadata.mjs';
import { legacyPlayInfo } from './kugou-legacy.mjs';
import { safeConnectionCode, withPlatformDeadline } from './gateway/transport.mjs';
const require = createRequire(import.meta.url);
let api;
const providerRoot = () => process.env.HIGHER_MUSIC_PROVIDER_PATH || fileURLToPath(new URL('../.runtime/source/KuGouMusicApi-main/', import.meta.url));
/* ready()：按需 require 本地酷狗连接组件并缓存；缺失或加载失败返回 false，页面据此提示安装。 */
export function ready() {
  try {
    api ??= require(path.join(providerRoot(), 'main.js'));
    return true;
  } catch {
    return false;
  }
}
// Keep numeric platform evidence without reflecting upstream text, URLs, or account credentials.
class ProviderFailure extends Error {}
const needsDeviceVerification = (body) =>
  String(body?.error ?? body?.error_msg ?? body?.msg ?? '').includes('本次请求需要验证');
export function providerError(error) {
  if (error instanceof ProviderFailure) return error;
  const number = (v) => Number.isSafeInteger(Number(v)) ? Number(v) : 0;
  const httpStatus = number(error?.status ?? error?.response?.status);
  const body = error?.body ?? error?.response?.data;
  const platformCode = number(body?.error_code) || number(body?.errcode) ||
    (needsDeviceVerification(body) ? 20028 : 0);
  const result = new ProviderFailure(`酷狗连接失败（HTTP ${httpStatus || '未知'}，错误码 ${platformCode}），请稍后重试。`);
  Object.assign(result, { httpStatus, platformCode, transportCode: safeConnectionCode(error) });
  return result;
}
// 歌词服务的业务码采用 HTTP 风格：200 成功，搜索 404 表示没有候选。
// 例外仅适用于歌词接口，不能放宽取链、权益或登录的成功条件。
export function providerBody(name, result) {
  const body = result?.body;
  const lyricEndpoint = name === 'search_lyric' || name === 'lyric';
  const emptySearch = name === 'search_lyric' && Number(body?.status) === 404 &&
    Number(body?.errcode) === 404 && Array.isArray(body?.candidates) && body.candidates.length === 0;
  const lyricSuccess = lyricEndpoint && Number(body?.status) === 200 && Number(body?.errcode) === 200;
  if (!body || Number(result.status) >= 400 || Number(body.error_code || 0) !== 0 ||
      (Number(body.errcode || 0) !== 0 && !lyricSuccess && !emptySearch) ||
      String(body.status) === '0' || needsDeviceVerification(body) ||
      (lyricEndpoint && Number(body.status) >= 400 && !emptySearch))
    throw providerError({ status: result?.status, body });
  return body;
}
/* call()：调用组件 name 接口，自动合并会话 Cookie 和设备标识，最长等待 20 秒。
 * 吸收返回 Cookie，检查平台状态；错误返回前去除凭证与签名 URL。 */
async function invoke(session, name, params = {}, { signal } = {}) {
  if (name === 'legacy_play_info') return legacyPlayInfo(params.hash, { signal });
  if (!ready()) throw new Error('酷狗连接组件尚未安装，请按 README 完成安装。');
  /* 每个会话单独生成平台所需设备字段，仅在会话内复用，不借用另一个账号的身份。 */
  session.jar ??= {};
  if (!session.jar.KUGOU_API_GUID) {
    const util = require(path.join(providerRoot(), 'util/util.js'));
    const guid = randomBytes(16).toString('hex');
    Object.assign(session.jar, {
      KUGOU_API_GUID: guid,
      KUGOU_API_MID: util.calculateMid(guid),
      KUGOU_API_DEV: randomBytes(16).toString('hex').toUpperCase(),
      KUGOU_API_MAC: '02:00:00:00:00:00',
      KUGOU_API_WEBGL: util.generateWebGLHash(),
    });
  }
  const fn = api[name];
  if (!fn) throw new Error('连接组件缺少所需接口。');
  try {
    const lyricEndpoint = name === 'search_lyric' || name === 'lyric';
    const result = await withPlatformDeadline(
      () => fn({ ...params, cookie: { ...session.jar } }), lyricEndpoint ? 8000 : 20000, signal);
    signal?.throwIfAborted();
    for (const cookie of result.cookie ?? []) {
      const pair = cookie.split(';')[0];
      const at = pair.indexOf('=');
      if (at > 0) session.jar[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return providerBody(name, result);
  } catch (error) {
    signal?.throwIfAborted();
    throw providerError(error);
  }
}
const recoverableReads = new Set([
  'login_qr_key', 'search', 'privilege_lite', 'song_url', 'user_verify',
  'user_playlist', 'playlist_track_all', 'playlist_track_all_new',
  'user_purchased_songs', 'user_purchased_albums', 'user_vip_detail',
]);

// Refresh the same session's device credential once after an explicit verification challenge.
export function withDeviceRecovery(request, now = Date.now) {
  const refreshes = new WeakMap();
  return async (session, name, params, options) => {
    try { return await request(session, name, params, options); }
    catch (error) {
      if (error?.platformCode !== 20028 || [403, 429].includes(error.httpStatus) ||
          !recoverableReads.has(name)) throw error;
      let refresh = refreshes.get(session);
      if (!refresh?.pending) {
        if (refresh && now() < refresh.retryAt) throw error;
        refresh = { retryAt: now() + 60000 };
        refreshes.set(session, refresh);
        refresh.pending = (async () => {
          const old = session.jar.dfid;
          delete session.jar.dfid;
          try {
            const body = await request(session, 'register_dev', {});
            const dfid = body?.data?.dfid;
            if (typeof dfid !== 'string' || !dfid.trim() || dfid.length > 8192) throw error;
            session.jar.dfid = dfid;
          } catch (failure) {
            if (old) session.jar.dfid = old;
            else delete session.jar.dfid;
            throw failure;
          }
        })();
        refresh.pending.finally(() => { refresh.pending = null; }).catch(() => {});
      }
      await refresh.pending;
      options?.signal?.throwIfAborted();
      return request(session, name, params, options);
    }
  };
}
export const call = withDeviceRecovery(invoke);
/* listFrom()：从平台多个已知字段中找数组；合法空数组可返回，未知结构抛错，避免悄悄漏数据。 */
export function listFrom(body) {
  const d = body?.data;
  for (const x of [
    d?.info,
    d?.lists,
    d?.list,
    d?.songs,
    d?.goods,
    d?.goods_list,
    d?.file,
    d?.files,
    d?.data,
    d?.songs?.list,
    body?.info,
    body?.list,
    d,
  ])
    if (Array.isArray(x)) return x;
  throw new Error('平台返回的数据格式尚未适配，请稍后重试。');
}
/* normalizeTrack()：把平台原始记录转换为统一歌曲模型；合并 fileinfo，规范封面 URL 和秒单位时长，初始状态为未检查。 */
export function normalizeTrack(x) {
  x = { ...x, ...x.fileinfo };
  const duration = Number(x.duration ?? x.timelen ?? x.time_length ?? 0);
  return {
    id: String(x.album_audio_id || x.audio_id || x.hash || x.filehash || ''),
    hash: x.hash ?? x.filehash,
    albumId: x.album_id ?? x.albumid,
    albumAudioId: x.album_audio_id ?? x.mixsongid,
    audioId: x.audio_id,
    album: x.album_name ?? x.albumname,
    title: x.name ?? x.filename ?? x.songname ?? x.audio_name ?? '未命名歌曲',
    ...(instrumentalMetadata(x) ? { instrumental: true } : {}),
    artist: x.singername ?? x.author_name ?? '',
    cover: coverUrl(x.sizable_cover, x.cover, x.album_img, x.img),
    duration: duration > 10000 ? duration / 1000 : duration,
    state: 'unchecked',
    reason: '尚未检查',
  };
}

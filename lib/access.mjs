/* 账号权益与音源检查的编排层。先查购买/会员，再查歌曲权益，最后核验平台返回音源。
 * 权益分类由 entitlements.mjs 完成，音源完整性由 rights.mjs 完成。
 * 所有缓存挂在当前 session，不在账号之间共享；play=true 时才附带供播放处理的地址。 */
import { createConceptBenefits } from './kugou-benefits.mjs';
import { call } from './provider.mjs';
import { collectPages } from './pagination.mjs';
import { classify } from './entitlements.mjs';
import { createKugouPlaybackResolver } from './kugou-playback.mjs';
import { keepPurchaseEvidence } from '../public/track-state.mjs';
import { matchingResource, recordingMetadata, rememberRecordingMetadata } from './recording-metadata.mjs';
const transportFailure = (e) => [403, 404, 408, 429, 500, 502, 503, 504].includes(e?.httpStatus);
/* createAccessChecker()：创建可注入 request 与时钟的检查器，便于单元测试；返回 checkAccess(s, track, play)。 */
export function createAccessChecker(request = call, now = Date.now) {
  const resolvePlayback = createKugouPlaybackResolver(request, now);
  const conceptBenefits = createConceptBenefits(request, now);
  /* 普通读取缓存两小时；主动刷新绕过缓存，失败后十秒重试。 */
  async function fetchAccount(s, refresh = false, fastFallback = false, signal) {
    const ttl = s.accountRights?.errors?.length ? 10000 : 7200000;
    if (!refresh && s.accountRights && now() - s.accountRights.time < ttl) return s.accountRights;
    /* 保留权益与音源两个维度，前端可区分“已购但音源暂不可用”和“权益仍待核对”。 */
    const result = { songs: [], albums: [], vip: null, errors: [], time: now() };
    await conceptBenefits(s, signal);
    /* 分开查询单曲、专辑和会员；一项失败记在 errors，不把失败误当“用户没有购买”。 */
    for (const [key, name] of [
      ['songs', 'user_purchased_songs'],
      ['albums', 'user_purchased_albums'],
      ['vip', 'user_vip_detail'],
    ]) {
      try {
        result[key] =
          key === 'vip'
            ? (await request(s, name, {}, { signal })).data
            : await collectPages(
                (page, pagesize) => request(s, name, { page, pagesize }, { signal }),
                { pageSize: name === 'user_purchased_albums' ? 15 : 50 },
              );
        if (
          key === 'vip' &&
          (!result.vip || typeof result.vip !== 'object' || Array.isArray(result.vip))
        )
          throw new Error('会员数据格式尚未适配');
      } catch (e) {
        signal?.throwIfAborted();
        if ([403,429].includes(e?.httpStatus)) throw e;
        result.errors.push(`${key}: ${e.message}`);
        if (fastFallback && transportFailure(e)) {
          for (const rest of ['songs','albums','vip']) if (rest !== key && (rest === 'vip' ? !result.vip : !result[rest].length))
            result.errors.push(`${rest}: 账号接口暂不可用，留待复查`);
          break;
        }
      }
    }
    result.time = now();
    signal?.throwIfAborted();
    // A partial account fetch must not erase previously observed purchases.
    for (const key of ['songs','albums']) if (result.errors.some(e => e.startsWith(key + ':')) && s.accountRights?.[key]?.length) result[key] = s.accountRights[key];
    s.accountRights = result;
    return result;
  }
  /* checkAccess()：对单个歌曲版本组合账号权益与音源检查。play=false 返回资格摘要，true 额外返回播放候选地址。
   * refreshAccount 用于主动复查的首首歌曲，刷新账号缓存一次；其余歌曲复用当前账号缓存。
   * 相关 128 音质只允许同专辑、同 MixSongID；最终候选标识回传，历史上报据此核对。 */
  const pending = new WeakMap();
  async function account(s, refresh = false, fastFallback = false, signal) {
    signal?.throwIfAborted();
    let entry = pending.get(s);
    // A refresh may join another refresh, but must not reuse an older warm-up read.
    if (refresh && entry && !entry.refresh) {
      try { await entry.promise; } catch { signal?.throwIfAborted(); }
      signal?.throwIfAborted();
      return account(s, true, fastFallback, signal);
    }
    if (!entry) {
      const control = s.rightsWarmControl ??= new AbortController();
      entry = { refresh };
      entry.promise = fetchAccount(s, refresh, fastFallback, control.signal).finally(() => { if (pending.get(s) === entry) pending.delete(s); });
      pending.set(s, entry);
    }
    const promise = entry.promise;
    if (!signal) return promise;
    return new Promise((resolve,reject) => {
      const abort = () => reject(new DOMException('任务已取消','AbortError'));
      signal.addEventListener('abort',abort,{once:true});
      promise.then(value => { signal.removeEventListener('abort',abort); signal.aborted ? abort() : resolve(value); }, error => { signal.removeEventListener('abort',abort); reject(error); });
    });
  }
  const checkAccess = async function checkAccess(s, track, play = false, { refreshAccount = false, cachedAccess, knownPurchase, fastFallback = false, authorizedOnly = false, signal, quality = '128' } = {}) {
    signal?.throwIfAborted();
    const metadataContext = [s.sourceRevision, s.jar?.token, s.jar?.userid];
    const a = cachedAccess ? { errors: [] } : await account(s, refreshAccount, fastFallback, signal);
    let resource;
    let detailError;
    if (!cachedAccess) try {
      const body = await request(s, 'privilege_lite', {
        hash: track.hash,
        album_id: track.albumId,
        album_audio_id: track.albumAudioId,
        qualities: '128',
      }, { signal });
      resource = matchingResource(body, track);
      if (!resource) detailError = '平台返回的权益记录未匹配到当前歌曲';
    } catch (e) {
      signal?.throwIfAborted();
      if ([403,429].includes(e?.httpStatus)) throw e;
      detailError = e.message;
    }
    // 同 hash 也不能借用另一专辑版本的权益或关联音源。
    const identityId = (value) =>
      value == null || ['', '0'].includes(String(value).trim()) ? '' : String(value).trim();
    const sameId = (left, right) =>
      !identityId(left) || !identityId(right) || identityId(left) === identityId(right);
    const inheritId = (value, fallback) => identityId(value) ? value : fallback;
    if (resource && (
      !sameId(track.albumAudioId, resource.album_audio_id) ||
      !sameId(track.albumId, resource.album_id)
    )) {
      detailError = '权益记录的专辑版本与当前歌曲不一致';
      resource = undefined;
    }
    const classified = cachedAccess ? {
      state: cachedAccess.eligibilityState ?? cachedAccess.state,
      eligible: cachedAccess.eligible === true,
      entitlement: cachedAccess.entitlement,
      reason: cachedAccess.entitlementReason ?? cachedAccess.reason ?? '权益待确认',
    } : keepPurchaseEvidence(knownPurchase, classify(track, resource, a));
    const right = { ...classified, state: classified.eligibilityState ?? classified.state,
      reason: classified.entitlementReason ?? classified.reason };
    /* 先用歌单的原版本请求，必要时再试平台给出的普通 128 音质关联版本，缺少专辑标识时沿用原版本。 */
    const related = Array.isArray(resource?.relate_goods) ? resource.relate_goods : [];
    const candidates = [
      track,
      ...(cachedAccess?.playbackIdentity &&
        sameId(track.albumId, cachedAccess.playbackIdentity.albumId) &&
        sameId(track.albumAudioId, cachedAccess.playbackIdentity.albumAudioId)
        ? [cachedAccess.playbackIdentity] : []),
      ...related
        .filter((x) => x && String(x.quality) === '128' &&
          sameId(track.albumAudioId, x.album_audio_id) && sameId(track.albumId, x.album_id))
        .map((x) => ({
          hash: x.hash,
          albumId: inheritId(x.album_id, inheritId(resource?.album_id, track.albumId)),
          albumAudioId:
            inheritId(x.album_audio_id, inheritId(resource?.album_audio_id, track.albumAudioId)),
        })),
    ];
    const diagnostics = [];
    const recording = metadataContext.every((value, index) => value === [s.sourceRevision, s.jar?.token, s.jar?.userid][index])
      ? rememberRecordingMetadata(s, track, resource) : recordingMetadata(track, resource);
    let media = { state: 'unknown', reason: detailError ?? '尚未取得可播放音源' };
    if (right.state !== 'unavailable') {
      const seen = new Set();
      for (const item of candidates) {
        const key = `${item.hash}:${item.albumId}:${item.albumAudioId}`;
        if (!item.hash || seen.has(key)) continue;
        seen.add(key);
        try {
          const candidate = await resolvePlayback(s, item, {
            duration: track.duration || resource?.info?.duration / 1000,
            fastFallback, authorizedOnly, signal, recording, quality,
            allowAuthorization: right.state === 'allowed' && right.eligible === true,
          });
          diagnostics.push(...candidate.diagnostics);
          if (media.state !== 'allowed' && (candidate.canAttempt || !media.canAttempt))
            media = {
              ...candidate,
              identity: {
                hash: item.hash,
                albumId: item.albumId,
                albumAudioId: item.albumAudioId,
              },
            };
          if (media.state === 'allowed' ||
              (fastFallback && candidate.diagnostics.some(d => transportFailure(d) || d.outcome === 'wrong_recording'))) break;
        } catch (e) {
          signal?.throwIfAborted();
          if (!media.canAttempt) media = { state: 'unknown', reason: e.message };
        }
      }
    }
    const result = {
      ...right,
      playbackState: media.state,
      playbackReason: media.reason,
      accountWarnings: a.errors,
      diagnostics,
    };
    // 完整音源只更新 playbackState，绝不提升账号权益或伪造购买/会员来源。
    /* 播放响应的 state 表示此次音源能否完整播放；原权益 state 另保存在 eligibilityState。 */
    if (play)
      return {
        ...result,
        eligibilityState: result.state,
        entitlementReason: result.reason,
        state:
          media.state === 'allowed'
            ? 'allowed'
            : 'unknown',
        canAttempt: !!media.canAttempt,
        playbackIdentity: media.identity,
        expectedDuration: media.expectedDuration,
        url: media.url,
        urls: media.urls,
        originalUrls: media.originalUrls,
        reason:
          media.state === 'allowed' ? `${result.reason}；平台已返回完整音源` : `${result.reason}；${media.reason}`,
      };
    return result;
  };
  checkAccess.warmAccount = (s, signal) => account(s, false, false, signal);
  return checkAccess;
}
export const checkAccess = createAccessChecker();

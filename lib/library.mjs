/* 当前登录会话内的歌曲库与“暂不可播放”虚拟歌单。
 * 只整理访问过的歌单及检查结果，不创建或修改酷狗账号中的真实歌单。 */
import { applyAccessResult, matchesAccount } from '../public/track-state.mjs';

export const unauthorizedId = 'local:unauthorized';

export function playbackAvailability(track, playable, reason) {
  return { ...track, state: playable ? 'allowed' : track.state, eligibilityState: track.state,
    playbackState: playable ? 'allowed' : 'unknown',
    playbackReason: reason, playable, sourceChecked: true };
}

/* registerTracks()：登记一个歌单的全部歌曲。组合原 ID 与小写 hash 为稳定键，保留之前已检查的权益。
 * 重建跨已访问歌单的索引，避免切换歌单后丢失虚拟歌单中歌曲。 */
export function registerTracks(session, playlistId, tracks, { stableIds = false } = {}) {
  session.library ??= new Map();
  const rows = tracks.map((track) => {
    const key = stableIds ? track.id : `${track.id}:${String(track.hash ?? '').toLowerCase()}`;
    const old = session.tracks.get(key);
    return {
      ...old,
      ...track,
      id: key,
      ...(old?.checked
        ? {
            checked: true,
            state: old.state,
            eligible: old.eligible,
            entitlement: old.entitlement,
            reason: old.reason,
            playbackState: old.playbackState,
            playbackReason: old.playbackReason,
            accountWarnings: old.accountWarnings,
            diagnostics: old.diagnostics,
            playbackIdentity: old.playbackIdentity,
            sourcePlayable: old.sourcePlayable,
          }
        : {}),
    };
  });
  session.library.set(playlistId, rows);
  // Keep tracks from all visited playlists available for the local collection.
  session.tracks = new Map(
    [...session.library.values()]
      .flat()
      .filter((t) => t.id && (t.hash || t.provider === 'netease'))
      .map((t) => [t.id, t]),
  );
  return rows.map((t) => session.tracks.get(t.id) ?? t);
}

/* unauthorizedTracks()：收集已检查且权益或音源未通过的歌曲；保留已购证据用于解释音源故障。 */
export function unauthorizedTracks(session) {
  const rows = new Map([...(session.searchTracks ?? []), ...session.tracks]);
  return [...rows.values()].filter(t => t.checked &&
    !(t.sourcePlayable ?? (matchesAccount(t) && t.playbackState === 'allowed')));
}

/* localPlaylist()：首次检查后返回虚拟歌单元数据和当前数量；检查前返回 null，不创建平台真实歌单。 */
export function localPlaylist(session) {
  return session.hasChecks
    ? {
        id: unauthorizedId,
        name: '音源待确认',
        count: unauthorizedTracks(session).length,
        local: true,
      }
    : null;
}

/* recordAccess()：保存当次检查结果，并同步到其他已访问歌单内的同版本记录，最后返回虚拟歌单计数。 */
export function recordAccess(session, track, result, { sync = true } = {}) {
  applyAccessResult(track, result);
  if (typeof result.playable === 'boolean') track.sourcePlayable = result.playable;
  track.checked = true;
  session.hasChecks = true;
  if (!sync) return;
  // A recording shared by several playlists must keep one current rights result.
  for (const rows of session.library?.values() ?? []) {
    for (const item of rows)
      if (item.id === track.id && item !== track) {
        applyAccessResult(item, result);
        item.sourcePlayable = track.sourcePlayable;
        item.checked = true;
      }
  }
  return localPlaylist(session);
}

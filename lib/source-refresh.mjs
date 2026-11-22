import { recordingKey } from './audio-cache.mjs';
// Refresh invalidates derived selections, never persisted purchase evidence or audio files.
export const sourceRevision = session => session.sourceRevision ?? 0;
export function assertSourceRevision(session, revision) {
  if (sourceRevision(session) !== revision)
    throw new DOMException('权限与音源已更新，请重新播放', 'AbortError');
}
export function refreshSources(session, track, accountFresh, audioCache) {
  session.sourceRevision = sourceRevision(session) + 1;
  session.cancelPreparation?.();
  session.playRequest?.abort();
  session.standbyAudio = undefined;
  session.inspections?.clear();
  if (accountFresh) {
    session.rightsFreshAt = Date.now();
    session.cacheGrants?.clear();
    session.kugouHealth = undefined;
    session.playbackSources?.clear();
  } else {
    session.cacheGrants?.delete(recordingKey(track));
    session.playbackSources?.delete(track.id);
  }
  return session.sourceRevision;
}

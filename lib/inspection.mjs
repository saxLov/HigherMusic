import { isPlayableCandidate } from './scheduler/audio-fallback.mjs';
import { sourceRevision, assertSourceRevision } from './source-refresh.mjs';
/* 只缓存短期检查摘要，不保存/返回平台音源，不签发音频票据。 */
export function createInspector(check, now = Date.now) {
  return async (s, track, fresh = false, refreshAccount = false, knownPurchase) => {
    const revision = sourceRevision(s);
    s.inspections ??= new Map();
    const previous = s.inspections.get(track.id);
    if (!fresh && !refreshAccount && previous && now() - previous.time < 30000) return previous.result;
    const raw = await check(s, track, true, { refreshAccount, knownPurchase });
    assertSourceRevision(s, revision);
    const { url, urls, ...result } = raw;
    result.playable = isPlayableCandidate({ ...result, url, urls });
    s.inspections.set(track.id, { time: now(), result });
    while (s.inspections.size > 2048) s.inspections.delete(s.inspections.keys().next().value);
    return result;
  };
}

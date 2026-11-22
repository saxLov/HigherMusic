import { setTimeout as wait } from 'node:timers/promises';
import { isAudioHttpsUrl } from '../gateway/audio-policy.mjs';

export function isPlayableCandidate(result) {
  return result?.state === 'allowed' && result.playbackState === 'allowed' &&
    [result.url, ...(result.urls ?? [])].some(url => typeof url === 'string' && isAudioHttpsUrl(url));
}

// Start resolving the backup during a slow primary. The primary keeps priority
// while its entitlement check is in flight, and only the selected result gets tickets.
export async function prepareAudioFallback(primary, backup, {
  delayMs = 200, prefetch = true, now = () => performance.now(), parentSignal,
} = {}) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  const start = now();
  let started = false, readyBackup;
  const main = Promise.resolve().then(primary);
  const trigger = prefetch
    ? Promise.race([main, wait(delayMs, undefined, { signal })])
    : main;
  const fallback = trigger.then(async (result) => {
    if (signal.aborted || isPlayableCandidate(result)) return null;
    started = true;
    const candidate = await backup(signal);
    if (isPlayableCandidate(candidate)) readyBackup = candidate;
    return readyBackup ?? null;
  }).catch(() => null);

  try {
    const original = await main;
    const candidate = isPlayableCandidate(original) ? null : await fallback;
    return {
      original,
      candidate,
      standby: candidate ? undefined : readyBackup,
      scheduling: {
        backup: candidate ? 'selected' : readyBackup ? 'unused' :
          started ? (isPlayableCandidate(original) ? 'cancelled' : 'unavailable') : 'not_started',
        elapsedMs: Math.round(Math.max(0, now() - start)),
      },
    };
  } finally {
    controller.abort();
  }
}

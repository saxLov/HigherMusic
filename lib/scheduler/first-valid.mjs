import { setTimeout as wait } from 'node:timers/promises';

// A fast valid primary avoids contacting the fallback. An empty/failed primary releases it immediately.
export async function firstValid(primary, fallback, delayMs, parentSignal) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  try {
    const main = primary(signal);
    if (!fallback) return await main;
    const backup = Promise.race([wait(delayMs, undefined, { signal }), main]).then(async (value) =>
      value ? null : fallback(signal));
    // A miss waits for the other candidate. Either valid response can complete the request.
    const first = await Promise.race([
      main.then(value => ({ value, other: backup })),
      backup.then(value => ({ value, other: main })),
    ]);
    return first.value ?? await first.other;
  } finally {
    controller.abort();
  }
}

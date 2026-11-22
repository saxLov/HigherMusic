import { setTimeout as wait } from 'node:timers/promises';

export function createSourceQueue({ now = Date.now, spacingMs = 350 } = {}) {
  let tail = Promise.resolve(), pending = 0, next = 0;
  const health = new Map();

  return (type, operation, signal) => {
    const available = () => {
      signal?.throwIfAborted();
      if (now() < (health.get(type)?.until ?? 0))
        throw Object.assign(new Error('平台操作暂在冷却中'), { cooling: true });
    };
    if (pending >= 5) return Promise.reject(new Error('平台请求队列已满'));
    pending++;
    const result = tail.then(async () => {
      available();
      const pause = next - now();
      if (pause > 0) await wait(pause, undefined, { signal });
      available();
      try {
        const value = await operation();
        if (!signal?.aborted) health.delete(type);
        return value;
      } catch (error) {
        if (signal?.aborted) throw error;
        const state = health.get(type) ?? { failures: 0, until: 0 };
        const status = error?.httpStatus;
        if (status === 429 || error?.platformCode === 429) {
          const retry = Number(error.retryAfterMs);
          state.until = now() + (retry > 0 ? Math.min(retry, 300000) : 60000);
        } else if (status === 408 || status >= 500 || error?.transportCode) {
          if (++state.failures >= 3)
            state.until = now() + Math.min(15000 * 2 ** (state.failures - 3), 120000);
        } else {
          health.delete(type);
          throw error;
        }
        health.set(type, state);
        throw error;
      } finally {
        next = now() + spacingMs;
      }
    });
    tail = result.catch(() => {}).finally(() => { pending--; });
    return result;
  };
}

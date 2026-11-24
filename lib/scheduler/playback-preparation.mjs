import { recordingKey } from '../audio-cache.mjs';

// URLs live only in the owning login session. Foreground and preparation share work.
export function createPlaybackPreparation({ now = Date.now, limit = 2 } = {}) {
  const states = new WeakMap(), queue = [], running = new Set();
  const abortError = () => new DOMException('任务已取消', 'AbortError');
  const state = s => {
    if (!states.has(s)) states.set(s, { cache: new Map(), jobs: new Map(), wanted: new Set(), metrics: { hits: 0, merged: 0, resolved: 0 } });
    return states.get(s);
  };
  function pump() {
    queue.sort((a, b) => Number(b.foreground) - Number(a.foreground));
    while (running.size < limit) {
      const index = queue.findIndex(job => job.foreground || ![...running].some(item => !item.foreground));
      if (index < 0) return;
      const job = queue.splice(index, 1)[0];
      if (job.control.signal.aborted) {
        if (job.owner.jobs.get(job.key) === job) job.owner.jobs.delete(job.key);
        job.reject(abortError()); continue;
      }
      running.add(job);
      Promise.resolve().then(() => job.run(job.control.signal, !job.foreground)).then(value => {
        job.control.signal.throwIfAborted();
        const result = value.result;
        if (result?.state === 'allowed' && result.playbackState === 'allowed' && result.url) {
          // Unknown platform URL expiry: five minutes maximum. Never extend explicit expiry.
          const urls = [result.url, ...(result.urls || [])];
          let until = now() + 300000, ticketUntil = Infinity;
          for (const raw of urls) {
            const url = URL.parse(raw);
            for (const name of ['expires', 'expire', 'deadline']) {
              const number = Number(url?.searchParams.get(name));
              if (number > 1e9) ticketUntil = Math.min(ticketUntil, (number > 1e12 ? number : number * 1000) - 30000);
            }
          }
          until = Math.min(until, ticketUntil);
          value = { ...value, selectionUntil: until, ticketUntil };
          if (until > now()) job.owner.cache.set(job.key, { value, until });
          while (job.owner.cache.size > 128) job.owner.cache.delete(job.owner.cache.keys().next().value);
        }
        job.owner.metrics.resolved++; job.resolve(value);
      }).catch(job.reject).finally(() => {
        running.delete(job); if (job.owner.jobs.get(job.key) === job) job.owner.jobs.delete(job.key); pump();
      });
    }
  }
  function wait(job, signal) {
    signal?.throwIfAborted(); job.readers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return; done = true; signal?.removeEventListener('abort', abort);
        if (--job.readers === 0 && !job.background) job.control.abort();
        fn(value);
      };
      const abort = () => finish(reject, abortError());
      signal?.addEventListener('abort', abort, { once: true });
      job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  const api = {
    async get(s, track, { signal, run, background = false, fresh = false, variant = '' } = {}) {
      signal?.throwIfAborted();
      const owner = state(s), key = recordingKey(track) + variant;
      if (!background) for (const job of owner.jobs.values()) if (job.key !== key && !job.foreground) {
        job.background = false; job.control.abort();
      }
      if (fresh) { owner.cache.delete(key); const old = owner.jobs.get(key); old?.control.abort(); owner.jobs.delete(key); }
      const cached = owner.cache.get(key);
      if (!fresh && cached && cached.until > now()) { owner.metrics.hits++; return { ...cached.value, selectionHit: true }; }
      let job = owner.jobs.get(key);
      if (job?.control.signal.aborted) { owner.jobs.delete(key); job = null; }
      if (job) { owner.metrics.merged++; if (!background) job.foreground = true; if (background) job.background = true; }
      else {
        if (queue.length >= 32) throw new Error('准备队列已满');
        job = { owner, key, control: new AbortController(), readers: 0, foreground: !background, background, run };
        job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
        owner.jobs.set(key, job); queue.push(job);
      }
      const result = wait(job, signal); pump(); return result;
    },
    prepare(s, tracks, run) {
      const owner = state(s), wanted = new Set(tracks.slice(0, 2).map(recordingKey));
      owner.wanted = wanted;
      for (const job of owner.jobs.values()) if (!job.foreground && !wanted.has(job.key)) { job.background = false; job.control.abort(); }
      const completion = Promise.allSettled(tracks.slice(0, 2).map(track => api.get(s, track, { background: true,
        run: (signal, background) => run(track, signal, background) }).then(selection => ({ track, selection }))));
      return { planned: Math.min(2, tracks.length), completion };
    },
    invalidate(s, track) { const owner = state(s), key = recordingKey(track);
      for (const id of owner.cache.keys()) if (id.startsWith(key)) owner.cache.delete(id);
      for (const job of owner.jobs.values()) if (job.key.startsWith(key)) job.control.abort();
    },
    cancel(s) { const owner = state(s); owner.wanted.clear(); for (const job of owner.jobs.values()) {
      job.background = false; job.control.abort();
    } owner.cache.clear(); },
    metrics: s => ({ ...state(s).metrics, preparing: state(s).jobs.size }),
  };
  return api;
}

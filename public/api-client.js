/* 读取/播放独立通道；修改与历史保留顺序队列。 */
(function (root) {
  function createApiClient(base = '') {
    const pending = [];
    let running = false;
    async function drain() {
      if (running) return;
      running = true;
      try {
        while (pending.length) {
          pending.sort((a, b) => b.priority - a.priority);
          const job = pending.shift();
          if (job.signal?.aborted || !job.valid()) { job.reject(new DOMException('任务已失效', 'AbortError')); continue; }
          await execute(job);
        }
      } finally { running = false; }
    }
    async function execute(job) {
          if (job.signal?.aborted || !job.valid()) return job.reject(new DOMException('任务已失效', 'AbortError'));
          const control = new AbortController();
          const abort = () => control.abort();
          job.signal?.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(() => control.abort(), 180000);
          try {
            const response = await fetch(base + '/api/' + job.route, {
              method: job.method, credentials: 'include', signal: control.signal,
              ...(job.body === undefined ? {} : {
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.body),
              }),
            });
            let data;
            try { data = await response.json(); }
            catch { throw new Error('接口返回格式无效'); }
            if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
            job.resolve(data);
          } catch (error) {
            job.reject(job.signal?.aborted ? new DOMException('任务已失效', 'AbortError') :
              error.name === 'AbortError' ? new Error('平台响应超时，请重试') : error);
          } finally {
            clearTimeout(timer);
            job.signal?.removeEventListener('abort', abort);
          }
    }
    return (route, method = 'GET', valid = () => true, options = {}) => new Promise((resolve, reject) => {
      const priority = options.priority ?? (/^(?:play\?|lyrics\?|logout)/.test(route) ? 10 : 0);
      const job = { route, method, valid, body: options.body, signal: options.signal, priority, resolve, reject };
      if (options.concurrent || /^(?:play\?|local-play\?|playlists(?:\?|$)|tracks\?|prepare$|rights-warm$|logout$)/.test(route)) queueMicrotask(() => execute(job));
      else { pending.push(job); queueMicrotask(() => queueMicrotask(drain)); }
    });
  }
  root.HigherApi = { createApiClient };
})(globalThis);

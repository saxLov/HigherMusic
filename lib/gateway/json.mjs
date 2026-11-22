import { safeConnectionCode } from './transport.mjs';

export async function readPlatformJson(url, options, { timeoutMs, maxBytes }, fetcher = fetch) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let reader;
  try {
    const response = await fetcher(url, { ...options, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter && (/^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
      throw Object.assign(new Error('平台暂未接受请求'), { httpStatus: response.status, retryAfterMs });
    }
    reader = response.body?.getReader();
    if (!reader || Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('平台响应大小异常');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parts = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('平台响应超出大小限制');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timeout.aborted)
      throw Object.assign(new Error('平台响应超时'), { httpStatus: 408 });
    if (error.httpStatus) throw error;
    throw Object.assign(new Error('平台响应无法读取'), { transportCode: safeConnectionCode(error) });
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

const connectionCodes = /^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_(?:CERT|SSL|CONNECTION|NAME|PROXY|TUNNEL|ADDRESS|NETWORK|TIMED_OUT)[A-Z_]*|ERR_TLS_[A-Z_]+)$/;

export function safeConnectionCode(error) {
  const raw = error?.cause?.code ?? error?.code ?? /^net::([A-Z_]+)$/.exec(error?.message ?? '')?.[1];
  return typeof raw === 'string' && connectionCodes.test(raw) ? raw : undefined;
}

export function upstreamDeadline(response, timeoutMs) {
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

// A component may own its socket. Stop waiting and discard late results at the adapter boundary.
export async function withPlatformDeadline(operation, timeoutMs, signal) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  let cancel;
  try {
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(combined.reason);
      combined.addEventListener('abort', cancel, { once: true });
    });
    return await Promise.race([operation(), cancelled]);
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted)
      throw Object.assign(new Error('平台响应超时，请稍后重试。'), { status: 408 });
    throw error;
  } finally {
    combined.removeEventListener('abort', cancel);
  }
}

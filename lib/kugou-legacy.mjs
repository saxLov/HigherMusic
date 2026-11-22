import { withPlatformDeadline } from './gateway/transport.mjs';
// A fixed public KuGou endpoint; never forwards the account cookie to the mobile site.
export async function legacyPlayInfo(hash, { signal } = {}, fetcher = fetch) {
  const url = new URL('https://m.kugou.com/app/i/getSongInfo.php');
  url.searchParams.set('cmd', 'playInfo');
  url.searchParams.set('hash', hash);
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  return withPlatformDeadline(async () => {
    const response = await fetcher(url, { signal: boundedSignal, credentials: 'omit', redirect: 'error',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36' } });
    if (!response.ok) throw Object.assign(new Error('legacy request failed'), { httpStatus: response.status });
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Number(body.status) === 0)
      throw new Error('legacy response unavailable');
    return { ...body, backupUrl: body.backup_url ?? body.backupUrl };
  }, 8000, signal);
}

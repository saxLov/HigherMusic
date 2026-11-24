/* 同源音频转发层。服务端把已确认完整的音源换成会话内随机 ticket。
 * 浏览器用 /api/audio?ticket=... 播放，支持进度拖动的 Range 请求，也让 Web Audio 可同源分析。 */
import { isNeteaseMediaUrl } from './sources/netease.mjs';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import { safeConnectionCode, upstreamDeadline } from './gateway/transport.mjs';
import { fetchPublicAudio, isAudioHttpsUrl, isKugouHost, parseByteRange, validAudioType,
  validPartialAudio } from './gateway/audio-policy.mjs';

// Only these verified KuGou media hosts may use a platform-issued HTTP URL.
const kugouHttpHosts = new Set(['fs.youthandroid.kugou.com', 'fs.youthandroid2.kugou.com']);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function validRedirect(from, to, netease) {
  if (!isAudioHttpsUrl(to)) return false;
  if (netease) return isNeteaseMediaUrl(to);
  const currentHost = new URL(from).hostname, nextHost = new URL(to).hostname;
  return currentHost === nextHost || (isKugouHost(currentHost) && isKugouHost(nextHost));
}

function isOriginalKugouHttp(raw) {
  const url = URL.parse(raw);
  return url?.protocol === 'http:' && kugouHttpHosts.has(url.hostname) &&
    !url.port && !url.username && !url.password;
}

function mediaHost(value) {
  return typeof value === 'string' && /^[a-z0-9.:-]{1,253}$/i.test(value) ? value : undefined;
}

async function fetchAttempt(url, options, fetcher, transport, attempts) {
  const address = URL.parse(url);
  const entry = { transport, protocol: address?.protocol, host: mediaHost(address?.hostname) };
  attempts.push(entry);
  try {
    const response = await fetcher(url, options);
    entry.status = response.status;
    entry.responseHost = mediaHost(URL.parse(response.url)?.hostname);
    return response;
  } catch (error) {
    entry.error = safeConnectionCode(error) ?? (options.signal.aborted ? 'aborted' : 'connection');
    entry.failedHost = mediaHost(error?.cause?.host ?? error?.host);
    throw error;
  }
}

async function readHttpsAudio(url, options, standardFetch, chromiumFetch, attempts) {
  if (!chromiumFetch || !isKugouHost(new URL(url).hostname))
    return fetchAttempt(url, options, standardFetch, 'node', attempts);
  const attempt = new AbortController();
  const deadline = setTimeout(() => attempt.abort(), 8000);
  try {
    const signal = AbortSignal.any([options.signal, attempt.signal]);
    return await fetchAttempt(url, { ...options, signal }, chromiumFetch, 'chromium', attempts);
  } catch (error) {
    if (options.signal.aborted) throw error;
    // Only fall back on a connection exception. HTTP access denials remain authoritative.
    return await fetchAttempt(url, options, standardFetch, 'node', attempts);
  } finally { clearTimeout(deadline); }
}

async function readAudio(url, options, standardFetch, chromiumFetch, attempts, originalHttp) {
  try {
    return await readHttpsAudio(url, options, standardFetch, chromiumFetch, attempts);
  } catch (error) {
    const failed = attempts.at(-1);
    if (failed?.error === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      failed.httpFallback = options.signal.aborted ? 'cancelled' : !originalHttp ? 'no_original_http' :
        failed.failedHost !== failed.host ? 'hostname_mismatch' : 'attempted';
    }
    if (failed?.httpFallback !== 'attempted')
      throw error;
    // Use the original URL verbatim. An HTTP response may not redirect this request.
    return fetchAttempt(originalHttp, { ...options, credentials: 'omit', redirect: 'manual' },
      standardFetch, 'node', attempts);
  }
}

// 只为本次完整授权结果签发会话内随机凭据，客户端不能提交任意 URL。
/* mediaTickets()：只给完整允许播放的结果签发随机凭据；每个 ticket 绑定当前 session，1 小时有效，最多保存 512 项。
 * 返回给浏览器的是同源 URL，原平台地址保存在服务端 Map。 */
export function mediaTickets(session, result, cacheKey, cacheUntil = Infinity) {
  const { url: originalUrl, urls: playbackUrls, originalUrls = [], cacheOnly, ...safe } = result;
  if (result.state !== 'allowed' || result.playbackState !== 'allowed') return safe;
  session.media ??= new Map();
  if (cacheOnly && cacheKey) {
    const key = randomBytes(24).toString('hex');
    session.media.set(key, { cacheKey, expires: Math.min(Date.now() + 3600000, cacheUntil), protocols: [] });
    while (session.media.size > 512) session.media.delete(session.media.keys().next().value);
    return { ...safe, url: '/api/proxy?ticket=' + key, urls: ['/api/proxy?ticket=' + key], cacheHit: true };
  }
  const now = Date.now();
  for (const [key, value] of session.media)
    if (value.expires < now) session.media.delete(key);
  const netease = result.playbackSource?.provider === 'netease';
  const urls = [
    ...new Set(
      [originalUrl, ...(playbackUrls || [])].filter(
        (x) => typeof x === 'string' && isAudioHttpsUrl(x) && (!netease || isNeteaseMediaUrl(x)),
      ),
    ),
  ];
  const nativeHttps = new Set(originalUrls.filter((url) => URL.parse(url)?.protocol === 'https:'));
  // A native HTTPS candidate should get a chance before any protocol-upgraded candidate.
  const ordered = [...urls.filter((url) => nativeHttps.has(url)), ...urls.filter((url) => !nativeHttps.has(url))];
  const local = ordered.map((url) => {
    // Keep the platform addresses on the server and expose only their protocols.
    const offered = originalUrls.filter((raw) => raw.replace(/^http:/i, 'https:') === url);
    const protocols = [...new Set(offered.map((raw) => URL.parse(raw)?.protocol).filter(Boolean))];
    const key = randomBytes(24).toString('hex');
    const originalHttp = result.playbackSource?.provider === 'kugou' && !nativeHttps.has(url)
      ? offered.find(isOriginalKugouHttp)
      : undefined;
    session.media.set(key, { url, netease, protocols, originalUrls: offered, originalHttp, cacheKey,
      expires: Math.min(now + 60 * 60 * 1000, cacheUntil) });
    return '/api/proxy?ticket=' + key;
  });
  while (session.media.size > 512)
    session.media.delete(session.media.keys().next().value);
  return local.length ? { ...safe, url: local[0], urls: local } : {
    ...safe, state: 'unknown', playbackState: 'unknown', reason: '音源地址未通过网关校验',
  };
}
/* proxyAudio()：校验账号、ticket 与有效期，再以流转发音频；支持单段 bytes Range，便于拖动进度。
 * 客户端断开会中止上游请求；fetcher 可注入测试，不能从客户端直接提交任意 URL。 */
export async function proxyAudio(req, res, session, ticket, fetcher = fetchPublicAudio, kugouMediaFetch, audioCache) {
  const source = session.media?.get(ticket);
  if (!session.user || !source || source.expires < Date.now()) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '播放凭据失效，请重新播放' }));
    return;
  }
  const attempts = [];
  source.attempts = attempts;
  source.failure = undefined;
  const deadline = upstreamDeadline(res, 20000);
  try {
    if (audioCache && source.cacheKey && await audioCache.serve(req, res, source.cacheKey)) {
      source.attempts = [{ transport: 'disk', receivedAudio: true }]; return;
    }
    if (!source.url) { res.writeHead(502); res.end(); return; }
    /* 只支持单段 bytes 请求；原样转发合法 Range，并保留上游 Content-Range/Accept-Ranges。 */
    const range = req.headers.range;
    const requested = range && parseByteRange(range);
    if (range && !requested) {
      res.writeHead(416);
      res.end();
      return;
    }
    let address = source.url;
    let upstream;
    for (let redirects = 0; ; redirects++) {
      upstream = await readAudio(address, {
        headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
        signal: deadline.signal,
        redirect: 'manual',
        credentials: 'omit',
      }, fetcher, source.netease ? undefined : kugouMediaFetch, attempts,
        redirects === 0 ? source.originalHttp : undefined);
      if (!redirectStatuses.has(upstream.status)) break;
      const location = upstream.headers.get('location');
      await upstream.body?.cancel();
      const next = location && URL.parse(location, address);
      if (attempts.at(-1)?.protocol === 'http:' || redirects >= 2 ||
          !next || !validRedirect(address, next.href, source.netease)) {
        source.failure = { code: 'redirect' };
        res.writeHead(502);
        res.end();
        return;
      }
      address = next.href;
    }
    deadline.stop();
    const type = upstream.headers.get('content-type') ?? '';
    const encoding = upstream.headers.get('content-encoding');
    if (upstream.status === 416) {
      source.failure = { code: 'http', status: 416 };
      const contentRange = upstream.headers.get('content-range');
      await upstream.body?.cancel();
      res.writeHead(416, /^bytes \*\/\d{1,20}$/i.test(contentRange ?? '') ? { 'Content-Range': contentRange } : {});
      res.end();
      return;
    }
    if (![200, 206].includes(upstream.status) || !upstream.body ||
        (type && !validAudioType(type)) || (encoding && encoding.toLowerCase() !== 'identity') ||
        (upstream.status === 206 && !validPartialAudio(upstream.headers, requested))) {
      source.failure = upstream.ok ? { code: 'invalid_media' } : { code: 'http', status: upstream.status };
      await upstream.body?.cancel();
      res.writeHead(502);
      res.end();
      return;
    }
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, no-store',
    };
    for (const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    const stream = Readable.fromWeb(audioCache && source.cacheKey
      ? audioCache.capture(source.cacheKey, upstream.body, upstream.headers, upstream.status) : upstream.body);
    res.on('close', () => stream.destroy());
    const finalAttempt = attempts.at(-1);
    stream.once('data', (chunk) => { finalAttempt.receivedAudio = chunk.length > 0; });
    stream.on('error', () => {
      finalAttempt.streamError = !deadline.signal.aborted;
      if (finalAttempt.streamError && source.attempts === attempts) source.failure = { code: 'connection' };
      res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    if (source.attempts === attempts)
      source.failure = { code: deadline.signal.aborted ? 'timeout' : 'connection',
        detail: safeConnectionCode(error) };
    if (res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    } else res.destroy();
  } finally {
    deadline.stop();
  }
}

/* 自动检查：同源音频：会话 ticket、有效期、Range、流式响应及账号隔离。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { checkServerIdentity } from 'node:tls';
import { mediaTickets, proxyAudio } from '../lib/media-proxy.mjs';
test('只有完整授权结果签发同源音频凭据，凭据不跨账号复用', async () => {
  const a = { user: {} },
    b = { user: {} },
    unknown = { state: 'unknown', url: 'https://example.com/a' };
  assert.deepEqual(mediaTickets(a, unknown), { state: 'unknown' });
  const result = mediaTickets(a, {
    state: 'allowed',
    playbackState: 'allowed',
    url: 'https://example.com/a',
    urls: ['https://example.com/a'],
    originalUrls: ['http://example.com/a'],
  });
  assert.equal(result.urls.length, 1);
  assert.equal(result.originalUrls, undefined);
  assert.match(result.url, /^\/api\/proxy\?ticket=[a-f0-9]{48}$/);
  const key = result.url.split('=')[1];
  assert.equal(a.media.get(key).url, 'https://example.com/a');
  assert.deepEqual(a.media.get(key).protocols, ['http:']);
  assert.deepEqual(a.media.get(key).originalUrls, ['http://example.com/a']);
  assert.equal(b.media, undefined);
  let fetched = false;
  const res = {
    writeHead(code) {
      this.code = code;
    },
    end() {},
  };
  await proxyAudio({ headers: {} }, res, b, key, () => {
    fetched = true;
  });
  assert.equal(res.code, 403);
  assert.equal(fetched, false);
});
test('音频转发支持 Range、流式输出和过期拒绝，不接收客户端 URL', async () => {
  const s = { user: {} };
  const { url } = mediaTickets(s, {
    state: 'allowed',
    playbackState: 'allowed',
    url: 'https://example.com/song',
  });
  const key = url.split('=')[1],
    parts = [];
  const res = new Writable({
    write(chunk, _, next) {
      parts.push(chunk);
      next();
    },
  });
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  let request;
  const done = once(res, 'finish');
  await proxyAudio(
    { headers: { range: 'bytes=2-5' } },
    res,
    s,
    key,
    async (address, options) => {
      request = { address, options };
      return new Response('abcd', {
        status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 2-5/10' },
      });
    },
  );
  await done;
  assert.equal(request.options.headers.Range, 'bytes=2-5');
  assert.equal(res.status, 206);
  assert.equal(Buffer.concat(parts).toString(), 'abcd');
  assert.equal(res.headers['content-range'], 'bytes 2-5/10');
  s.media.get(key).expires = 0;
  const expired = {
    writeHead(code) {
      this.code = code;
    },
    end() {},
  };
  await proxyAudio({ headers: {} }, expired, s, key);
  assert.equal(expired.code, 403);
});

test('网易云转发跟随受信 CDN 跳转，拒绝跳往本机并记录脱敏错误', async () => {
  const session = { user: {} };
  const { url } = mediaTickets(session, { state: 'allowed', playbackState: 'allowed',
    playbackSource: { provider: 'netease' }, url: 'https://m10.music.126.net/one' });
  const key = url.split('=')[1];
  const requests = [];
  const res = { on() {}, end() {}, writeHead(code) { this.code = code; } };
  await proxyAudio({ headers: { range: 'bytes=0-511' } }, res, session, key, async (address, opts) => {
    requests.push(address);
    assert.equal(opts.redirect, 'manual');
    assert.equal(opts.headers.Range, 'bytes=0-511');
    const target = requests.length === 1 ? 'https://m11.music.126.net/two' : 'http://127.0.0.1/private';
    return new Response(null, { status: 302, headers: { location: target } });
  });
  assert.deepEqual(requests, ['https://m10.music.126.net/one','https://m11.music.126.net/two']);
  assert.equal(res.code, 502);
  assert.deepEqual(session.media.get(key).failure, { code: 'redirect' });
});

test('桌面酷狗连接异常才切换传输通道，HTTP 拒绝不重试', async () => {
  for (const denied of [false, true]) {
    const session = { user: {} };
    const { url } = mediaTickets(session, { state: 'allowed', playbackState: 'allowed',
      playbackSource: { provider: 'kugou' }, url: 'https://fs.youthandroid.kugou.com/signed' });
    const ticket = url.split('=')[1];
    const calls = [];
    const res = { on() {}, end() {}, writeHead(status) { this.status = status; } };
    await proxyAudio({ headers: { range: 'bytes=0-511' } }, res, session, ticket,
      async (_, options) => {
        calls.push('node');
        assert.equal(options.headers.Range, 'bytes=0-511');
        throw Object.assign(new TypeError('url and credentials should stay private'), { cause: { code: 'ECONNRESET' } });
      },
      async (_, options) => {
        calls.push('chromium');
        assert.equal(options.headers.Range, 'bytes=0-511');
        if (denied) return new Response(null, { status: 403 });
        throw new Error('net::ERR_CONNECTION_CLOSED');
      });
    assert.equal(res.status, 502);
    assert.deepEqual(calls, denied ? ['chromium'] : ['chromium', 'node']);
    assert.deepEqual(session.media.get(ticket).attempts.map(({ transport, host, status, error }) => ({
      transport, host, result: status ?? error,
    })), denied
      ? [{ transport: 'chromium', host: 'fs.youthandroid.kugou.com', result: 403 }]
      : [
          { transport: 'chromium', host: 'fs.youthandroid.kugou.com', result: 'ERR_CONNECTION_CLOSED' },
          { transport: 'node', host: 'fs.youthandroid.kugou.com', result: 'ECONNRESET' },
        ]);
    assert.deepEqual(session.media.get(ticket).failure, denied
      ? { code: 'http', status: 403 } : { code: 'connection', detail: 'ECONNRESET' });
  }
});

test('酷狗证书域名不符时用平台原发的 HTTP 地址转发 Range', async () => {
  for (const desktop of [false, true]) {
    const host = 'fs.youthandroid2.kugou.com';
    const original = 'http://' + host + '/song?signature=example';
    const upgraded = original.replace(/^http:/, 'https:');
    const session = { user: {} };
    const { url } = mediaTickets(session, {
      state: 'allowed', playbackState: 'allowed', playbackSource: { provider: 'kugou' },
      url: upgraded, originalUrls: [original],
    });
    const key = url.split('=')[1];
    const chunks = [];
    const res = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    const finished = once(res, 'finish');
    const requests = [];
    await proxyAudio({ headers: { range: 'bytes=8-11', cookie: 'secret' } }, res, session, key,
      async (address, options) => {
        requests.push(address);
        assert.equal(options.headers.Range, 'bytes=8-11');
        if (address === upgraded) {
          const error = checkServerIdentity(host, { subjectaltname: 'DNS:other.kugou.com' });
          throw desktop ? error : new TypeError('fetch failed', { cause: error });
        }
        assert.equal(address, original);
        assert.equal(options.redirect, 'manual');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers.cookie, undefined);
        return new Response('mp3!', { status: 206, headers: {
          'content-type': 'audio/mpeg', 'content-range': 'bytes 8-11/100',
        } });
      },
      desktop ? async () => { throw new Error('net::ERR_CERT_COMMON_NAME_INVALID'); } : undefined);
    await finished;
    assert.deepEqual(requests, [upgraded, original]);
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 8-11/100');
    assert.equal(Buffer.concat(chunks).toString(), 'mp3!');
    const { attempts } = session.media.get(key);
    assert.equal(attempts.at(-1).protocol, 'http:');
    assert.equal(attempts.at(-1).receivedAudio, true);
    assert.equal(attempts.at(-2).httpFallback, 'attempted');
    assert.doesNotMatch(JSON.stringify(attempts), /signature=/);
  }
});

test('仅对已核实的原发酷狗 HTTP 音源兼容，且拒绝 HTTP 跳转', async () => {
  const host = 'fs.youthandroid.kugou.com';
  const base = 'http://' + host + '/song';
  const cases = [
    { original: base, denied: true },
    { original: base, failedHost: 'different.example' },
    { original: base, code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    { original: base.replace(host, 'unlisted.kugou.com') },
    { original: base.replace('http:', 'https:') },
    { original: base, redirect: true },
  ];
  for (const { original, failedHost = host, code = 'ERR_TLS_CERT_ALTNAME_INVALID', denied, redirect } of cases) {
    const session = { user: {} };
    const upgraded = original.replace(/^http:/, 'https:');
    const { url } = mediaTickets(session, {
      state: 'allowed', playbackState: 'allowed', playbackSource: { provider: 'kugou' },
      url: upgraded, originalUrls: [original],
    });
    const requests = [];
    const res = { on() {}, end() {}, writeHead(status) { this.status = status; } };
    await proxyAudio({ headers: {} }, res, session, url.split('=')[1], async (address, options) => {
      requests.push(address);
      if (denied) return new Response(null, { status: 403 });
      if (address === upgraded) throw new TypeError('fetch failed', { cause: { code, host: failedHost } });
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    });
    assert.equal(res.status, 502);
    assert.deepEqual(requests, redirect ? [upgraded, original] : [upgraded]);
  }
});

test('音频票据拒绝 IP、内网名称、非默认端口与 URL 凭据', () => {
  for (const url of [
    'https://127.0.0.1/audio', 'https://[::1]/audio', 'https://cdn.internal/audio',
    'https://fs.youthandroid.kugou.com:8000/audio', 'https://user:pass@example.com/audio',
  ]) {
    const session = { user: {} };
    const result = mediaTickets(session, { state: 'allowed', playbackState: 'allowed', url });
    assert.equal(result.url, undefined);
    assert.equal(result.playbackState, 'unknown');
    assert.equal(session.media.size, 0);
  }
});

test('酷狗逐跳验证 HTTPS 地址，允许同域跳转并阻止跨站与降级', async () => {
  const session = { user: {} };
  const { url } = mediaTickets(session, { state: 'allowed', playbackState: 'allowed',
    playbackSource: { provider: 'kugou' }, url: 'https://fs.youthandroid.kugou.com/one' });
  const ticket = url.split('=')[1];
  for (const blocked of ['https://[::1]/hidden', 'http://fs.youthandroid.kugou.com/three',
    'https://fs.youthandroid.kugou.com.attacker.com/three', 'file:///C:/secret.txt']) {
    const seen = [];
    const res = { on() {}, end() {}, writeHead(status) { this.status = status; } };
    await proxyAudio({ headers: { cookie: 'private' } }, res, session, ticket, async (address, options) => {
      seen.push(address);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.cookie, undefined);
      return new Response(null, { status: 302, headers: { location: seen.length === 1 ? '/two' : blocked } });
    });
    assert.deepEqual(seen, ['https://fs.youthandroid.kugou.com/one', 'https://fs.youthandroid.kugou.com/two']);
    assert.equal(res.status, 502);
    assert.deepEqual(session.media.get(ticket).failure, { code: 'redirect' });
  }
});

test('拒绝错误范围和假音频响应；上游 416 不转发错误页正文', async () => {
  const session = { user: {} };
  const { url } = mediaTickets(session, { state: 'allowed', playbackState: 'allowed',
    url: 'https://audio.example.com/song' });
  const ticket = url.split('=')[1];
  for (const range of ['bytes=-', 'bytes=10-2', 'bytes=-0', 'bytes=0-1,4-8']) {
    const res = { on() {}, end() {}, writeHead(status) { this.status = status; } };
    await proxyAudio({ headers: { range } }, res, session, ticket, async () => assert.fail('发出了非法 Range'));
    assert.equal(res.status, 416);
    assert.equal(session.media.get(ticket).attempts.length, 0);
  }
  for (const response of [
    new Response('abcd', { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 3-6/10' } }),
    new Response('abcd', { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 2-5/10', 'Content-Length': '9' } }),
    new Response('abcd', { status: 206, headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response('<svg />', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/problem+json' } }),
  ]) {
    const res = { on() {}, end() {}, writeHead(status) { this.status = status; } };
    await proxyAudio({ headers: { range: 'bytes=2-5' } }, res, session, ticket, async () => response);
    assert.equal(res.status, 502);
    assert.deepEqual(session.media.get(ticket).failure, { code: 'invalid_media' });
  }
  const res = { on() {}, end(body) { assert.equal(body, undefined); },
    writeHead(status, headers) { this.status = status; this.headers = headers; } };
  await proxyAudio({ headers: { range: 'bytes=100-200' } }, res, session, ticket, async () =>
    new Response('<html>outside range</html>', { status: 416, headers: { 'Content-Range': 'bytes */10' } }));
  assert.equal(res.status, 416);
  assert.deepEqual(res.headers, { 'Content-Range': 'bytes */10' });
});

test('原生 HTTPS 备选优先于从 HTTP 升级的候选', () => {
  const original = 'http://fs.youthandroid.kugou.com/song';
  const upgraded = original.replace(/^http:/, 'https:');
  const backup = 'https://example.com/backup';
  const session = { user: {} };
  const { urls } = mediaTickets(session, {
    state: 'allowed', playbackState: 'allowed', playbackSource: { provider: 'kugou' },
    url: upgraded, urls: [upgraded, backup], originalUrls: [original, backup],
  });
  assert.deepEqual(urls.map((ticket) => session.media.get(ticket.split('=')[1]).url), [backup, upgraded]);
});

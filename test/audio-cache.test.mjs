import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createAudioCache, cacheKey } from '../lib/audio-cache.mjs';
import { createMusicServer } from '../server.mjs';
import { proxyAudio } from '../lib/media-proxy.mjs';

const headers = size => new Headers({ 'content-length': String(size), 'content-type': 'audio/wav' });
const body = value => new Response(value).body;
const consume = stream => new Response(stream).arrayBuffer();
const store = (cache, key, value) => consume(cache.capture(key, body(value), headers(Buffer.byteLength(value)), 200));

test('磁盘缓存完整提交、持久化、LRU、过期及开关持久化', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'higher-cache-')); let time = 100;
  let cache = createAudioCache(root, { maxBytes: 8, ttlMs: 100, now: () => time });
  try {
    await store(cache, 'a', 'aaaa'); time++; await store(cache, 'b', 'bbbb');
    time++; assert.equal(await cache.has('a'), true); time++; await store(cache, 'c', 'cccc');
    assert.equal(await cache.has('b'), false); assert.equal(cache.stats().bytes, 8);
    cache.close(); cache = createAudioCache(root, { maxBytes: 8, ttlMs: 100, now: () => time });
    assert.equal(await cache.has('a'), true); cache.setEnabled(false); cache.close();
    cache = createAudioCache(root, { maxBytes: 8, ttlMs: 100, now: () => time });
    assert.equal(cache.stats().enabled, false); assert.equal(await cache.has('a'), false);
    cache.setEnabled(true); time += 101; assert.equal(await cache.has('a'), false);
    assert.equal(cache.stats().count, 0);
  } finally { cache.close(); await rm(root, { recursive: true, force: true }); }
});

test('片段、缺少长度、超限、错误类型不入库；清空阻止在途写入，取消与异常留下零半成品', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'higher-cache-part-'));
  const cache = createAudioCache(root, { maxFileBytes: 10 });
  try {
    const partial = headers(4); partial.set('content-range', 'bytes 4-7/8');
    await consume(cache.capture('partial', body('aaaa'), partial, 206));
    await consume(cache.capture('missing', body('aaaa'), new Headers({ 'content-type': 'audio/wav' }), 200));
    await store(cache, 'large', 'a'.repeat(11));
    const html = headers(4); html.set('content-type', 'text/html');
    await consume(cache.capture('html', body('html'), html, 200));
    const cleared = cache.capture('cleared', body('aaaa'), headers(4), 200); cache.clear(); await consume(cleared);
    await consume(cache.capture('short', body('aa'), headers(4), 200));
    const broken = Readable.toWeb(Readable.from((async function* () { yield Buffer.from('aa'); throw new Error('broken'); })()));
    await assert.rejects(consume(cache.capture('broken', broken, headers(4), 200)));
    const stream = cache.capture('cancel', body('aaaa'), headers(4), 200);
    const reader = stream.getReader(); await reader.read(); await reader.cancel();
    assert.equal(cache.stats().count, 0);
    assert.deepEqual((await readdir(root)).filter(name => /\.(bin|part)$/.test(name)), []);
    const full = headers(4); full.set('content-range', 'bytes 0-3/4');
    await consume(cache.capture('full206', body('aaaa'), full, 206));
    assert.equal(await cache.has('full206'), true);
    const file = (await readdir(root)).find(name => name.endsWith('.bin'));
    await writeFile(path.join(root, file), 'changed');
    assert.equal(await cache.has('full206'), false);
  } finally { cache.close(); await rm(root, { recursive: true, force: true }); }
});

test('缓存标识隔离账号、录音和音质；短期授权不跨会话、不续期', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'higher-cache-auth-')); let time = 100;
  const cache = createAudioCache(root, { now: () => time });
  try {
    const session = { user: {}, jar: { userid: 'a' } }, track = { id: 'song', hash: 'a', duration: 60 };
    const result = { state: 'allowed', playbackState: 'allowed', quality: '128k', playbackSource: { provider: 'kugou' } };
    const key = cacheKey(session, track, result);
    assert.notEqual(key, cacheKey({ jar: { userid: 'b' } }, track, result));
    assert.notEqual(key, cacheKey(session, { ...track, hash: 'b' }, result));
    assert.notEqual(key, cacheKey(session, track, { ...result, quality: 'flac' }));
    await store(cache, key, 'aaaa'); cache.remember(session, track, key, result);
    assert.ok(await cache.granted(session, track));
    assert.equal(await cache.granted({ user: {}, jar: session.jar }, track), null);
    time += 3600001; assert.equal(await cache.granted(session, track), null);
    cache.reject(session, track); assert.equal(await cache.has(key), false);
  } finally { cache.close(); await rm(root, { recursive: true, force: true }); }
});

test('HTTP：完整缓存后断网重播、Range、会话隔离、禁用/清空；不重复取源', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'higher-cache-http-'));
  const cache = createAudioCache(root); let checks = 0, downloads = 0, offline = false;
  const track = { id: 'song', title: 'Fixture', artist: 'Artist', duration: 30, hash: 'a'.repeat(32) };
  const server = createMusicServer({ audioCache: cache, audioPrefetch: false,
    request: async (_, method) => ({ data: {
      login_qr_key: { key: 'fixture' }, login_qr_create: {},
      login_qr_check: { status: 4, userid: 'a', token: 'fixture' },
    }[method] }),
    sources: { search: async () => ({ tracks: [track] }), fallback: async () => null },
    adapters: async () => ({ checkAccess: async () => { checks++; if (offline) throw new Error('offline');
      return { state: 'allowed', playbackState: 'allowed', url: 'https://audio.example.com/song', expectedDuration: 30 }; } }),
    audioProxy: (req, res, s, ticket, _, kg, storage) => proxyAudio(req, res, s, ticket, async () => {
      downloads++; if (offline) throw new Error('offline');
      return new Response('abcdefgh', { headers: headers(8) });
    }, kg, storage),
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const initial = await fetch(base + '/api/session'); const cookie = initial.headers.get('set-cookie').split(';')[0];
    const send = (route, method = 'GET', extra = {}) => fetch(base + route, { method, headers: { Cookie: cookie, ...extra } });
    await send('/api/login', 'POST'); await send('/api/login/status'); await send('/api/search?q=Fixture');
    const first = await (await send('/api/play?track=song', 'POST')).json();
    assert.equal(await (await send(first.url)).text(), 'abcdefgh');
    for (let n = 0; n < 50 && !cache.stats().count; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cache.stats().count, 1); offline = true;
    const second = await (await send('/api/play?track=song', 'POST')).json();
    assert.equal(second.cacheHit, true); assert.equal(checks, 1);
    const range = await send(second.url, 'GET', { Range: 'bytes=2-4' });
    assert.equal(range.status, 206); assert.equal(range.headers.get('x-higher-cache'), 'hit'); assert.equal(await range.text(), 'cde');
    assert.equal((await send(second.url, 'GET', { Range: 'bytes=99-' })).status, 416);
    assert.equal((await fetch(base + second.url)).status, 404); assert.equal(downloads, 1);
    cache.setEnabled(false); assert.equal((await send(second.url)).status, 502);
    cache.setEnabled(true); cache.clear(); assert.equal(cache.stats().count, 0);
    assert.equal((await send(second.url)).status, 502);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    cache.close(); await rm(root, { recursive: true, force: true });
  }
});

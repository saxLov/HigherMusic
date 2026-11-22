import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { publicLookup } from '../lib/gateway/network.mjs';
import { createPreview } from '../scripts/preview.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64');
const track = (id, cover) => ({ id, provider: 'netease', title: id, cover });

test('封面 HTTP 票据绑定会话并校验跳转、大小与图片签名', async () => {
  const addresses = [];
  const { server } = createPreview({
    sources: { search: async () => ({ tracks: [
      track('good', 'http://imge.kugou.com/{size}/good.png'),
      track('redirect', 'https://p1.music.126.net/redirect'),
      track('fake', 'https://p1.music.126.net/fake'),
      track('large', 'https://p1.music.126.net/large'),
      track('private', 'https://127.0.0.1/private'),
    ] }) },
    artworkFetch: async (url) => {
      addresses.push(url.href);
      switch (url.pathname) {
        case '/redirect':
          return Object.assign(Readable.from([]), {
            statusCode: 302, headers: { location: 'https://127.0.0.1/private' },
          });
        case '/large':
          return Object.assign(Readable.from([]), {
            statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': '9000000' },
          });
        default:
          return Object.assign(Readable.from([url.pathname === '/fake' ? Buffer.from('<html>') : png]), {
            statusCode: 200, headers: { 'content-type': 'image/png' },
          });
      }
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, cookie, method = 'GET') =>
    fetch(base + path, { method, headers: cookie ? { Cookie: cookie } : {} });
  try {
    const start = await send('/');
    assert.match(start.headers.get('content-security-policy'), /img-src 'self' data:;/);
    await start.text();
    const cookie = (await send('/api/session')).headers.get('set-cookie').split(';')[0];
    await send('/api/login', cookie, 'POST');
    await send('/api/login/status', cookie);
    const search = await send('/api/search?q=cover', cookie);
    const { tracks: [good, redirect, fake, large, privateCover] } = await search.json();
    assert.match(good.cover, /^\/api\/proxy\?ticket=[a-f0-9]{64}$/);
    assert.equal(privateCover.cover, '');
    assert.equal((await send(good.cover)).status, 404);
    assert.equal((await send('/api/artwork?url=https://imge.kugou.com/500/good.png', cookie)).status, 404);
    assert.deepEqual(addresses, []);
    const image = await send(good.cover, cookie);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await send(good.cover, cookie)).status, 200);
    assert.deepEqual(addresses, ['https://imge.kugou.com/500/good.png']);
    for (const item of [redirect, fake, large])
      assert.equal((await send(item.cover, cookie)).status, 502);
    assert.equal(addresses.length, 4);
    await send('/api/logout', cookie, 'POST');
    assert.equal((await send(good.cover, cookie)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('封面网关拒绝 DNS 解析出的 IPv4 与 IPv6 回环地址', async () => {
  await assert.rejects(new Promise((resolve, reject) => {
    publicLookup('localhost', { all: true }, (error, records) =>
      error ? reject(error) : resolve(records));
  }), /no public address/);
});

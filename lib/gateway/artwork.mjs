import { createHmac, randomBytes } from 'node:crypto';
import { publicLookup } from './network.mjs';
import { get } from 'node:https';
import { coverUrl } from '../gallery.mjs';
import { upstreamDeadline } from './transport.mjs';

const coverHost = /^(?:imge?\.kugou\.com|imgessl\.kugou\.com|p\d+c?\.music\.126\.net)$/;
const limit = 8 * 1024 * 1024;
const redirects = new Set([301, 302, 303, 307, 308]);
function validCover(value) {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && !url.port &&
    !url.hash && coverHost.test(url.hostname) ? url : null;
}

function fetchCover(url, signal) {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, lookup: publicLookup, signal, rejectUnauthorized: true,
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif', 'Accept-Encoding': 'identity' },
    }, resolve);
    request.once('error', reject);
  });
}

function matchesImage(type, bytes) {
  switch (type) {
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/gif': return /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
    case 'image/webp': return bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP';
    default: return false;
  }
}

export function createArtworkGateway(fetchImage = fetchCover) {
  const secret = randomBytes(32);
  let active = 0;
  let cachedBytes = 0;
  const cache = new Map();

  function issue(session, raw) {
    if (typeof raw !== 'string' || raw.length > 4096) return '';
    const url = validCover(coverUrl(raw));
    if (!url) return '';
    session.artworkKey ??= randomBytes(32);
    session.artwork ??= new Map();
    const ticket = createHmac('sha256', secret).update(session.artworkKey).update(url.href).digest('hex');
    session.artwork.delete(ticket);
    session.artwork.set(ticket, url.href);
    while (session.artwork.size > 16384) session.artwork.delete(session.artwork.keys().next().value);
    return '/api/proxy?ticket=' + ticket;
  }

  async function serve(res, session, ticket) {
    const address = session.user && session.artwork?.get(ticket);
    if (!address) { res.writeHead(404).end(); return; }
    const cached = cache.get(address);
    if (cached && Date.now() < cached.until) {
      cache.delete(address);
      cache.set(address, cached);
      res.writeHead(200, { 'Content-Type': cached.type, 'Content-Length': cached.bytes.length }).end(cached.bytes);
      return;
    }
    if (active >= 8) { res.writeHead(503).end(); return; }
    active++;
    const deadline = upstreamDeadline(res, 10000);
    let upstream;
    try {
      let url = validCover(address);
      for (let hop = 0; ; hop++) {
        upstream = await fetchImage(url, deadline.signal);
        if (!redirects.has(upstream.statusCode)) break;
        const next = upstream.headers.location && URL.parse(upstream.headers.location, url);
        upstream.destroy();
        url = next && validCover(next.href);
        if (!url || hop >= 2) throw new Error('Cover redirect rejected');
      }
      const type = upstream.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const encoding = upstream.headers['content-encoding'];
      if (upstream.statusCode !== 200 || (encoding && encoding !== 'identity') ||
          Number(upstream.headers['content-length']) > limit)
        throw new Error('Invalid cover response');
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream) {
        size += chunk.length;
        if (size > limit) throw new Error('Cover exceeds size limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (!matchesImage(type, bytes)) throw new Error('Invalid cover signature');
      const previous = cache.get(address);
      if (previous) cachedBytes -= previous.bytes.length;
      cache.delete(address);
      cache.set(address, { bytes, type, until: Date.now() + 15 * 60 * 1000 });
      cachedBytes += size;
      while (cache.size > 48 || cachedBytes > 16 * 1024 * 1024) {
        const first = cache.keys().next().value;
        cachedBytes -= cache.get(first).bytes.length;
        cache.delete(first);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size }).end(bytes);
    } catch {
      upstream?.destroy();
      if (!res.destroyed) res.writeHead(502).end();
    } finally {
      deadline.stop();
      active--;
    }
  }
  return { issue, serve };
}

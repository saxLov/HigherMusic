import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { Readable } from 'node:stream';
import { isPublicHostname, publicLookup } from './network.mjs';

export const isKugouHost = hostname => hostname.endsWith('.kugou.com');

export function isAudioHttpsUrl(value) {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && !url.port &&
    !url.hash && isPublicHostname(url.hostname);
}

export function fetchPublicAudio(address, { headers, signal }) {
  const url = new URL(address);
  if (!['https:', 'http:'].includes(url.protocol) || !isPublicHostname(url.hostname) ||
      url.username || url.password || url.port || url.hash)
    return Promise.reject(new Error('Invalid audio CDN URL'));
  const get = url.protocol === 'https:' ? getHttps : getHttp;
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, lookup: publicLookup, headers: { 'User-Agent': 'node', ...headers }, signal,
      rejectUnauthorized: true,
    }, (incoming) => {
      try {
        resolve({
          url: address,
          status: incoming.statusCode,
          ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
          headers: new Headers(incoming.headers),
          body: Readable.toWeb(incoming, {
            strategy: { highWaterMark: incoming.readableHighWaterMark, size: chunk => chunk.byteLength },
          }),
        });
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
  });
}

export function parseByteRange(value) {
  const match = /^bytes=(\d{0,20})-(\d{0,20})$/i.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? BigInt(match[1]) : null;
  const end = match[2] ? BigInt(match[2]) : null;
  if (start === null ? end === 0n : end !== null && end < start) return null;
  return { start, end };
}

export function validPartialAudio(headers, requested) {
  const match = /^bytes (\d{1,20})-(\d{1,20})\/(\d{1,20}|\*)$/i.exec(headers.get('content-range') ?? '');
  if (!requested || !match) return false;
  const start = BigInt(match[1]), end = BigInt(match[2]);
  const total = match[3] === '*' ? null : BigInt(match[3]);
  if (end < start || (total !== null && end >= total)) return false;
  const length = headers.get('content-length');
  if (length !== null && (!/^\d{1,20}$/.test(length) || BigInt(length) !== end - start + 1n)) return false;
  if (requested.start === null)
    return total !== null && end === total - 1n && start === (total > requested.end ? total - requested.end : 0n);
  return start === requested.start && (requested.end === null || end <= requested.end);
}

export function validAudioType(type) {
  return /^(?:audio\/[a-z0-9!#$&^_.+-]+|(?:application|binary)\/octet-stream|application\/(?:ogg|mp4|force-download)|video\/mp4)(?:\s*;|$)/i.test(type.trim());
}

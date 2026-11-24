import { createRequire } from 'node:module';
import { evaluatePlayback } from '../rights.mjs';
import { coverUrl } from '../gallery.mjs';
import { readPlatformJson } from '../gateway/json.mjs';

const require = createRequire(import.meta.url);
const origin = 'https://music.163.com';
const allowedFee = (fee) => fee === 0 || fee === 8;

export function isNeteaseMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /^(?:[a-z0-9-]+\.)+(?:music\.126\.net|music\.163\.com)$/.test(url.hostname);
  } catch { return false; }
}

async function request(endpoint, data, { signal } = {}) {
  const { weapi } = require('@neteasecloudmusicapienhanced/api/util/crypto.js');
  const body = await readPlatformJson(origin + '/weapi/' + endpoint, {
    method: 'POST',
    body: new URLSearchParams(weapi({ ...data, csrf_token: '' })),
    headers: { Referer: origin + '/' },
    signal,
  }, { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024 });
  if (body?.code !== 200)
    throw Object.assign(new Error('网易云暂未接受请求'), { platformCode: Number(body?.code) });
  return body;
}

function trackFrom(row) {
  const sourceId = String(row.id ?? '');
  const title = String(row.name ?? '').trim().slice(0, 300);
  if (!/^\d{1,16}$/.test(sourceId) || !title) return null;
  return {
    provider: 'netease', sourceId, id: 'netease:' + sourceId, title,
    artist: (row.ar ?? row.artists ?? []).map((x) => x.name).filter(Boolean).join(' / ').slice(0, 300),
    album: String(row.al?.name ?? row.album?.name ?? '').slice(0, 300),
    cover: coverUrl(row.al?.picUrl, row.album?.picUrl),
    duration: Number(row.dt ?? row.duration) / 1000 || 0,
    version: (Array.isArray(row.alia) ? row.alia : []).join(' ').slice(0, 300),
    isCover: row.originCoverType === 2,
  };
}

export function createNeteaseSource(send = request) {
  return {
    id: 'netease',
    name: '网易云',
    async search(_session, keywords) {
      const body = await send('search/get', { s: keywords, type: 1, limit: 20, offset: 0 });
      if (body.result?.songCount === 0 || Object.keys(body.result ?? {}).length === 0) return [];
      if (!Array.isArray(body.result?.songs)) throw new Error('网易云搜索格式异常');
      return body.result.songs.slice(0, 20).map(trackFrom).filter(Boolean);
    },
    async detail(track, { signal } = {}) {
      const body = await send('v3/song/detail', { c: JSON.stringify([{ id: Number(track.sourceId) }]) }, { signal });
      const row = body.songs?.find((x) => String(x.id) === track.sourceId);
      const privilege = body.privileges?.find((x) => String(x.id) === track.sourceId);
      if (!row || !allowedFee(row.fee) || !privilege || !Number.isFinite(privilege.st) || privilege.st < 0 ||
          (privilege.fee != null && !allowedFee(privilege.fee)) || row.resourceState === false) return null;
      return trackFrom(row);
    },
    async resolve(track, { standardOnly = false, signal } = {}) {
      for (const br of standardOnly ? [128000] : [999000, 320000, 128000]) {
        signal?.throwIfAborted();
        const body = await send('song/enhance/player/url', { ids: JSON.stringify([track.sourceId]), br }, { signal });
        const row = body.data?.find((x) => String(x.id) === track.sourceId);
        if (!row || row.code !== 200 || !allowedFee(row.fee) || row.freeTrialInfo != null ||
            row.freeTrialPrivilege?.resConsumable === true || row.freeTrialPrivilege?.userConsumable === true)
          continue;
        const url = typeof row.url === 'string' ? row.url.replace(/^http:/i, 'https:') : '';
        if (!isNeteaseMediaUrl(url) || !(row.time > 0) || !(track.duration > 0) ||
            Math.abs(row.time / 1000 - track.duration) > 3) continue;
        const media = evaluatePlayback({ url, timeLength: row.time / 1000 }, track);
        if (media.state !== 'allowed') continue;
        const quality = String(row.type).toLowerCase() === 'flac' ? 'FLAC'
          : Number(row.br) > 0 ? Math.round(row.br / 1000) + 'k' : undefined;
        return { ...media, quality };
      }
      return null;
    },
    async lyrics(track, options) {
      const body = await send('song/lyric', { id: track.sourceId, lv: -1, tv: -1 }, options);
      return typeof body.lrc?.lyric === 'string' ? body.lrc.lyric.slice(0, 100000) : '';
    },
  };
}


// Public recording metadata is separate from account entitlement evidence.
const id = v => v == null || ['', '0'].includes(String(v).trim()) ? '' : String(v).trim();
export const sameRecordingId = (a, b) => !id(a) || !id(b) || id(a) === id(b);
const hash = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
export function matchingResource(body, track) {
  return (Array.isArray(body?.data) ? body.data : []).find(row => row && hash(row.hash) === hash(track.hash) &&
    sameRecordingId(track.albumId, row.album_id) && sameRecordingId(track.albumAudioId, row.album_audio_id));
}
export function instrumentalMetadata(value) {
  return value?.instrumental === true ||
    /^(?:纯音乐|instrumental)$/iu.test(String(value?.trans_param?.language ?? value?.language ?? '').trim());
}
export function recordingMetadata(track, resource) {
  if (!resource || matchingResource({ data: [resource] }, track) !== resource) return null;
  const related = (Array.isArray(resource.relate_goods) ? resource.relate_goods : []).filter(row =>
    row && String(row.quality) === '128' && sameRecordingId(track.albumId, row.album_id) &&
    sameRecordingId(track.albumAudioId, row.album_audio_id) &&
    (!(track.duration > 0 && row.info?.duration > 0) || Math.abs(row.info.duration / 1000 - track.duration) <= 3));
  const hashes = [resource.hash, ...related.map(row => row.hash)];
  // OGG is a file encoding of this resource, not another album or performance.
  if (!(track.duration > 0 && resource.info?.duration > 0) ||
      Math.abs(resource.info.duration / 1000 - track.duration) <= 3) hashes.push(resource.trans_param?.ogg_128_hash);
  return { hashes: [...new Set(hashes.map(hash).filter(Boolean))], instrumental: instrumentalMetadata(resource) };
}
const caches = new WeakMap();
function cache(session) {
  let value = caches.get(session);
  if (!value || value.revision !== session.sourceRevision || value.token !== session.jar?.token || value.userid !== session.jar?.userid) {
    value = { revision: session.sourceRevision, token: session.jar?.token, userid: session.jar?.userid, rows: new Map() };
    caches.set(session, value);
  }
  return value.rows;
}
const key = track => JSON.stringify([hash(track.hash), id(track.albumId), id(track.albumAudioId), track.duration]);
export function cachedRecordingMetadata(session, track) {
  const entry = cache(session).get(key(track));
  return entry && Date.now() < entry.until ? entry.value : null;
}
export function rememberRecordingMetadata(session, track, resource) {
  const value = recordingMetadata(track, resource);
  if (value) {
    const rows = cache(session);
    rows.set(key(track), { value, until: Date.now() + 30 * 60 * 1000 });
    while (rows.size > 128) rows.delete(rows.keys().next().value);
  }
  return value;
}
export async function readRecordingMetadata(session, track, request, signal) {
  signal?.throwIfAborted();
  const rows = cache(session), cached = cachedRecordingMetadata(session, track);
  if (cached) return cached;
  if (!track.hash) return null;
  const body = await request(session, 'privilege_lite', { hash: track.hash,
    album_id: track.albumId, album_audio_id: track.albumAudioId, qualities: '128' }, { signal });
  signal?.throwIfAborted();
  const resource = matchingResource(body, track);
  // An old request must not repopulate metadata after an explicit refresh/logout.
  return cache(session) === rows ? rememberRecordingMetadata(session, track, resource) : recordingMetadata(track, resource);
}

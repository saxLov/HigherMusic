import { createHash, randomUUID } from 'node:crypto';
import { createSqliteLibrary } from './sqlite-library.mjs';
import { keepPurchaseEvidence } from '../public/track-state.mjs';

export class LibraryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const empty = () => ({ lists: [], checks: new Map(), history: new Map(), snapshots: new Map() });
const nameOf = (value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80) throw new LibraryError('歌单名称需要 1–80 个字');
  return name;
};
const metadata = (track) => Object.fromEntries(
  ['id', 'provider', 'sourceId', 'hash', 'albumId', 'albumAudioId', 'audioId', 'title',
    'artist', 'album', 'cover', 'duration', 'version', 'isCover', 'instrumental']
    .filter((key) => ['string', 'number', 'boolean'].includes(typeof track[key]))
    .map((key) => [key, track[key]]),
);
function checkSummary(result, checkedAt = Date.now()) {
  const { state, eligible, eligibilityState, entitlement, entitlementReason, reason,
    playbackState, playbackReason, playbackIdentity, diagnostics, playable, sourceChecked, rightsCheckedAt } = result;
  return { state, eligible, eligibilityState, entitlement, entitlementReason, reason,
    playbackState, playbackReason, playbackIdentity, diagnostics, playable, sourceChecked,
    rightsCheckedAt, checkedAt: Number.isSafeInteger(checkedAt) ? checkedAt : 0 };
}

export function createLocalLibrary(directory) {
  const memory = new Map();
  const disk = directory ? createSqliteLibrary(directory, metadata, checkSummary) : null;
  const account = (s) => createHash('sha256')
    .update((process.env.platform === 'lite' ? 'lite:' : 'standard:') + String(s.jar.userid)).digest('hex');

  function read(s) {
    const key = account(s);
    if (!memory.has(key)) memory.set(key, empty());
    return memory.get(key);
  }

  function fromDisk(method, s, ...args) {
    try { return disk[method](account(s), ...args); }
    catch (error) {
      if (error instanceof LibraryError) throw error;
      throw new LibraryError('本地曲库无法读取或写入，请检查应用数据目录', 500);
    }
  }

  const list = (s) => disk ? fromDisk('list', s) : read(s).lists.map(({ id, name, tracks }) =>
    ({ id, name, count: tracks.length, editable: true }));
  return {
    list,
    tracks(s, id) {
      const tracks = disk ? fromDisk('tracks', s, id) : read(s).lists.find(item => item.id === id)?.tracks;
      if (!tracks) throw new LibraryError('找不到本地歌单', 404);
      return tracks.map(track => ({ ...track }));
    },
    snapshot(s, kind, id = '') {
      return disk ? fromDisk('snapshot', s, kind, id) : read(s).snapshots.get(kind + ':' + id);
    },
    saveSnapshot(s, kind, id, rows) {
      const keys = kind === 'playlists' ? ['id','listid','globalId','name','count'] : null;
      const data = rows.map(row => keys ? Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k,row[k]])) : metadata(row));
      if (disk) return fromDisk('saveSnapshot', s, kind, id, data);
      const store = read(s).snapshots;
      store.set(kind + ':' + id, { data, updatedAt: Date.now() });
      if (store.size > 512) store.delete(store.keys().next().value);
    },
    cached(s, id) { return disk ? fromDisk('cached', s, id) : read(s).checks.get(id); },
    record(s, id, result) {
      const update = previous => checkSummary({ ...keepPurchaseEvidence(previous, result), rightsCheckedAt: result.rightsCheckedAt ?? previous?.rightsCheckedAt });
      if (disk) return fromDisk('record', s, id, update);
      const checks = read(s).checks;
      const next = update(checks.get(id));
      checks.delete(id);
      checks.set(id, next);
      if (checks.size > 10000) checks.delete(checks.keys().next().value);
    },
    edit(s, input) {
      function update(entry, count) {
        if (input.action === 'create') {
          if (count >= 100) throw new LibraryError('本地歌单已达上限');
          return { id: 'local:' + randomUUID(), name: nameOf(input.name), tracks: [] };
        }
        if (!entry) throw new LibraryError('找不到本地歌单', 404);
        if (input.action === 'rename') entry.name = nameOf(input.name);
        else if (input.action === 'add') {
          const track = s.tracks.get(input.track) ?? s.searchTracks?.get(input.track);
          if (!track) throw new LibraryError('歌曲已失效，请重新选择', 404);
          if (!entry.tracks.some((t) => t.id === track.id)) {
            if (entry.tracks.length >= 2000) throw new LibraryError('此歌单已达歌曲上限');
            entry.tracks.push(metadata(track));
          }
        } else if (input.action === 'remove' || input.action === 'move') {
          const at = entry.tracks.findIndex((t) => t.id === input.track);
          if (at < 0) throw new LibraryError('歌曲不在此歌单', 404);
          if (input.action === 'remove') entry.tracks.splice(at, 1);
          else {
            if (![-1, 1].includes(input.direction)) throw new LibraryError('无效排序方向');
            const next = at + input.direction;
            if (next >= 0 && next < entry.tracks.length)
              [entry.tracks[at], entry.tracks[next]] = [entry.tracks[next], entry.tracks[at]];
          }
        } else throw new LibraryError('无效歌单操作');
        return entry;
      }
      if (disk) fromDisk('edit', s, input, update);
      else {
        const { lists } = read(s);
        const i = lists.findIndex(item => item.id === input.id);
        const entry = update(i < 0 ? undefined : structuredClone(lists[i]), lists.length);
        if (input.action === 'create') lists.push(entry);
        else lists[i] = entry;
      }
      return list(s);
    },
    recordHistory(s, token, track, provider) {
      const item = { id: track.id, title: track.title, artist: track.artist, provider, playedAt: Date.now() };
      if (disk) return fromDisk('recordHistory', s, createHash('sha256').update(token).digest('hex'), item);
      const history = read(s).history;
      if (!history.has(token)) history.set(token, item);
      if (history.size > 50) history.delete(history.keys().next().value);
    },
    history(s) {
      return disk ? fromDisk('history', s) : [...read(s).history.values()].reverse();
    },
    close() { disk?.close(); },
  };
}


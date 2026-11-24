import { readHistoryBody } from '../history.mjs';
import { collectPages } from '../pagination.mjs';
import { isPlayableCandidate } from '../scheduler/audio-fallback.mjs';
import { sourceRevision, assertSourceRevision, refreshSources } from '../source-refresh.mjs';
import { unauthorizedId, registerTracks, unauthorizedTracks, localPlaylist,
  playbackAvailability, recordAccess } from '../library.mjs';

export function createLibraryRoutes({ json, localLibrary, adapter, call, inspect, sources, audioCache, sessions }) {
  function savedInspection(session, track) {
    const result = localLibrary.cached(session, track.id);
    return (result?.playable && Date.now() - result.checkedAt < 7200000) || (result?.sourceChecked && Date.now() - result.checkedAt < 120000)
      ? result : undefined;
  }
  function listedTracks(session, tracks) {
    return tracks.map(track => {
      const inspection = savedInspection(session, track);
      if (inspection && !track.checked) recordAccess(session, track, inspection, { sync: false });
      return { ...track, inspection };
    });
  }
  const pages = (s, method, params = {}) => collectPages((page, pagesize) => call(s, method, { ...params, page, pagesize }));
  return {
    'GET /api/local-history': ({ res, s }) => json(res, 200, { items: localLibrary.history(s) }),
    "POST /api/local-playlists": async ({ req, res, s }) => {
      const input = await readHistoryBody(req);
      return json(res, 200, { playlists: localLibrary.edit(s, input) });
    },
    "GET /api/playlists": async ({ res, s, u }) => {
      let snapshot;
      try { snapshot = localLibrary.snapshot(s, 'playlists'); } catch {}
      if (snapshot && u.searchParams.get('refresh') !== '1') {
        s.playlists = new Map(snapshot.data.map(p => [p.id,p]));
        const local = localPlaylist(s);
        return json(res, 200, { playlists: snapshot.data, snapshot: true, updatedAt: snapshot.updatedAt });
      }
      let rows = [], remoteUnavailable = false;
      try { rows = await pages(s, 'user_playlist'); }
      catch { remoteUnavailable = true; }
      const playlists = rows
        .map((x) => ({
          id: String(x.listid ?? x.list_id ?? x.global_collection_id ?? ''),
          listid: x.listid ?? x.list_id,
          globalId: x.global_collection_id,
          name: x.name ?? x.listname ?? '未命名歌单',
          count: Number(x.count ?? x.songcount ?? 0),
        }))
        .filter((x) => x.id);
      if (rows.length && !playlists.length) throw new Error('歌单标识格式尚未适配。');
      if (remoteUnavailable && snapshot) playlists.push(...snapshot.data);
      if (!remoteUnavailable) try { localLibrary.saveSnapshot(s, 'playlists', '', playlists); } catch {}
      s.playlists = new Map(playlists.map((x) => [x.id, x]));
      const local = localPlaylist(s);
      return json(res, 200, {
        playlists: playlists,
        remoteUnavailable,
      });
    },
    "GET /api/tracks": async ({ res, s, u }) => {
      const id = u.searchParams.get('playlist');
      if (!s.playlists.has(id))
        return json(res, 404, { error: '请先选择本账号的歌单' });
      let snapshot;
      try { snapshot = localLibrary.snapshot(s, 'tracks', id); } catch {}
      if (snapshot && u.searchParams.get('refresh') !== '1') {
        const tracks = registerTracks(s, id, snapshot.data);
        return json(res, 200, { tracks: listedTracks(s, tracks), localPlaylist: localPlaylist(s), snapshot: true, updatedAt: snapshot.updatedAt }, s);
      }
      const p = s.playlists.get(id);
      const { normalizeTrack } = await adapter('provider');
      const normalized = (
          await pages(
            s,
            p.listid !== undefined ? 'playlist_track_all_new' : 'playlist_track_all',
            p.listid !== undefined ? { listid: p.listid } : { id: p.globalId },
          )
        ).map(normalizeTrack);
      try { localLibrary.saveSnapshot(s, 'tracks', id, normalized); } catch {}
      const tracks = registerTracks(s, id, normalized);
      return json(res, 200, { tracks: listedTracks(s, tracks), localPlaylist: localPlaylist(s) }, s);
    },
    "POST /api/inspect": async ({ res, s, sid, u }) => {
      const id = u.searchParams.get('track');
      const track = s.tracks.get(id) ?? s.searchTracks?.get(id);
      if (!track) return json(res, 404, { error: '歌曲不属于当前会话' });
      const accountFresh = u.searchParams.get('accountFresh') === '1';
      const fresh = accountFresh || u.searchParams.get('fresh') === '1';
      const revision = fresh ? refreshSources(s, track, accountFresh, audioCache) : sourceRevision(s);
      let finishRefresh;
      const barrier = fresh ? new Promise(resolve => { finishRefresh = resolve; }) : null;
      if (barrier) s.sourceRefresh = barrier;
      try {
        let result = fresh ? undefined : savedInspection(s, track);
        if (!result) {
          if (track.provider && track.provider !== 'kugou') {
            const name = sources.describe?.().find(item => item.id === track.provider)?.name ?? '音源';
            try {
              const media = await sources.play(s, track);
              result = media
                ? { state: 'allowed', eligible: true, playbackState: 'allowed', playable: true, reason: name + '完整音源可用' }
                : { state: 'unknown', playbackState: 'unknown', reason: name + '完整音源待确认' };
            } catch {
              result = { state: 'unknown', playbackState: 'unknown', reason: name + '暂时无法检查' };
            }
          } else {
            try { result = await inspect(s, track, fresh, accountFresh, localLibrary.cached(s, id)); }
            catch (error) {
              if (error.name === 'AbortError') throw error;
              result = { ...playbackAvailability(track, false, '酷狗音源检查暂未完成'), refreshIncomplete: fresh };
            }
            if (!result.playable) {
              let backup;
              try { backup = await sources.fallback(s, track); } catch {}
              if (isPlayableCandidate(backup)) result = { ...result, state: 'allowed',
                eligibilityState: result.eligibilityState ?? result.state, playbackState: 'allowed',
                playbackReason: '网易云同录音完整音源可用', playable: true };
            }
          }
          assertSourceRevision(s, revision);
          if (sessions && sessions.get(sid) !== s) throw new DOMException('登录已失效', 'AbortError');
          result = { ...result, refreshIncomplete: !!result.refreshIncomplete || !!(fresh && result.accountWarnings?.length), sourceChecked: true, rightsCheckedAt: Date.now() };
          if (s.tracks.has(id)) localLibrary.record(s, track.id, result);
        }
        assertSourceRevision(s, revision);
        return json(res, 200, { ...result, localPlaylist: recordAccess(s, track, result) });
      } finally {
        finishRefresh?.();
        if (s.sourceRefresh === barrier) delete s.sourceRefresh;
      }
    },
  };
}

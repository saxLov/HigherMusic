import { randomBytes } from 'node:crypto';
import { readHistoryBody } from '../history.mjs';
import { playbackAvailability, recordAccess } from '../library.mjs';
import { mediaTickets } from '../media-proxy.mjs';
import { isPlayableCandidate, prepareAudioFallback } from '../scheduler/audio-fallback.mjs';
import { cacheKey } from '../audio-cache.mjs';
import { createPlaybackPreparation } from '../scheduler/playback-preparation.mjs';
import { sourceRevision, assertSourceRevision } from '../source-refresh.mjs';

export function createPlaybackRoutes({ json, localLibrary, sessions, adapter, sources, audioPrefetch, audioPrefetchDelayMs, audioCache }) {
  const preparation = createPlaybackPreparation();
  async function resolveSelection(s, sid, track, { signal, retry = null, background = false, playing = true } = {}) {
    await s.sourceRefresh;
    const revision = sourceRevision(s);
    const local = s.tracks.get(track.id), id = track.id;
    const authorizedOnly = retry === 'authorized', standardOnly = retry === 'standard';
    const alternate = !!retry && !authorizedOnly;
    let primary, localResult;
    const activeSession = () => sessions.get(sid) === s && !!s.user && !signal?.aborted && sourceRevision(s) === revision;
    const health = s.kugouHealth ??= { failures: 0, until: 0 };
    const cooling = playing && Date.now() < health.until;
    const canCheckKugou = (track.provider ?? 'kugou') === 'kugou' && !alternate && !cooling;
    const noteKugou = (statuses) => {
      if (!playing) return;
      const transient = statuses.some(status => status === 408 || (status >= 500 && status < 600));
      health.failures = transient ? health.failures + 1 : 0;
      if (statuses.includes(429) || health.failures >= 2) {
        health.until = Date.now() + 60000;
        health.failures = 0;
      }
    };
    async function checkPrimary() {
      try {
        const checkAccess = sources.canAuthorize?.(track.provider ?? 'kugou')
          ? (...args) => sources.authorize(...args) : (await adapter('access')).checkAccess;
        const saved = playing && local ? localLibrary.cached(s, track.id) : undefined;
        const cachedAccess = saved?.eligible === true && (saved.eligibilityState ?? saved.state) === 'allowed' &&
          (saved.entitlement === 'purchased' || ((saved.rightsCheckedAt ?? saved.checkedAt) >= (s.rightsFreshAt ?? 0) && Date.now() - (saved.rightsCheckedAt ?? saved.checkedAt) < 7200000)) ? saved : undefined;
        const result = await checkAccess(s, track, playing, { cachedAccess, knownPurchase: saved, fastFallback: playing, authorizedOnly, signal });
        if (!activeSession()) return result;
        if (local && !cachedAccess) {
          try {
            localLibrary.record(s, track.id, { ...result, rightsCheckedAt: Date.now(),
              playable: result.state === 'allowed' && result.playbackState === 'allowed' });
          } catch { /* A disk failure must not interrupt playback. */ }
        }
        noteKugou(result.playbackState === 'allowed' ? [] : (result.diagnostics ?? [])
          .filter(d => d.outcome === 'failed').map(d => d.httpStatus));
        if (local) localResult = recordAccess(s, track, result);
        return result;
      } catch (error) {
        if (!playing) throw error;
        if (activeSession()) noteKugou([error.httpStatus]);
      }
    }
    let prepared;
    if (playing && canCheckKugou && !authorizedOnly) {
      if (audioPrefetch && !background) void sources.warmFallback?.(s, track);
      prepared = await prepareAudioFallback(checkPrimary, signal =>
        activeSession() ? sources.fallback(s, track, { standardOnly, signal }) : null,
      { delayMs: audioPrefetchDelayMs, prefetch: audioPrefetch && !background, parentSignal: signal });
      primary = prepared.original;
      if (prepared.standby && activeSession() && !background) {
        const standby = { id, result: prepared.standby, until: Date.now() + 15000 };
        s.standbyAudio = standby;
        setTimeout(() => {
          if (s.standbyAudio === standby) delete s.standbyAudio;
        }, 15000).unref();
      }
    } else if (canCheckKugou) primary = await checkPrimary();
    if (!activeSession()) {
      throw new DOMException('会话已取消', 'AbortError');
    }
    if (!playing) return { result: primary, localResult };
    let result = primary;
    if (isPlayableCandidate(primary)) {
      result = { ...primary, playbackSource: { provider: 'kugou', name: '酷狗', history: !!local } };
    } else if (prepared) {
      result = prepared.candidate ?? primary;
    } else if (!authorizedOnly) {
      try {
        const standby = !standardOnly && alternate && s.standbyAudio?.id === id &&
          s.standbyAudio.until > Date.now() ? s.standbyAudio.result : null;
        if (standby) s.standbyAudio = undefined;
        result = (track.provider && track.provider !== 'kugou'
          ? await sources.play(s, track, { standardOnly, signal })
          : standby ?? await sources.fallback(s, track, { standardOnly, signal })) ?? primary;
      } catch { result = primary; }
    }
    if (!activeSession()) {
      throw new DOMException('会话已取消', 'AbortError');
    }
    if (!result) result = { state: 'unknown', playbackState: 'unknown',
      reason: '暂未取得可播放的完整音源' };
    if (!authorizedOnly && result === primary && primary.state !== 'allowed')
      result = { ...primary, reason: primary.reason + '。暂未找到可播放的同版本备用音源' };
    return { result, primary, prepared, localResult };
  }
  const checkOrPlay = async ({ res, s, sid, u, action }) => {
    await s.sourceRefresh;
    const revision = sourceRevision(s);
    s.cancelPreparation = () => preparation.cancel(s);
    const id = u.searchParams.get('track');
    const local = s.tracks.get(id);
    const playing = action === 'POST /api/play';
    const track = local ?? (playing ? s.searchTracks?.get(id) : null);
    if (!track) return json(res, 404, { error: '歌曲信息不完整，请刷新歌单或重新搜索' });
    const cached = playing && !u.searchParams.get('retry') && !u.searchParams.has('alternate')
      ? await audioCache?.granted(s, track) : null;
    assertSourceRevision(s, revision);
    if (cached && sessions.get(sid) === s && !res.destroyed) {
      const reply = mediaTickets(s, { ...cached.result, cacheOnly: true }, cached.key, cached.until);
      reply.playbackToken = randomBytes(24).toString('hex');
      s.playbackSources ??= new Map();
      s.playbackSources.set(id, { ...cached.result.playbackSource, playbackToken: reply.playbackToken,
        expiresAt: cached.until });
      return json(res, 200, reply);
    }
    const retry = playing ? u.searchParams.get('retry') : null;
    if (playing && (retry || u.searchParams.has('alternate'))) { audioCache?.reject(s, track); preparation.invalidate(s, track); }
    const standardOnly = retry === 'standard';
    const alternate = playing && (standardOnly || u.searchParams.get('alternate') === '1');
    const control = playing ? new AbortController() : null;
    if (control) {
      s.playRequest = control;
      res.once('close', () => {
        control.abort();
        if (s.playRequest === control) delete s.playRequest;
      });
    }
    const signal = control?.signal;
    if (playing && !retry && !alternate) s.standbyAudio = undefined;
    let localResult;
    const selection = !playing ? await resolveSelection(s, sid, track, { playing: false }) : await preparation.get(s, track, { signal, fresh: !!retry || alternate,
      variant: retry || alternate ? ':' + (retry || 'alternate') : '',
      run: (jobSignal, background) => resolveSelection(s, sid, track, { signal: jobSignal, retry: retry || (alternate ? 'alternate' : null), background }) });
    const { result, primary, prepared } = selection;
    assertSourceRevision(s, revision);
    if (res.destroyed || sessions.get(sid) !== s) return;
    if (!playing) return json(res, 200, result);
    const key = audioCache && cacheKey(s, track, result);
    const playback = mediaTickets(s, result, key, selection.ticketUntil);
    if (audioCache && playback.url) audioCache.remember(s, track, key, result);
    if (playback.url || (!retry && !alternate)) {
      const availability = playbackAvailability(track, !!playback.url, playback.url
        ? (result.playbackSource?.provider === 'netease' ? '网易云同录音音源可用' : primary?.playbackReason)
        : [primary?.playbackReason || result.playbackReason, '酷狗和网易云均未取得可用的同录音完整音源'].filter(Boolean).join('；'));
      if (local) {
        try { localLibrary.record(s, id, availability); } catch { /* Keep the current session result. */ }
      }
      localResult = recordAccess(s, track, availability);
    }
    if (selection.selectionHit) playback.selectionHit = true;
    if (prepared) playback.audioScheduling = prepared.scheduling;
    if (primary && result.playbackSource?.provider === 'netease') {
      playback.kugouSelection = {
        entitlement: primary.entitlementReason,
        source: primary.playbackReason,
      };
    }
    if (playback.url && result.playbackSource) {
      playback.playbackToken = randomBytes(24).toString('hex');
      s.playbackSources ??= new Map();
      s.playbackSources.delete(id);
      s.playbackSources.set(id, { ...result.playbackSource, playbackToken: playback.playbackToken,
        expiresAt: Date.now() + 4 * 60 * 60 * 1000 });
      // Do not let bulk inspection or a failed play erase the last actual source.
      while (s.playbackSources.size > 2048) s.playbackSources.delete(s.playbackSources.keys().next().value);
    }
    return json(res, 200, { ...playback, localPlaylist: localResult }, s);
  };
  return {
    'POST /api/rights-warm': async ({ res, s }) => {
      const checker = (await adapter('access')).checkAccess;
      await checker.warmAccount?.(s);
      return json(res, 200, { ready: true });
    },
    'POST /api/prepare': async ({ req, res, s, sid }) => {
      await s.sourceRefresh;
      const revision = sourceRevision(s);
      s.cancelPreparation = () => preparation.cancel(s);
      const input = await readHistoryBody(req);
      if (Number.isSafeInteger(input.epoch)) {
        if (input.epoch < (s.prepareEpoch ?? 0)) return json(res, 200, { stale: true });
        s.prepareEpoch = input.epoch;
      }
      if (!Array.isArray(input.tracks) || input.tracks.length > 5 || input.tracks.some(id => typeof id !== 'string' || id.length > 256))
        return json(res, 400, { error: '准备列表无效' });
      const tracks = [...new Set(input.tracks)].map(id => s.tracks.get(id) ?? s.searchTracks?.get(id)).filter(Boolean);
      const planned = preparation.prepare(s, tracks, (track, signal, background) => resolveSelection(s, sid, track, { signal, background }));
      const settled = await planned.completion;
      if (sourceRevision(s) !== revision) return json(res, 200, { stale: true });
      if (sessions.get(sid) !== s || (Number.isSafeInteger(input.epoch) && input.epoch !== s.prepareEpoch)) return json(res, 200, { stale: true });
      const items = [];
      for (const item of settled) if (item.status === 'fulfilled') {
        const { track, selection } = item.value;
        // Preparation confirms candidate selection, never grants playback/history.
        if (!isPlayableCandidate(selection.result)) continue;
        const availability = playbackAvailability(track, true, '完整同录音音源已准备');
        try { localLibrary.record(s, track.id, availability); } catch {}
        recordAccess(s, track, availability);
        items.push({ id: track.id, inspection: { state: 'allowed', playbackState: 'allowed', playable: true, sourceChecked: true } });
      }
      return json(res, 200, { planned: planned.planned, items, ...preparation.metrics(s) });
    },
    "POST /api/play-started": async ({ req, res, s, sid }) => {
      if (!s.user) return json(res, 401, { error: '请先扫码登录' });
      const { songId, playbackToken } = await readHistoryBody(req);
      if (sessions.get(sid) !== s) return json(res, 401, { error: '登录已失效' });
      const source = s.playbackSources?.get(songId);
      if (!source || source.playbackToken !== playbackToken || source.expiresAt < Date.now())
        return json(res, 403, { error: '播放凭据已失效' });
      source.started = true;
      const track = s.tracks.get(songId) ?? s.searchTracks?.get(songId);
      if (track) {
        try { localLibrary.recordHistory(s, playbackToken, track, source.provider); }
        catch { /* Local history must not interrupt playback or cloud confirmation. */ }
      }
      return json(res, 200, { ok: true });
    },
    "POST /api/source-unavailable": async ({ req, res, s, sid }) => {
      if (!s.user) return json(res, 401, { error: '请先扫码登录' });
      const { songId, playbackToken } = await readHistoryBody(req);
      if (sessions.get(sid) !== s) return json(res, 401, { error: '登录已失效' });
      const track = s.tracks.get(songId) ?? s.searchTracks?.get(songId);
      const source = s.playbackSources?.get(songId);
      if (!track || !source || !playbackToken || source.playbackToken !== playbackToken ||
          source.expiresAt <= Date.now()) return json(res, 403, { error: '播放凭据已失效' });
      s.playbackSources.delete(songId);
      audioCache?.reject(s, track); preparation.invalidate(s, track);
      const result = playbackAvailability(track, false, '已尝试可用线路，仍未能起播');
      if (s.tracks.has(songId)) {
        try { localLibrary.record(s, songId, result); } catch { /* Keep the current session result. */ }
      }
      return json(res, 200, { localPlaylist: recordAccess(s, track, result) });
    },
    "POST /api/check": checkOrPlay,
    "POST /api/play": checkOrPlay,
  };
}


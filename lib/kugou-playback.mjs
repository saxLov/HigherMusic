import { evaluatePlayback } from './rights.mjs';
import { readRecordingMetadata } from './recording-metadata.mjs';

const id = (v) => v == null || ['', '0'].includes(String(v).trim()) ? '' : String(v).trim();
const sameId = (a, b) => !id(a) || !id(b) || id(a) === id(b);
const credential = (v) => typeof v === 'string' && v.length > 0 && v.length <= 8192;
const throttled = (e) => e?.httpStatus === 429 || e?.platformCode === 429;

// Only fixed labels and numeric codes may leave this adapter. Never copy response bodies or errors.
export function playbackDiagnostic(stage, outcome, error) {
  const result = { stage, outcome };
  for (const key of ['httpStatus', 'platformCode'])
    if (Number.isSafeInteger(error?.[key]) && error[key] !== 0) result[key] = error[key];
  return result;
}

export function createKugouPlaybackResolver(request, now = Date.now) {
  const sessions = new WeakMap();
  function state(s) {
    let value = sessions.get(s);
    if (!value || value.token !== s.jar?.token || value.userid !== s.jar?.userid) {
      value = { token: s.jar?.token, userid: s.jar?.userid, retryAt: 0,
        device: !value && credential(s.jar?.dfid) };
      sessions.set(s, value);
    }
    return value;
  }
  async function device(s, value, signal) {
    if (value.device) return;
    if (value.devicePending) return value.devicePending;
    value.devicePending = (async () => {
      const body = await request(s, 'register_dev', {}, { signal });
      signal?.throwIfAborted();
      const dfid = body?.data?.dfid;
      if (!credential(dfid)) throw new Error('incomplete device credential');
      s.jar.dfid = dfid;
      value.device = true;
    })();
    try { await value.devicePending; }
    finally { value.devicePending = null; }
  }
  async function userAuth(s, value, signal) {
    if (value.auth && value.authDevice === s.jar?.dfid && now() < value.authUntil) return value.auth;
    if (value.authPending) return value.authPending;
    value.authPending = (async () => {
      const body = await request(s, 'user_verify', {}, { signal });
      signal?.throwIfAborted();
      const auth = body?.data?.auth;
      if (!credential(auth)) throw new Error('incomplete user credential');
      value.auth = auth;
      value.authDevice = s.jar?.dfid;
      value.authUntil = now() + 600000;
      return auth;
    })();
    try { return await value.authPending; }
    finally { value.authPending = null; }
  }
  return async function resolve(s, item, { duration, allowAuthorization = false, fastFallback = false, authorizedOnly = false, signal, recording, quality = '128' } = {}) {
    signal?.throwIfAborted();
    const shouldStop = (error) => throttled(error) || [403,408].includes(error?.httpStatus) || (fastFallback &&
      [404, 408, 500, 502, 503, 504].includes(error?.httpStatus));
    const diagnostics = [];
    const value = state(s);
    if (now() < (value.blockedUntil || 0)) return {
      state: 'unknown', reason: '平台暂时限制请求，请稍后复查',
      diagnostics: [playbackDiagnostic('standard_url', 'cooldown')],
    };
    const loggedIn = !!s.jar?.token && !!s.jar?.userid;
    const params = { hash: item.hash, album_id: item.albumId,
      album_audio_id: item.albumAudioId, quality: 128, free_part: false };
    let media = { state: 'unknown', reason: '尚未取得可播放音源' };
    let stop = false, hardStop = false;
    let metadataRead = !!recording;
    if (loggedIn && !value.device && now() >= value.retryAt) {
      try {
        await device(s, value, signal);
        diagnostics.push(playbackDiagnostic('device', 'ready'));
      } catch (e) {
        signal?.throwIfAborted();
        value.retryAt = now() + 30000;
        diagnostics.push(playbackDiagnostic('device', 'failed', e));
        stop = shouldStop(e);
        hardStop = throttled(e) || e?.httpStatus === 403;
        if (throttled(e)) value.blockedUntil = now() + 30000;
      }
    } else if (loggedIn) {
      diagnostics.push(playbackDiagnostic('device', value.device ? 'cached' : 'cooldown'));
    }
    const read = async (name, extra, stage) => {
      try {
        const body = await request(s, name, { ...params, ...extra }, { signal });
        signal?.throwIfAborted();
        const source = body?.data ?? body;
        let candidate;
        const hashChanged = !!source?.hash && String(source.hash).toLowerCase() !== String(item.hash).toLowerCase();
        const albumChanged = !sameId(item.albumId, source?.album_id);
        const recordingChanged = !sameId(item.albumAudioId, source?.album_audio_id);
        if (hashChanged && !albumChanged && !recordingChanged && !metadataRead) {
          metadataRead = true;
          try {
            recording = await readRecordingMetadata(s, { ...item, duration }, request, signal);
            diagnostics.push(playbackDiagnostic('recording_metadata', recording ? 'ready' : 'unusable'));
          } catch (error) {
            signal?.throwIfAborted();
            diagnostics.push(playbackDiagnostic('recording_metadata', 'failed', error));
            if (shouldStop(error)) stop = true;
            if (throttled(error) || error?.httpStatus === 403) hardStop = true;
            if (throttled(error)) value.blockedUntil = now() + 30000;
          }
        }
        const sameEncoding = recording?.hashes?.includes(String(item.hash).toLowerCase()) &&
          recording.hashes.includes(String(source?.hash).toLowerCase());
        const wrongRecording = (hashChanged && !sameEncoding) || albumChanged || recordingChanged;
        if (wrongRecording) {
          candidate = { state: 'unknown', reason: '音源响应的歌曲版本与请求不一致' };
          // Reject this candidate, not the account-authorized route for the requested version.
        } else candidate = evaluatePlayback(body, { duration });
        const diagnostic = playbackDiagnostic(stage,
          wrongRecording ? 'wrong_recording' : candidate.state === 'allowed' ? 'complete' : candidate.state === 'blocked' ? 'preview' :
            candidate.canAttempt ? 'verify_duration' : 'unusable');
        if (wrongRecording) diagnostic.mismatch = [hashChanged && !sameEncoding && 'hash', albumChanged && 'album', recordingChanged && 'recording'].filter(Boolean);
        if (hashChanged && sameEncoding && !wrongRecording) diagnostic.encodingMatched = true;
        diagnostics.push(diagnostic);
        const rank = (v) => v.state === 'allowed' ? 3 : v.canAttempt ? 2 : v.state === 'blocked' ? 1 : 0;
        if (rank(candidate) >= rank(media)) media = candidate;
      } catch (e) {
        signal?.throwIfAborted();
        diagnostics.push(playbackDiagnostic(stage, 'failed', e));
        if (!media.canAttempt && media.state !== 'blocked' && !diagnostics.some(d => d.outcome === 'wrong_recording'))
          media = { state: 'unknown', reason: '酷狗取链失败，请查看诊断或稍后复查' };
        if (shouldStop(e)) {
          stop = true;
          hardStop = throttled(e) || e?.httpStatus === 403;
          if (throttled(e)) value.retryAt = value.blockedUntil = now() + 30000;
        }
      }
    };
    if (!stop && !authorizedOnly) {
      const levels = { high: ['high','flac','320','128'], flac: ['flac','320','128'], '320': ['320','128'], '128': ['128'] };
      for (const level of levels[quality] ?? levels['128']) {
        await read('song_url', { quality: level }, level === '128' ? 'standard_url' : 'quality_url');
        if (stop || media.state === 'allowed' || media.canAttempt) break;
        if (id(item.albumId) || id(item.albumAudioId))
          await read('song_url', { quality: level, album_id: '', album_audio_id: '' }, 'hash_url');
        if (stop || media.state === 'allowed' || media.canAttempt) break;
      }
    }
    // The new path only uses this account's existing entitlement; it cannot confer a purchase.
    if (media.state !== 'allowed' && allowAuthorization && loggedIn && !stop && value.device && now() >= value.retryAt) {
      let stage = 'user_verify';
      try {
        const cached = !!value.auth && value.authDevice === s.jar?.dfid && now() < value.authUntil;
        const auth = await userAuth(s, value, signal);
        diagnostics.push(playbackDiagnostic(stage, cached ? 'cached' : 'ready'));
        stage = 'song_authorization';
        const body = await request(s, 'song_auth', { ...params, auth }, { signal });
        signal?.throwIfAborted();
        const grant = body?.data;
        if (!credential(grant?.auth) || !Number.isFinite(Number(grant?.open_time)) || Number(grant.open_time) <= 0)
          throw new Error('incomplete song credential');
        if ((grant.hash && String(grant.hash).toLowerCase() !== String(item.hash).toLowerCase()) ||
            !sameId(item.albumAudioId, grant.album_audio_id) || !sameId(item.albumId, grant.album_id))
          throw new Error('mismatched song credential');
        diagnostics.push(playbackDiagnostic(stage, 'ready'));
        await read('song_url_auth', { auth: grant.auth, open_time: grant.open_time }, 'authorized_url');
      } catch (e) {
        signal?.throwIfAborted();
        diagnostics.push(playbackDiagnostic(stage, 'failed', e));
        value.retryAt = now() + 30000;
        if (throttled(e)) value.blockedUntil = value.retryAt;
        if (throttled(e) || e?.httpStatus === 403) hardStop = true;
        // Re-check a rejected user credential after cooldown, rather than holding it for ten minutes.
        if (stage === 'user_verify') { value.auth = null; value.authUntil = 0; }
      }
    }
    if (media.state !== 'allowed' && !media.canAttempt && !authorizedOnly && !hardStop)
      await read('legacy_play_info', {}, 'legacy_url');
    return { ...media, identity: { hash: item.hash, albumId: item.albumId,
      albumAudioId: item.albumAudioId }, diagnostics };
  };
}

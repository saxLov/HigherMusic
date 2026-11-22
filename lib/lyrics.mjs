import { instrumentalLyrics, lyrics as kugouLyrics, timedLyrics } from './gallery.mjs';
import { firstValid } from './scheduler/first-valid.mjs';
import { createSourceQueue } from './scheduler/source-queue.mjs';
import { withPlatformDeadline } from './gateway/transport.mjs';
import { readRecordingMetadata, cachedRecordingMetadata, instrumentalMetadata } from './recording-metadata.mjs';

// A session owns its cache. Keys identify the recording AND the selected audio
// source; selecting lyrics never modifies playbackSources or account rights.
export function createLyricsResolver({ call, sources, now = Date.now, fallbackDelayMs = 400 }) {
  const caches = new WeakMap();
  const kugouQueue = createSourceQueue({ spacingMs: 0 });
  async function resolve(session, track, source, signal) {
    const attempts = [];
    if (instrumentalMetadata(track) || ((track.provider ?? 'kugou') === 'kugou' && cachedRecordingMetadata(session, track)?.instrumental) ||
        /[（(【\[]\s*(?:instrumental(?:\s+version)?|纯音乐|伴奏(?:版)?)\s*[）)】\]]\s*$/iu.test(track.title ?? ''))
      return { lyrics: '', state: 'instrumental', attempts };
    const attempt = (provider, read) => async (signal) => {
      const entry = { provider, outcome: 'pending' };
      attempts.push(entry);
      try {
        const text = await read(signal);
        signal.throwIfAborted();
        if (instrumentalLyrics(text)) {
          entry.outcome = 'instrumental';
          return { lyrics: '', provider, state: 'instrumental' };
        }
        const valid = timedLyrics(text);
        entry.outcome = valid ? 'ready' : 'missing';
        return valid ? { lyrics: text, provider, state: 'ready' } : null;
      } catch (error) {
        if (signal.aborted) return null;
        entry.outcome = error?.cooling ? 'cooling' : 'failed';
        for (const key of ['httpStatus', 'platformCode']) {
          if (Number.isSafeInteger(error?.[key]) && error[key] > 0) entry[key] = error[key];
        }
        // Never log upstream objects: they can contain access keys and cookies.
        console.warn('【歌词诊断】', JSON.stringify(entry));
        return null;
      }
    };
    const selectedProvider = source?.provider ?? track.provider ?? 'kugou';
    const usingAlternate = selectedProvider !== 'kugou';
    const originalKugou = (track.provider ?? 'kugou') === 'kugou';
    const kugou = originalKugou && attempt('kugou', signal =>
      kugouQueue('lyrics', async () => {
        const text = await kugouLyrics({ ...session, jar: { ...session.jar } }, track, call, signal);
        if (text) return text;
        // A missing or wrong-duration lyric candidate is not evidence of instrumental music.
        // Only the exact recording's explicit platform metadata can establish that state.
        const metadata = await readRecordingMetadata(session, track, call, signal);
        return metadata?.instrumental ? '纯音乐，请欣赏' : '';
      }, signal));
    const alternate = usingAlternate && attempt(selectedProvider, signal => sources.lyrics({
        ...track, provider: selectedProvider, sourceId: source?.id ?? track.sourceId,
      }, { signal, session }));
    const matched = originalKugou && sources.matchedLyrics && attempt('netease', signal =>
      sources.matchedLyrics(session, 'netease', track, { signal }));
    const primary = usingAlternate ? alternate : kugou;
    const result = primary && await firstValid(primary, usingAlternate ? kugou : matched, fallbackDelayMs, signal);
    const diagnostics = attempts.map(entry =>
      entry.outcome === 'pending' ? { ...entry, outcome: 'cancelled' } : entry);
    return result ? { ...result, attempts: diagnostics } : {
      lyrics: '',
      state: attempts.some(x => x.outcome === 'failed' || x.outcome === 'cooling') ? 'unavailable' : 'missing',
      attempts: diagnostics,
    };
  }
  return async (session, track, source, signal) => {
    signal?.throwIfAborted();
    let cache = caches.get(session);
    if (!cache) { cache = new Map(); caches.set(session, cache); }
    const key = JSON.stringify([track.provider, track.id, track.hash, track.albumAudioId,
      track.title, track.artist, track.album, track.duration, instrumentalMetadata(track),
      cachedRecordingMetadata(session, track)?.instrumental, session.sourceRevision, source?.provider, source?.id]);
    let entry = cache.get(key);
    const cached = !!entry && now() < entry.until;
    if (!cached) {
      const controller = new AbortController();
      entry = { until: now() + 30 * 60 * 1000, controller, readers: 0, done: false };
      entry.promise = resolve(session, track, source, controller.signal).then(result => {
        if (!['ready', 'instrumental'].includes(result.state) && cache.get(key) === entry) cache.delete(key);
        return result;
      }, error => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      }).finally(() => { entry.done = true; });
      cache.set(key, entry);
      while (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    entry.readers++;
    try {
      const result = signal ? await withPlatformDeadline(() => entry.promise, 40000, signal) : await entry.promise;
      return cached ? { ...result, cached: ['ready', 'instrumental'].includes(result.state) } : result;
    } finally {
      if (--entry.readers === 0 && !entry.done) {
        if (cache.get(key) === entry) cache.delete(key);
        entry.controller.abort();
      }
    }
  };
}

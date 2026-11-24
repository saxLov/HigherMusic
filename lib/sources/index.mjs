import { recordingKey } from '../audio-cache.mjs';
import { chooseRecording, recordingNames, sameRecording } from './match.mjs';
import { createSourceQueue } from '../scheduler/source-queue.mjs';
import { createProviderRegistry } from './registry.mjs';

const sourceNames = { kugou: '酷狗', netease: '网易云' };

export function createMusicSources(sources, { library } = {}) {
  const registry = createProviderRegistry(sources);
  const adapters = new Map(sources.map((source) => [source.id, { source, run: createSourceQueue({ spacingMs: source.network === false ? 0 : 350 }) }]));
  const caches = new WeakMap();
  function searchOne(session, id, keywords) {
    let cache = caches.get(session);
    if (!cache) { cache = new Map(); caches.set(session, cache); }
    const key = id + ':' + keywords.toLowerCase();
    const old = cache.get(key);
    if (old && Date.now() < old.until) return old.result;
    const { run, source } = adapters.get(id);
    const result = run('search', () => source.search(session, keywords)).catch((error) => {
      if (cache.get(key)?.result === result) cache.delete(key);
      throw error;
    });
    cache.set(key, { result, until: Date.now() + 120000 });
    while (cache.size > 64) cache.delete(cache.keys().next().value);
    return result;
  }

  async function play(session, candidate, original, options) {
    const adapter = adapters.get(candidate.provider);
    if (!adapter?.source.resolve) return null;
    const signal = options?.signal;
    const context = { ...options, session };
    return adapter.run('audio', async () => {
      const track = await adapter.source.detail(candidate, context);
      signal?.throwIfAborted();
      if (!track || (original && !sameRecording(original, track))) return null;
      const media = await adapter.source.resolve(track, context);
      signal?.throwIfAborted();
      if (!media) return null;
      return {
        ...media, state: 'allowed', playbackState: 'allowed',
        playbackSource: { provider: track.provider, id: track.sourceId,
          name: registry.get(track.provider)?.manifest.name ?? sourceNames[track.provider], fallback: !!original,
          ...(track.provider === 'local' ? { history: false } : {}) },
      };
    }, signal);
  }

  return {
    describe: registry.describe,
    canAuthorize: id => !!registry.get(id)?.manifest.capabilities.accountAccess,
    authorize(session, track, playing, options) {
      const source = registry.get(track.provider ?? 'kugou')?.source;
      if (!source?.authorize) throw new Error('音源不支持账号权限检查');
      return source.authorize(session, track, playing, options);
    },
    warmFallback(session, original) {
      const { title, artist } = recordingNames(original);
      if (!title || !artist || !original.duration || !adapters.has('netease')) return;
      // Keep the same shared search promise for lyrics, playback and retries.
      return searchOne(session, 'netease', (title + ' ' + artist).slice(0, 140)).catch(() => {});
    },
    async search(session, keywords) {
      const ids = [...registry.values()].filter(({ manifest: m }) => m.capabilities.search && m.capabilities.network)
        .map(({ manifest }) => manifest.id);
      const results = await Promise.allSettled(ids.map((id) => searchOne(session, id, keywords)));
      const tracks = [], unavailable = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') tracks.push(...result.value);
        else unavailable.push(registry.get(ids[index]).manifest.name);
      });
      return { tracks: [...new Map(tracks.map((t) => [t.id, t])).values()], unavailable };
    },
    play: (session, track, options) => play(session, track, undefined, options),
    async fallback(session, original, options) {
      const { title, artist } = recordingNames(original);
      if (!title || !artist || !original.duration) return null;
      for (const { source } of adapters.values()) {
        if (options?.signal?.aborted) break;
        if (source.id === (original.provider ?? 'kugou') || !registry.get(source.id).manifest.capabilities.fallback) continue;
        try {
          const key = source.id + ':' + recordingKey(original);
          let saved;
          try { saved = library?.snapshot(session, 'match', key); } catch {}
          if (saved && Date.now() - saved.updatedAt < 7 * 86400000 && sameRecording(original, saved.data[0])) {
            try {
              const media = await play(session, saved.data[0], original, options);
              if (media) return media;
            } catch { options?.signal?.throwIfAborted(); }
          }
          const candidates = await searchOne(session, source.id, (title + ' ' + artist).slice(0, 140));
          options?.signal?.throwIfAborted();
          const match = chooseRecording(original, candidates);
          if (match) {
            const result = await play(session, match, original, options);
            if (result) { try { library?.saveSnapshot(session, 'match', key, [match]); } catch {} return result; }
          }
        } catch { /* One unavailable source must not prevent another from answering. */ }
      }
      return null;
    },
    // 歌词匹配独立于音频资格，不取链、不换源、不修改听歌记录。
    async matchedLyrics(session, provider, original, { signal } = {}) {
      const adapter = adapters.get(provider);
      const { title, artist } = recordingNames(original);
      if (!adapter?.source.lyrics || !title || !artist || !original.duration) return '';
      signal?.throwIfAborted();
      const candidates = await searchOne(session, provider, (title + ' ' + artist).slice(0, 140));
      signal?.throwIfAborted();
      const match = chooseRecording(original, candidates);
      return match ? adapter.run('lyrics', () => adapter.source.lyrics(match, { signal, session }), signal) : '';
    },
    async lyrics(track, { signal, session } = {}) {
      const adapter = adapters.get(track.provider);
      return adapter?.source.lyrics
        ? adapter.run('lyrics', () => adapter.source.lyrics(track, { signal, session }), signal) : '';
    },
  };
}


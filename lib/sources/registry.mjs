// Trusted, application-owned adapters only. Loading arbitrary JavaScript is not a sandbox.
export function createProviderRegistry(sources) {
  const entries = new Map();
  for (const source of sources) {
    if (!source || !/^[a-z][a-z0-9-]{0,31}$/.test(source.id) || entries.has(source.id))
      throw new TypeError('Invalid or duplicate music provider');
    for (const method of ['search', 'detail', 'resolve', 'lyrics', 'authorize'])
      if (source[method] !== undefined && typeof source[method] !== 'function')
        throw new TypeError(`Invalid provider method: ${method}`);
    if (source.resolve && !source.detail) throw new TypeError('Resolving provider requires detail');
    const capabilities = Object.freeze({ search: !!source.search, playback: !!source.resolve,
      lyrics: !!source.lyrics, accountAccess: !!source.authorize,
      network: source.network !== false, fallback: source.fallback !== false && !!source.resolve });
    entries.set(source.id, Object.freeze({ source, manifest: Object.freeze({
      id: source.id, name: source.name || ({ kugou: '酷狗', netease: '网易云', local: '本地音乐' }[source.id]) || source.id, version: 1, capabilities }) }));
  }
  return Object.freeze({ get: id => entries.get(id), values: () => entries.values(),
    describe: () => [...entries.values()].map(entry => entry.manifest) });
}

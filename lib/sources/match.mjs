const normalize = (value) => String(value ?? '').normalize('NFKC').toLowerCase().trim();
const plain = (value) => normalize(value).replace(/[\p{P}\p{Z}]/gu, '');
const suffix = /\s*[（(\[【][^）)\]】]+[）)\]】]\s*$/u;
const differentVersion = /\b(live|remix|cover|instrumental|karaoke|acoustic|remaster(?:ed)?|demo|dj|sped\s*up|slowed|radio edit|extended|version|edit|piano)\b|现场|翻唱|伴奏|纯音乐|混音|重制|加速|降速|改编|版[）)\]】]|版$/iu;

export function recordingNames(track) {
  let title = String(track.title ?? '').replace(/\.(mp3|flac|wav|ogg)$/i, '').trim();
  let artist = String(track.artist ?? '').trim();
  if (title.includes(' - ')) {
    const at = title.indexOf(' - ');
    const prefix = title.slice(0, at);
    if (!artist || plain(prefix) === plain(artist)) {
      artist ||= prefix;
      title = title.slice(at + 3);
    }
  }
  return { title, artist };
}

function artistKey(artist) {
  return normalize(artist).split(/\s*(?:\/|、|＆|&|;|；|，|,|\bfeat\.?\s+)\s*/u)
    .map(plain).filter(Boolean).sort().join('|');
}

export function sameRecording(original, candidate) {
  const a = recordingNames(original), b = recordingNames(candidate);
  // Version qualifiers are part of the title. Require exact normalized titles and artists.
  if (!plain(a.title) || plain(a.title) !== plain(b.title) ||
      !artistKey(a.artist) || artistKey(a.artist) !== artistKey(b.artist)) return false;
  if (candidate.isCover && !original.isCover) return false;
  const aMarked = differentVersion.test(a.title.match(suffix)?.[0] ?? a.title) ||
    differentVersion.test(original.version ?? '');
  const bMarked = differentVersion.test(b.title.match(suffix)?.[0] ?? b.title) ||
    differentVersion.test(candidate.version ?? '');
  if (aMarked !== bMarked) return false;
  if (differentVersion.test(candidate.version ?? '') &&
      plain(candidate.version) !== plain(original.version) &&
      !plain(a.title).includes(plain(candidate.version))) return false;
  return Number.isFinite(original.duration) && original.duration > 0 &&
    Number.isFinite(candidate.duration) && candidate.duration > 0 &&
    Math.abs(original.duration - candidate.duration) <= 3;
}

export function chooseRecording(original, candidates) {
  const matches = [...new Map(candidates.filter((t) => sameRecording(original, t))
    .map((t) => [t.id, t])).values()];
  if (!matches.length) return null;
  const album = plain(original.album);
  const score = (track) => Math.abs(track.duration - original.duration);
  matches.sort((a, b) => score(a) - score(b));
  const tied = matches.filter((track) => score(track) - score(matches[0]) <= 0.5);
  if (tied.length === 1) return tied[0];
  const sameAlbum = album ? tied.filter((t) => plain(t.album) === album) : [];
  return sameAlbum.length === 1 ? sameAlbum[0] : null;
}


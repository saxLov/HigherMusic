/* 画廊的后端辅助接口：public 路径、Image169 文件读取、专辑封面及 LRC 歌词查询。
 * Image169 只读一层，扩展名与真实路径均受检查；图片并不存入 localStorage。 */
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 前端唯一实际目录为 public；Image169 相对于该目录，而不是历史根目录单文件页面。 */
export const frontendRoot = fileURLToPath(new URL('../public/', import.meta.url));
const imageRoot = process.env.HIGHER_MUSIC_BACKGROUNDS || path.join(frontendRoot, 'Image169');
const imagePattern = /\.(png|jpe?g|webp|avif)$/i;
/* backgrounds()：列出 public/Image169 第一层支持的图片文件并排序；目录尚不存在时返回空列表。 */
export async function backgrounds() {
  try {
    return (await readdir(imageRoot, { withFileTypes: true }))
      .filter((x) => x.isFile() && imagePattern.test(x.name))
      .map((x) => x.name)
      .sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
/* backgroundFile()：验证单文件名和图片扩展名，再用 realpath 拒绝链接逃出图片目录；成功返回二进制与 MIME 类型。 */
export async function backgroundFile(name) {
  if (!name || name !== path.basename(name) || !imagePattern.test(name)) return null;
  try {
    const root = await realpath(imageRoot);
    const file = await realpath(path.join(root, name));
    if (path.dirname(file) !== root) return null;
    return {
      data: await readFile(file),
      type: /\.png$/i.test(name)
        ? 'image/png'
        : /\.webp$/i.test(name)
          ? 'image/webp'
          : /\.avif$/i.test(name)
            ? 'image/avif'
            : 'image/jpeg',
    };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
/* coverUrl()：从候选值中选择首个 HTTP(S) 封面，升级 HTTPS 并替换平台 {size} 占位为 500。 */
export function coverUrl(...values) {
  const value = values.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v));
  return value ? value.replace(/^http:/i, 'https:').replaceAll('{size}', '500') : '';
}
/* artwork()：优先用歌曲已有封面；否则按专辑 ID 查询并在当前会话缓存，找不到时返回空串。 */
export async function artwork(s, track, call) {
  if (track.cover) return track.cover;
  if (!track.albumId) return '';
  s.albumCovers ??= new Map();
  const id = String(track.albumId);
  if (s.albumCovers.has(id)) return s.albumCovers.get(id);
  const body = await call(s, 'album_detail', { id });
  const rows = Array.isArray(body.data)
    ? body.data
    : (body.data?.albums ?? body.data?.info ?? []);
  const album = Array.isArray(rows) ? rows.find((x) => String(x.album_id) === id) : null;
  const cover = coverUrl(album?.sizable_cover, album?.cover, album?.img);
  if (cover) s.albumCovers.set(id, cover);
  return cover;
}
// 只有实际包含时间戳和正文的 LRC 才进入缓存；元数据、HTML 和空文本都不算歌词。
export function timedLyrics(value) {
  return typeof value === 'string' && value.length <= 100000 &&
    value.split(/\r?\n/).some(line => /\[\d+:\d+(?:\.\d+)?\]/.test(line) && line.replace(/\[[^\]]*\]/g, '').trim());
}
export function instrumentalLyrics(value) {
  if (typeof value !== 'string' || value.length > 100000) return false;
  const lines = value.split(/\r?\n/).map(line => line.replace(/^(?:\s*\[[^\]]*\])+\s*/, '').trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line =>
    /^(?:纯音乐(?:\s*[，,、]?\s*(?:请欣赏|无歌词|敬请欣赏))?|此歌曲为纯音乐(?:\s*[，,]?\s*(?:请欣赏|无歌词|敬请欣赏))?|instrumental(?:\s+only)?)[。.!！]?$/iu.test(line));
}
/* hash/版本精确查询；候选失效可继续下一项，不能把限流或拒绝当成可重试错误。 */
export async function lyrics(s, track, call, signal) {
  if (!track.hash && !track.albumAudioId) return '';
  signal?.throwIfAborted();
  const found = await call(s, 'search_lyric', {
    hash: track.hash,
    album_audio_id: track.albumAudioId,
    duration: Math.round((track.duration || 0) * 1000),
  }, { signal });
  const rows = found.candidates ?? found.data?.candidates ?? [];
  if (!Array.isArray(rows)) throw new Error('歌词候选格式异常');
  const candidates = rows.filter(x => x?.id && x.accesskey &&
    (!(Number(x.duration) > 0 && track.duration > 0) ||
      Math.abs(Number(x.duration) / 1000 - track.duration) <= 3));
  let failure;
  for (const hit of candidates.slice(0, 3)) {
    signal?.throwIfAborted();
    try {
      const body = await call(s, 'lyric', { id: hit.id, accesskey: hit.accesskey, fmt: 'lrc', decode: true }, { signal });
      if (timedLyrics(body.decodeContent) || instrumentalLyrics(body.decodeContent)) return body.decodeContent;
    } catch (error) {
      signal?.throwIfAborted();
      if ([403, 429].includes(error?.httpStatus) || [403, 429, 20028].includes(error?.platformCode)) throw error;
      failure = error;
    }
  }
  if (failure) throw failure;
  return '';
}

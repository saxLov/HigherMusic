import { open, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export function imageExtension(data) {
  if (data.length < 12) throw new Error('图片文件不完整');
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return '.jpg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (data.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(data.toString('ascii', 8, Math.min(64, data.length)))) return '.avif';
  throw new Error('请选择 PNG、JPEG、WebP 或 AVIF 图片');
}
export async function importBackground(source, directory) {
  if (!/\.(png|jpe?g|webp|avif)$/i.test(source)) throw new Error('不支持的图片格式');
  const handle = await open(source, 'r');
  let data;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('每张图片不能超过 20 MB');
    // 限长读取，避免选择后文件被外部追加导致内存无界增长。
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_IMAGE_BYTES) throw new Error('每张图片不能超过 20 MB');
    data = buffer.subarray(0, size);
  } finally { await handle.close(); }
  const ext = imageExtension(data);
  const name = createHash('sha256').update(data).digest('hex').slice(0, 32) + ext;
  await mkdir(directory, { recursive: true });
  try { await writeFile(path.join(directory, name), data, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return name;
}

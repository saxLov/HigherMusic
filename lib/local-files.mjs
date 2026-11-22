import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';

const types = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
const safeTrack = row => JSON.parse(row.metadata);
const identity = file => [String(file.dev), String(file.ino), file.size, file.mtimeMs];
const unchanged = (row, file) => JSON.stringify(identity(file)) === row.identity;

// Paths can enter this catalogue only through the main process's native file picker.
// HTTP/renderer callers can list opaque IDs, but cannot register arbitrary paths.
export function createLocalFiles(directory) {
  mkdirSync(directory, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(directory, 'local-files.sqlite3'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
      identity TEXT NOT NULL, metadata TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history(token TEXT PRIMARY KEY, track TEXT, played_at INTEGER);`);
  const get = id => db.prepare('SELECT * FROM files WHERE id=?').get(id);
  const find = async id => {
    const row = get(id);
    if (!row) throw new Error('本地音乐未导入或已移除');
    let file;
    try { file = await lstat(row.path); } catch { throw new Error('本地文件不可用，请重新导入'); }
    if (!file.isFile() || file.isSymbolicLink() || !unchanged(row, file))
      throw new Error('文件已变化，请重新导入');
    return row;
  };
  return {
    async importFiles(paths) {
      if (!Array.isArray(paths) || paths.length > 500) throw new Error('每次最多导入 500 个文件');
      let imported = 0, failed = 0;
      for (const selected of paths) {
        try {
          if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.startsWith('\\\\'))
            throw new Error('仅支持本地文件');
          const filename = await realpath(selected);
          if (filename.startsWith('\\\\')) throw new Error('仅支持本地文件');
          const ext = path.extname(filename).toLowerCase(), type = types[ext];
          const file = await lstat(filename);
          if (!type || !file.isFile() || !file.size || file.size > 2 * 1024 ** 3) throw new Error('文件格式或大小不支持');
          const meta = await parseFile(filename, { skipCovers: true, duration: true });
          if (!Number.isFinite(meta.format.duration) || meta.format.duration <= 0 || !meta.format.codec)
            throw new Error('无法识别音频');
          const after = await lstat(filename);
          if (JSON.stringify(identity(file)) !== JSON.stringify(identity(after))) throw new Error('文件发生变化');
          const id = 'file:' + createHash('sha256').update(filename).digest('hex');
          if (!get(id) && db.prepare('SELECT count(*) AS n FROM files').get().n >= 10000)
            throw new Error('本地曲库已达到 10000 首上限');
          const text = value => String(value ?? '').trim().slice(0, 300);
          const track = { id, sourceId: id, provider: 'local', title: text(meta.common.title) || path.basename(filename, ext),
            artist: text(meta.common.artist) || '未知歌手', album: text(meta.common.album), duration: meta.format.duration };
          db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)')
            .run(id, filename, JSON.stringify(identity(after)), JSON.stringify(track), type);
          imported++;
        } catch { failed++; }
      }
      return { imported, failed };
    },
    async list() {
      const tracks = [], unavailable = [];
      for (const row of db.prepare('SELECT * FROM files ORDER BY rowid DESC LIMIT 10000').all()) {
        const track = safeTrack(row);
        try { await find(row.id); tracks.push(track); }
        catch { unavailable.push({ ...track, reason: '文件已移动、删除或修改，请重新导入' }); }
      }
      return { tracks, unavailable };
    },
    async detail(track) { return safeTrack(await find(track.id)); },
    async resolve(track, { signal } = {}) {
      signal?.throwIfAborted();
      await find(track.id);
      return { fileId: track.id, expectedDuration: track.duration, quality: '本地原文件' };
    },
    async lyrics(track) {
      const row = await find(track.id);
      const filename = row.path.slice(0, -path.extname(row.path).length) + '.lrc';
      let handle;
      try {
        const file = await lstat(filename);
        if (!file.isFile() || file.isSymbolicLink() || file.size > 256 * 1024) return '';
        handle = await open(filename, 'r');
        if (JSON.stringify(identity(file)) !== JSON.stringify(identity(await handle.stat()))) return '';
        const buffer = Buffer.alloc(256 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        return length > 256 * 1024 ? '' : buffer.subarray(0, length).toString('utf8');
      } catch { return ''; }
      finally { await handle?.close().catch(() => {}); }
    },
    remove(id) { db.prepare('DELETE FROM files WHERE id=?').run(id); },
    issue(session, result) {
      const token = randomBytes(24).toString('hex');
      const tickets = session.localMedia ??= new Map();
      tickets.set(token, { id: result.fileId, expires: Date.now() + 4 * 60 * 60 * 1000 });
      while (tickets.size > 128) tickets.delete(tickets.keys().next().value);
      return { ...result, fileId: undefined, url: '/api/proxy?ticket=' + token, playbackToken: token };
    },
    started(session, id, token) {
      const ticket = session.localMedia?.get(token);
      if (!ticket || ticket.id !== id || ticket.expires < Date.now() || !get(id)) return false;
      db.prepare('INSERT OR IGNORE INTO history VALUES(?,?,?)').run(token, id, Date.now());
      db.exec('DELETE FROM history WHERE token NOT IN (SELECT token FROM history ORDER BY played_at DESC LIMIT 10000)');
      return true;
    },
    async serve(req, res, session, token) {
      const ticket = session.localMedia?.get(token);
      let handle;
      try {
        if (!ticket || ticket.expires < Date.now()) { res.writeHead(404); res.end(); return; }
        const row = await find(ticket.id);
        handle = await open(row.path, 'r');
        const file = await handle.stat();
        if (!file.isFile() || !unchanged(row, file)) throw new Error('文件已变化');
        let start = 0, end = file.size - 1, partial = false;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) throw Object.assign(new Error('range'), { range: true });
          if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size)
            throw Object.assign(new Error('range'), { range: true });
          partial = true;
        }
        res.writeHead(partial ? 206 : 200, { 'Content-Type': row.type, 'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes', ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}) });
        // pipeline destroys the file stream on disconnect; never buffer a whole song in memory.
        await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(error.range ? 416 : 404, error.range && handle ? { 'Content-Range': `bytes */${(await handle.stat()).size}` } : {});
          res.end();
        } else if (!res.destroyed) res.destroy();
      } finally { await handle?.close().catch(() => {}); }
    },
    close() { db.close(); },
  };
}

export function createLocalFileSource(files) {
  return { id: 'local', name: '本地音乐', network: false, fallback: false,
    detail: track => files.detail(track), resolve: (track, options) => files.resolve(track, options),
    lyrics: track => files.lyrics(track) };
}

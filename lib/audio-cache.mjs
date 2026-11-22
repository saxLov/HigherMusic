import path from 'node:path';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseByteRange } from './gateway/audio-policy.mjs';
import { validAudioType } from './gateway/audio-policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const recordingKey = track => digest([track.id, track.provider, track.hash, track.albumId,
  track.albumAudioId, track.title, track.artist, track.duration, track.version]);
export function cacheKey(session, track, result) {
  return digest([process.env.platform === 'lite' ? 'lite' : 'standard', session.jar?.userid,
    recordingKey(track), result.playbackSource, result.quality, result.expectedDuration, result.playbackIdentity]);
}

export function createAudioCache(directory, { maxBytes = 1024 ** 3, maxFileBytes = 256 * 1024 ** 2,
  ttlMs = 7 * 86400000, now = Date.now } = {}) {
  mkdirSync(directory, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(directory, 'index.sqlite3'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS entries(key TEXT PRIMARY KEY, file TEXT, size INTEGER, type TEXT,
      created INTEGER, used INTEGER, modified REAL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value INTEGER);`);
  let enabled = db.prepare("SELECT value FROM settings WHERE key='enabled'").get()?.value !== 0;
  let epoch = 0, closed = false, reservedBytes = 0;
  const writers = new Set(), active = new Map(), pendingDeletion = new Set();
  const validName = name => /^[a-f0-9-]{36}\.bin$/.test(name);
  const remove = row => {
    if (active.get(row.file)) return false;
    try { if (validName(row.file)) unlinkSync(path.join(directory, row.file)); }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    db.prepare('DELETE FROM entries WHERE key=?').run(row.key); return true;
  };
  function trim() {
    const rows = db.prepare('SELECT * FROM entries ORDER BY used, created').all();
    let size = rows.reduce((sum, row) => sum + row.size, 0);
    for (const row of rows) if (row.created + ttlMs <= now() || size > maxBytes)
      if (remove(row)) size -= row.size;
    return size;
  }
  const known = new Set(db.prepare('SELECT file FROM entries').all().map(row => row.file));
  for (const file of readdirSync(directory)) if (/^[a-f0-9-]{36}\.(?:part|bin)$/.test(file) && !known.has(file)) {
    try { unlinkSync(path.join(directory, file)); } catch { /* Retry on the next launch. */ }
  }
  trim();

  async function entry(key) {
    if (!enabled || closed || !key) return null;
    const version = epoch;
    const row = db.prepare('SELECT * FROM entries WHERE key=?').get(key);
    if (!row) return null;
    if (pendingDeletion.has(row.file)) return null;
    if (!validName(row.file) || row.created + ttlMs <= now()) { remove(row); return null; }
    let handle;
    try {
      handle = await open(path.join(directory, row.file), 'r');
      const file = await handle.stat();
      if (!file.isFile() || file.size !== row.size || file.mtimeMs !== row.modified) throw new Error('changed');
      if (!enabled || closed || version !== epoch || pendingDeletion.has(row.file)) { await handle.close(); return null; }
      db.prepare('UPDATE entries SET used=? WHERE key=?').run(now(), key);
      return { row, handle };
    } catch { await handle?.close().catch(() => {}); if (!closed) remove(row); return null; }
  }
  return {
    async has(key) { const found = await entry(key); if (!found) return false; await found.handle.close(); return true; },
    remember(session, track, key, result) {
      const grants = session.cacheGrants ??= new Map();
      grants.set(recordingKey(track), { key, until: now() + 3600000, result: {
        state: 'allowed', playbackState: 'allowed', expectedDuration: result.expectedDuration,
        quality: result.quality, playbackSource: result.playbackSource } });
      while (grants.size > 512) grants.delete(grants.keys().next().value);
    },
    async granted(session, track) {
      if (!session.user) return null;
      const grant = session.cacheGrants?.get(recordingKey(track));
      return grant && grant.until > now() && await this.has(grant.key) ? grant : null;
    },
    reject(session, track) {
      const id = recordingKey(track), grant = session.cacheGrants?.get(id);
      session.cacheGrants?.delete(id);
      if (grant) { const row = db.prepare('SELECT * FROM entries WHERE key=?').get(grant.key);
        if (row) { pendingDeletion.add(row.file); if (remove(row)) pendingDeletion.delete(row.file); }
      }
    },
    async serve(req, res, key) {
      const found = await entry(key);
      if (!found) return false;
      const { row, handle } = found; active.set(row.file, (active.get(row.file) || 0) + 1);
      try {
        let start = 0, end = row.size - 1;
        if (req.headers.range) {
          const range = parseByteRange(req.headers.range);
          if (!range) throw new Error('range');
          const total = BigInt(row.size);
          start = Number(range.start === null ? (range.end >= total ? 0n : total - range.end) : range.start);
          end = Number(range.start === null || range.end === null || range.end >= total ? total - 1n : range.end);
          if (!Number.isSafeInteger(start) || start > end || start >= row.size) throw new Error('range');
        }
        res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': row.type, 'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes', 'X-Higher-Cache': 'hit',
          ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${row.size}` } : {}) });
        await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
      } catch {
        if (!res.headersSent && !res.destroyed) { res.writeHead(416, { 'Content-Range': `bytes */${row.size}` }); res.end(); }
        else if (!res.destroyed) res.destroy();
      } finally {
        if (active.get(row.file) > 1) active.set(row.file, active.get(row.file) - 1);
        else active.delete(row.file);
        await handle.close().catch(() => {});
        if (!closed) { if (pendingDeletion.has(row.file) && remove(row)) pendingDeletion.delete(row.file); trim(); }
      }
      return true;
    },
    capture(key, body, headers, status) {
      const length = Number(headers.get('content-length'));
      const range = headers.get('content-range');
      const complete = status === 200 || status === 206 && range === `bytes 0-${length - 1}/${length}`;
      if (!enabled || closed || !key || writers.has(key) || !Number.isSafeInteger(length) || length <= 0 ||
          writers.size >= 4 || reservedBytes + length > maxBytes ||
          length > Math.min(maxFileBytes, maxBytes) || !complete || !validAudioType(headers.get('content-type') || '')) return body;
      writers.add(key);
      reservedBytes += length;
      const version = epoch, name = randomUUID(), temporary = path.join(directory, name + '.part');
      const finalName = name + '.bin', finalPath = path.join(directory, finalName);
      const type = headers.get('content-type') || 'audio/mpeg';
      const input = Readable.fromWeb(body);
      input.on('error', () => {}); // The async iterator propagates it after the file is opened.
      const iterable = async function* () {
        let file, count = 0, committed = false;
        try {
          try { file = await open(temporary, 'wx'); } catch { /* Disk failure cannot stop audio. */ }
          for await (const chunk of input) {
            count += chunk.length;
            if (file && (count > length || epoch !== version || !enabled || closed)) { await file.close().catch(() => {}); file = null; }
            if (file) try {
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) throw new Error('Cache write stalled');
                offset += bytesWritten;
              }
            } catch { await file.close().catch(() => {}); file = null; }
            yield chunk;
          }
          if (file && count === length && epoch === version && enabled && !closed) {
            try {
            await file.sync(); const stat = await file.stat(); await file.close(); file = null;
            await rename(temporary, finalPath);
            if (epoch === version && enabled && !closed) {
              const previous = db.prepare('SELECT * FROM entries WHERE key=?').get(key);
              if (previous && !remove(previous)) return;
              db.prepare('INSERT OR REPLACE INTO entries VALUES(?,?,?,?,?,?,?)')
                .run(key, finalName, length, type, now(), now(), stat.mtimeMs);
              committed = true; trim();
            }
            } catch { /* Cache finalization failure must not break a completed audio response. */ }
          }
        } finally {
          await file?.close().catch(() => {});
          await unlink(temporary).catch(() => {});
          if (!committed) await unlink(finalPath).catch(() => {});
          writers.delete(key);
          reservedBytes -= length;
        }
      };
      const iterator = iterable();
      return new ReadableStream({
        async pull(controller) {
          try { const item = await iterator.next(); if (item.done) controller.close(); else controller.enqueue(item.value); }
          catch (error) { controller.error(error); }
        },
        async cancel() { input.destroy(); await iterator.return();
          if (writers.delete(key)) reservedBytes -= length;
        },
      });
    },
    stats() {
      if (!closed) trim();
      const row = db.prepare('SELECT count(*) AS count, coalesce(sum(size),0) AS bytes FROM entries').get();
      return { ...row, enabled, maxBytes, ttlDays: ttlMs / 86400000 };
    },
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new Error('缓存设置无效');
      db.prepare("INSERT OR REPLACE INTO settings VALUES('enabled',?)").run(Number(value));
      enabled = value; epoch++;
    },
    clear() { epoch++; for (const row of db.prepare('SELECT * FROM entries').all()) {
      pendingDeletion.add(row.file); if (remove(row)) pendingDeletion.delete(row.file);
    } },
    close() { closed = true; epoch++; db.close(); },
  };
}

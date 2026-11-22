import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const decode = rows => rows.map(row => JSON.parse(row.payload));

export function createSqliteLibrary(directory, normalizeTrack, normalizeCheck) {
  let db;
  const migrated = new Set();
  function database() {
    if (db) return db;
    mkdirSync(directory, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const next = new DatabaseSync(path.join(directory, 'library.sqlite3'), { timeout: 5000 });
    try {
      next.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS imported_accounts (account TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS playlists (
          account TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
          PRIMARY KEY (account, id)
        );
        CREATE TABLE IF NOT EXISTS playlist_tracks (
          account TEXT NOT NULL, playlist TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (account, playlist, position),
          FOREIGN KEY (account, playlist) REFERENCES playlists(account, id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          account TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(account, kind, id)
        );
        CREATE TABLE IF NOT EXISTS checks (
          account TEXT NOT NULL, track TEXT NOT NULL, checked_at INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (account, track)
        );
        CREATE INDEX IF NOT EXISTS checks_recent ON checks(account, checked_at DESC);
        CREATE TABLE IF NOT EXISTS listening_history (
          account TEXT NOT NULL, event TEXT NOT NULL, played_at INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (account, event)
        );
        CREATE INDEX IF NOT EXISTS history_recent ON listening_history(account, played_at DESC);
      `);
    } catch (error) {
      next.close();
      throw error;
    }
    return db = next;
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function writePlaylist(account, entry, position) {
    db.prepare(`INSERT INTO playlists VALUES (?, ?, ?, ?)
      ON CONFLICT(account, id) DO UPDATE SET name=excluded.name, position=excluded.position`)
      .run(account, entry.id, entry.name, position);
    db.prepare('DELETE FROM playlist_tracks WHERE account = ? AND playlist = ?').run(account, entry.id);
    const insert = db.prepare('INSERT INTO playlist_tracks VALUES (?, ?, ?, ?)');
    entry.tracks.forEach((track, i) => insert.run(account, entry.id, i, JSON.stringify(normalizeTrack(track))));
  }

  function writeCheck(account, track, result) {
    db.prepare(`INSERT INTO checks VALUES (?, ?, ?, ?)
      ON CONFLICT(account, track) DO UPDATE SET checked_at=excluded.checked_at, payload=excluded.payload`)
      .run(account, track, result.checkedAt, JSON.stringify(result));
  }

  function openAccount(account) {
    database();
    if (migrated.has(account)) return;
    const imported = () => db.prepare('SELECT 1 FROM imported_accounts WHERE account = ?').get(account);
    if (!imported()) {
      let legacy;
      try { legacy = JSON.parse(readFileSync(path.join(directory, account + '.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (legacy !== undefined && (!Array.isArray(legacy?.lists) || !legacy.checks ||
          typeof legacy.checks !== 'object' || Array.isArray(legacy.checks)))
        throw new Error('Invalid legacy library');
      transaction(() => {
        if (imported()) return;
        legacy?.lists.forEach((entry, i) => writePlaylist(account, entry, i));
        for (const [track, result] of Object.entries(legacy?.checks ?? {}))
          writeCheck(account, track, normalizeCheck(result, result.checkedAt ?? 0));
        db.prepare('INSERT INTO imported_accounts VALUES (?)').run(account);
      });
    }
    migrated.add(account);
  }

  const tracks = (account, id) => decode(db.prepare(
    'SELECT payload FROM playlist_tracks WHERE account = ? AND playlist = ? ORDER BY position',
  ).all(account, id));
  return {
    list(account) {
      openAccount(account);
      return db.prepare(`SELECT p.id, p.name, (SELECT COUNT(*) FROM playlist_tracks t
        WHERE t.account = p.account AND t.playlist = p.id) AS count
        FROM playlists p WHERE p.account = ? ORDER BY p.position`).all(account)
        .map(row => ({ ...row, editable: true }));
    },
    tracks(account, id) {
      openAccount(account);
      if (!db.prepare('SELECT 1 FROM playlists WHERE account = ? AND id = ?').get(account, id)) return;
      return tracks(account, id);
    },
    snapshot(account, kind, id) {
      openAccount(account);
      const row = db.prepare('SELECT payload, updated_at FROM snapshots WHERE account=? AND kind=? AND id=?').get(account, kind, id);
      return row && { data: JSON.parse(row.payload), updatedAt: row.updated_at };
    },
    saveSnapshot(account, kind, id, data) {
      openAccount(account);
      db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?, ?) ON CONFLICT(account,kind,id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload')
        .run(account, kind, id, Date.now(), JSON.stringify(data));
      db.prepare('DELETE FROM snapshots WHERE account=? AND rowid IN (SELECT rowid FROM snapshots WHERE account=? ORDER BY updated_at DESC LIMIT -1 OFFSET 512)').run(account, account);
    },
    cached(account, track) {
      openAccount(account);
      const row = db.prepare('SELECT payload FROM checks WHERE account = ? AND track = ?').get(account, track);
      return row && JSON.parse(row.payload);
    },
    record(account, track, update) {
      openAccount(account);
      transaction(() => {
        writeCheck(account, track, update(this.cached(account, track)));
        db.prepare(`DELETE FROM checks WHERE account = ? AND track IN
          (SELECT track FROM checks WHERE account = ? ORDER BY checked_at DESC, rowid DESC LIMIT -1 OFFSET 10000)`)
          .run(account, account);
      });
    },
    edit(account, action, update) {
      openAccount(account);
      transaction(() => {
        const entries = db.prepare('SELECT id, name FROM playlists WHERE account = ? ORDER BY position').all(account);
        const position = action.action === 'create' ? entries.length : entries.findIndex(entry => entry.id === action.id);
        const existing = entries[position];
        const entry = update(existing ? { ...existing, tracks: tracks(account, existing.id) } : undefined, entries.length);
        writePlaylist(account, entry, position);
      });
    },
    recordHistory(account, event, item) {
      openAccount(account);
      db.prepare('INSERT OR IGNORE INTO listening_history VALUES (?, ?, ?, ?)')
        .run(account, event, item.playedAt, JSON.stringify(item));
    },
    history(account) {
      openAccount(account);
      return decode(db.prepare(
        'SELECT payload FROM listening_history WHERE account = ? ORDER BY played_at DESC, rowid DESC LIMIT 50',
      ).all(account));
    },
    close() {
      db?.close();
      db = undefined;
      migrated.clear();
    },
  };
}

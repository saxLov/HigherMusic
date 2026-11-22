import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const keys = new Set(['higherweb.historySync.v1', 'higherweb.lyricOffset.v1', 'higherweb.backgrounds.v1', 'highermusic.volume.v1', 'highermusic.kugouMode.v1']);
export function validateSetting(key, value) {
  if (!keys.has(key) || typeof value !== 'string') throw new Error('无效设置');
  if (key === 'higherweb.historySync.v1' && !['true', 'false'].includes(value)) throw new Error('无效同步设置');
  if (key === 'higherweb.lyricOffset.v1' && (!value.trim() || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 3600)) throw new Error('无效歌词偏移');
  if (key === 'highermusic.kugouMode.v1' && !['standard', 'lite'].includes(value)) throw new Error('无效酷狗模式');
  if (key === 'highermusic.volume.v1' && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) throw new Error('无效音量');
  if (key === 'higherweb.backgrounds.v1') {
    if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new Error('背景设置过大');
    const map = JSON.parse(value);
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 10000) throw new Error('无效背景设置');
    for (const [id, name] of Object.entries(map)) {
      if (!id || id.length > 256 || typeof name !== 'string' || name.length > 255 || /[\\/\x00-\x1f]/.test(name) || !/\.(png|jpe?g|webp|avif)$/i.test(name)) throw new Error('无效背景文件名');
    }
  }
  return value;
}

export function createSettingsStore(directory, { filename = 'settings.json', validate = validateSetting } = {}) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, filename);
  let state = { schemaVersion: 1, values: {}, window: {} };
  try {
    const loaded = JSON.parse(readFileSync(file, 'utf8'));
    if (loaded.schemaVersion !== 1) throw new Error('不支持的设置版本');
    for (const [key, value] of Object.entries(loaded.values || {})) state.values[key] = validate(key, value);
    const w = loaded.window || {};
    state.window = Object.fromEntries(['width', 'height', 'x', 'y'].filter(k => Number.isInteger(w[k])).map(k => [k, w[k]]));
    state.window.maximized = w.maximized === true;
  } catch {
    // 保留损坏文件，下一次写入从默认设置恢复，不记录任何平台凭据。
    state = { schemaVersion: 1, values: {}, window: {} };
    if (existsSync(file)) copyFileSync(file, file + '.recovery');
  }
  const persist = (next) => {
    writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(file + '.tmp', file);
    state = next;
  };
  return {
    snapshot: () => ({ ...state.values }),
    window: () => ({ ...state.window }),
    set(key, value) { validate(key, value); persist({ ...state, values: { ...state.values, [key]: value } }); },
    setWindow(value) { persist({ ...state, window: { ...value } }); },
    export: () => JSON.stringify({ schemaVersion: 1, values: state.values }, null, 2),
    import(text) {
      if (Buffer.byteLength(text) > 3 * 1024 * 1024) throw new Error('设置文件过大');
      const input = JSON.parse(text);
      if (input.schemaVersion !== 1 || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw new Error('无效设置文件');
      const values = {};
      for (const [key, value] of Object.entries(input.values)) values[key] = validate(key, value);
      persist({ ...state, values });
    },
  };
}

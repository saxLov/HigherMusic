import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSettingsStore, validateSetting } from '../electron/settings.mjs';
import { importBackground } from '../electron/background-import.mjs';
import { startDesktopService } from '../electron/service.mjs';
import { createMusicServer } from '../server.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'higher-music-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('桌面设置跨服务端口与重启保留；导出不包含窗口或平台凭据', async t => {
  const dir = await temporary(t);
  const store = createSettingsStore(dir);
  store.set('higherweb.historySync.v1', 'false');
  store.set('higherweb.lyricOffset.v1', '-0.7');
  store.set('higherweb.backgrounds.v1', JSON.stringify({ '1:hash': '风景.png' }));
  store.setWindow({ x: 10, y: 20, width: 1200, height: 800 });
  assert.equal(createSettingsStore(dir).snapshot()['higherweb.lyricOffset.v1'], '-0.7');
  assert.deepEqual(Object.keys(JSON.parse(store.export())), ['schemaVersion', 'values']);
  assert.throws(() => store.set('token', 'secret'));
  assert.throws(() => store.import('{"schemaVersion":1,"values":{"cookie":"secret"}}'));
  assert.equal(store.snapshot()['higherweb.historySync.v1'], 'false');
});
test('损坏设置保留恢复副本并回退默认；批量导入失败不覆盖有效值', async t => {
  const dir = await temporary(t);
  await writeFile(path.join(dir, 'settings.json'), 'broken');
  const store = createSettingsStore(dir);
  assert.equal(await readFile(path.join(dir, 'settings.json.recovery'), 'utf8'), 'broken');
  store.set('higherweb.historySync.v1', 'false');
  assert.throws(() => store.import(JSON.stringify({ schemaVersion: 1, values: { 'higherweb.historySync.v1': 'true', 'higherweb.backgrounds.v1': '{"a":"../secret.png"}' } })));
  assert.equal(store.snapshot()['higherweb.historySync.v1'], 'false');
  for (const [key, value] of [['higherweb.lyricOffset.v1','NaN'], ['highermusic.volume.v1','2'], ['higherweb.historySync.v1','yes']]) assert.throws(() => validateSetting(key, value));
});
test('中文路径图片按内容去重，拒绝伪装图片、目录和过大文件', async t => {
  const dir = await temporary(t);
  const source = path.join(dir, '中文 背景.png');
  const target = path.join(dir, '用户背景');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jflkAAAAASUVORK5CYII=', 'base64');
  await writeFile(source, png);
  const name = await importBackground(source, target);
  assert.match(name, /^[a-f0-9]{32}\.png$/);
  assert.equal(await importBackground(source, target), name);
  assert.deepEqual(await readFile(path.join(target, name)), png);
  await writeFile(source, '<script>bad</script>');
  await assert.rejects(importBackground(source, target), /请选择/);
  await mkdir(path.join(dir, 'directory.png'));
  await assert.rejects(importBackground(path.join(dir, 'directory.png'), target));
  await writeFile(source, Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(importBackground(source, target), /20 MB/);
});
test('桌面本地服务使用动态回环端口；无启动凭据或 Host 不匹配时全部拒绝；退出释放端口', async t => {
  const service = await startDesktopService(createMusicServer);
  t.after(() => service.stop());
  assert.match(service.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const route of ['/', '/api/session', '/app.js']) assert.equal((await fetch(service.origin + route)).status, 403);
  const headers = { 'X-Higher-Music': service.secret };
  assert.equal((await fetch(service.origin + '/api/session', { headers })).status, 200);
  const hostileHost = await new Promise((resolve, reject) => {
    http.get(service.origin + '/api/session', { headers: { ...headers, Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(service.origin + '/api/login', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' } })).status, 403);
  await service.stop();
  assert.equal(service.server.listening, false);
});

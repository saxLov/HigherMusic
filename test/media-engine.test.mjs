import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const script = await readFile(new URL('../public/media-engine.js', import.meta.url), 'utf8');
const core = await readFile(new URL('../public/player-core.js', import.meta.url), 'utf8');
function runtime(extra = {}) {
  const context = vm.createContext({ DOMException, AbortController, setTimeout, clearTimeout, ...extra });
  vm.runInContext(core, context); vm.runInContext(script, context);
  return context.HigherMedia;
}
function fake(id = 'alternative') {
  const state = { paused: true, volume: .7, rate: 1, position: 0, duration: 60, readyState: 4, ended: false, seeking: false, error: null };
  const listeners = new Set();
  return { id, name: id, capabilities: { seek: true, volume: true, rate: true, spectrum: false }, state,
    snapshot: () => ({ ...state }), subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    emit(type) { for (const callback of listeners) callback(type); }, count: () => listeners.size,
    async load({ url, signal }) { signal.throwIfAborted(); state.url = url; state.paused = false; this.emit('playing'); },
    async play() { state.paused = false; this.emit('playing'); }, pause() { state.paused = true; this.emit('pause'); },
    stop() { state.paused = true; state.url = ''; this.stopped = true; }, dispose() { this.disposed = true; listeners.clear(); },
    seek(value) { state.position = value; this.emit('seeked'); }, setVolume(value) { state.volume = value; }, setRate(value) { state.rate = value; },
  };
}
test('替代引擎通过相同命令/事件/状态工作，替换继承音量、解绑旧事件，释放可重复调用', async () => {
  const { EngineHost } = runtime(), first = fake('first'), second = fake('second');
  const host = new EngineHost(first); let played = 0, changed = 0;
  host.addEventListener('playing', () => played++); host.addEventListener('enginechange', () => changed++);
  await host.load('/api/proxy?ticket=' + 'a'.repeat(48));
  assert.equal(played, 1); host.volume = .4; host.playbackRate = 1.5; host.currentTime = 100;
  assert.equal(first.state.position, 60);
  const snapshot = host.snapshot(); assert.ok(Object.isFrozen(snapshot));
  host.replace(second); first.emit('playing');
  assert.equal(first.count(), 0); assert.equal(first.disposed, true);
  assert.equal(second.state.volume, .4); assert.equal(second.state.rate, 1.5);
  assert.equal(host.paused, true); assert.equal(host.src, undefined); assert.equal(changed, 1);
  await host.play(); assert.equal(played, 2); assert.equal(host.info.id, 'second');
  assert.equal(host.readSpectrum(), null); host.dispose(); host.dispose();
  assert.equal(second.count(), 0); await assert.rejects(host.play(), /已释放/);
});
test('旧加载和迟到完成不能越过取消/换核；无效替代不会破坏原引擎', async () => {
  const { EngineHost } = runtime(), first = fake(); let finish;
  first.load = () => new Promise(resolve => { finish = resolve; });
  const host = new EngineHost(first);
  const pending = host.load('ticket'); const rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.throws(() => host.replace({ id: 'broken' }), /接口/); assert.equal(host.info.id, first.id);
  host.replace(fake('replacement')); finish(); await rejected;
  assert.equal(host.paused, true); host.dispose();
});
test('事件 once、abort、解绑和可选能力按统一接口生效', () => {
  const { EngineHost } = runtime(), adapter = fake(), host = new EngineHost(adapter);
  let once = 0, aborted = 0; const control = new AbortController();
  host.addEventListener('playing', () => once++, { once: true });
  host.addEventListener('playing', () => aborted++, { signal: control.signal }); control.abort();
  adapter.emit('playing'); adapter.emit('playing'); assert.equal(once, 1); assert.equal(aborted, 0);
  adapter.capabilities.seek = false; host.currentTime = 20; assert.equal(adapter.state.position, 0);
  host.volume = 2; assert.equal(host.volume, 1); host.volume = NaN; assert.equal(host.volume, 1);
  host.dispose();
});
test('不响应取消的加载也会在主机边界及时拒绝；超时独立归类', async () => {
  const { EngineHost } = runtime(), adapter = fake(); adapter.load = () => new Promise(() => {});
  const host = new EngineHost(adapter), control = new AbortController();
  const pending = host.load('ticket', control.signal); control.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(adapter.stopped, true);
  await assert.rejects(host.load('ticket', undefined, 30, 5), { mediaCode: 'timeout' });
  const early = new AbortController(); early.abort();
  await assert.rejects(host.load('ticket', early.signal), { name: 'AbortError' }); host.dispose();
});
test('新引擎准备失败保留旧订阅和播放控制', async () => {
  const { EngineHost } = runtime(), first = fake('first'), candidate = fake('candidate');
  const host = new EngineHost(first); candidate.subscribe = () => { throw new Error('initialize'); };
  assert.throws(() => host.replace(candidate), /initialize/);
  assert.equal(candidate.disposed, true); assert.equal(first.count(), 1); assert.equal(host.info.id, 'first');
  await host.play(); assert.equal(host.paused, false); host.dispose();
});
class Media extends EventTarget {
  constructor() { super(); this.paused = true; this.duration = 30; this.currentTime = 0; this.volume = .7; this.playbackRate = 1; this.readyState = 4; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  play() { this.paused = false; queueMicrotask(() => { this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('playing')); }); return Promise.resolve(); }
  load() { this.dispatchEvent(new Event('emptied')); }
  removeAttribute() { this.src = ''; }
}
test('HTML 适配器只接收网关票据、验证时长；取消卸载媒体，自动播放限制保留再播放能力', async () => {
  const { EngineHost, createHtmlAudioEngine } = runtime(); const element = new Media();
  const host = new EngineHost(createHtmlAudioEngine(element)), ticket = '/api/proxy?ticket=' + 'a'.repeat(48);
  await assert.rejects(host.load('https://external.invalid/audio'), /本地网关/);
  await host.load(ticket, undefined, 30); assert.equal(host.paused, false);
  host.stop(); assert.equal(element.src, '');
  element.duration = 10; await assert.rejects(host.load(ticket, undefined, 30), { mediaCode: 'duration' });
  element.duration = 30;
  element.play = async () => { throw new DOMException('gesture', 'NotAllowedError'); };
  await assert.rejects(host.load(ticket, undefined, 30), { name: 'NotAllowedError' }); assert.equal(element.src, ticket);
  element.play = () => new Promise(() => {});
  const control = new AbortController(); const pending = host.load(ticket, control.signal, 30); control.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(element.src, ''); host.dispose();
});
test('频谱归引擎管理，只建立一条输出通路，销毁关闭 AudioContext', async () => {
  let contexts = 0, outputs = 0, closed = 0;
  class Context {
    constructor() { contexts++; this.destination = {}; this.sampleRate = 48000; }
    createMediaElementSource() { return { connect: target => { if (target === this.destination) outputs++; }, disconnect() {} }; }
    createAnalyser() { return { frequencyBinCount: 8, fftSize: 2048, getByteFrequencyData: data => data.fill(3), disconnect() {} }; }
    async close() { closed++; }
  }
  const { EngineHost, createHtmlAudioEngine } = runtime({ AudioContext: Context });
  const host = new EngineHost(createHtmlAudioEngine(new Media()));
  await host.enableSpectrum(); await host.enableSpectrum();
  assert.equal(contexts, 1); assert.equal(outputs, 1); assert.equal(host.readSpectrum().data[0], 3);
  host.dispose(); assert.equal(closed, 1);
});

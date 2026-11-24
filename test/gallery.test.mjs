/* 自动检查：画廊与前端交互：九张卡片挂载、十八槽位轮换复用、封面竞态、快闪、背景持久化、歌词偏移与视图切换。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { coverUrl, backgroundFile } from '../lib/gallery.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="\/(.*?)"\s+defer\s*>/g)]
  .map(match => match[1]).filter(file => !['desktop.js', 'visualizer.js', 'settings-panel.js', 'gallery-modes.js'].includes(file));
const script = (await Promise.all(scripts.map(file =>
  readFile(new URL('../public/' + file, import.meta.url), 'utf8')))).join('\n');
/* 前端测试环境：用最小 DOM、图片、媒体、localStorage 和计时器替身执行真实 app.js。
 * frames 记录快闪歌名，delays 记录等待毫秒数；测试加速等待，不衡量真实屏幕动画观感。 */
function harness({ autoImages = true, savedOffset } = {}) {
  const storage = new Map(
      savedOffset === undefined ? [] : [['higherweb.lyricOffset.v1', savedOffset]],
    ),
    delays = [],
    frames = [],
    images = [],
    rafs = new Map();
  let rafId = 0;
  /* 最小 DOM/音频元素替身：只实现 app.js 使用的 API；不负责浏览器布局和真实音频解码。 */
  class Element extends EventTarget {
    constructor() {
      super();
      this.style = { setProperty() {} };
      this.dataset = {};
      const classes = new Set();
      this.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const next = force ?? !classes.has(c);
          if (next) classes.add(c);
          else classes.delete(c);
          return next;
        },
      };
      this.children = [];
      this.value = '';
      this.hidden = false;
      this.paused = true;
      this.duration = 240;
      this.currentTime = 0;
    }
    set src(value) {
      this.source = value;
      this.complete = true;
      this.naturalWidth = 500;
      queueMicrotask(() => this.onload?.());
    }
    get src() {
      return this.source || '';
    }
    decode() {
      return Promise.resolve();
    }
    set textContent(value) {
      this.text = value;
      if (this.id === 'flashTitle') frames.push(value);
    }
    get textContent() {
      return this.text || '';
    }
    querySelector(selector) {
      this.parts ??= {};
      return (this.parts[selector] ??= new Element());
    }
    append(...rows) {
      this.children.push(...rows);
    }
    replaceChildren(...rows) {
      this.children = rows;
    }
    add(row) {
      this.children.push(row);
    }
    setAttribute() {}
    removeAttribute(name) {
      if (name === 'src') {
        this.source = '';
        this.complete = false;
      }
    }
    before() {}
    load() {}
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
      this.onpause?.();
    }
    play() {
      this.paused = false;
      queueMicrotask(() => {
        this.dispatchEvent(new Event('playing'));
        this.onplaying?.();
      });
      return Promise.resolve();
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    focus() {}
  }
  const elements = new Map(),
    cards = Array.from({ length: 9 }, () => new Element());
  const get = (id) => {
    if (!elements.has(id)) {
      const e = new Element();
      e.id = id;
      elements.set(id, e);
    }
    return elements.get(id);
  };
  /* 隔离执行上下文：注入模拟浏览器 API，让测试直接检查真实脚本中的状态和函数。 */
  const context = vm.createContext({
    console,
    AbortController,
    DOMException,
    Event,
    Image: class {
      set src(value) {
        this.source = value;
        images.push(this);
        if (autoImages) queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.source;
      }
      decode() {
        return Promise.resolve();
      }
    },
    Option: class {},
    performance,
    queueMicrotask,
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789012" },
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return ms >= 10000 ? 0 : setTimeout(fn, 0);
    },
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    location: { protocol: 'http:' },
    requestAnimationFrame: (fn) => {
      rafs.set(++rafId, fn);
      return rafId;
    },
    cancelAnimationFrame: (id) => rafs.delete(id),
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    document: {
      dispatchEvent() {},
      getElementById: get,
      querySelectorAll: (s) => (s === '.card' ? cards : []),
      querySelector: (s) => (s === 'dialog[open]' ? null : get(s)),
      body: get('body'),
      addEventListener() {},
      createElement: () => new Element(),
    },
    fetch: async () => ({ ok: true, json: async () => ({ ready: true, user: null }) }),
  });
  /* 执行项目当前 app.js 后返回查询工具；run 可在同一上下文读写内部状态，便于验证竞态。 */
  vm.runInContext('globalThis.testMedia = document.getElementById("audio")', context);
  vm.runInContext(script, context);
  return {
    run: (code) => vm.runInContext(code, context),
    elements,
    get,
    cards,
    delays,
    frames,
    storage,
    images,
    rafs,
    stepFrame: () => {
      const pending = [...rafs.values()];
      rafs.clear();
      for (const fn of pending) fn();
    },
  };
}
/* 等待一轮异步回调，使图片解码或事件微任务先完成，再断言最终状态。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('随机远跳也将相邻节点移入中心，不再按歌曲索引距离取消动画', async () => {
  const h = harness();
  h.run("songs=Array.from({length:129},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=5;renderGallery();playCurrent=async()=>{};$('mode').value='shuffle';playbackQueue.setMode('shuffle');playbackQueue.random=()=>.9;playbackQueue.select('5')");
  const incoming=h.run('cards[5]');
  h.run('advance(1)');
  assert.ok(h.run('index')>100);
  assert.equal(h.run('cards[4]'),incoming);
  assert.equal(h.cards.length,9);
});

test('右侧翻组只改变浏览中心，保留音频、播放索引、歌词和会话版本', async () => {
  const h=harness();
  h.run("songs=Array.from({length:129},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=12;renderGallery();testMedia.src='/api/proxy?ticket=fixture';testMedia.currentTime=17;$('lyricCurrent').textContent='当前歌词';playCurrent=async()=>{throw Error('翻页不应播放')}");
  const version=h.run('playbackSession.version');
  h.get('galleryNext').onclick();
  assert.equal(h.run('galleryCenter()'),17);
  assert.equal(h.run('index'),12);
  assert.equal(h.run('playbackSession.version'),version);
  assert.equal(h.run('audio.currentTime'),17);
  assert.equal(h.get('lyricCurrent').textContent,'当前歌词');
  assert.equal(h.run('cards[4]').querySelector('h1').textContent,'歌曲17');
  h.get('galleryPrevious').onclick();assert.equal(h.run('galleryCenter()'),12);
  h.get('galleryNext').onclick();h.get('galleryReturn').onclick();
  assert.equal(h.run('galleryCenter()'),12);assert.equal(h.run('index'),12);
});

test('浏览中的封面按展示歌曲选择，换歌单使旧浏览锚点失效', async () => {
  const h=harness();
  h.run("songs=Array.from({length:20},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=3;renderGallery();playCurrent=async()=>{};browseGalleryPage(1);selectGalleryCard(1)");
  assert.equal(h.run('index'),9);assert.equal(h.run('galleryBrowse'),null);
  h.run('browseGalleryPage(1);viewVersion++;index=0;renderGallery()');
  assert.equal(h.run('galleryCenter()'),0);assert.equal(h.run('galleryBrowse'),null);
});

test('同一展墙的异步刷新不再关闭正在进行的位移过渡', async () => {
  const h=harness();
  h.run("songs=Array.from({length:10},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=2;renderGallery();playCurrent=async()=>{};goTo(3,true,1)");
  let disabled=0;
  const rail=h.get('rail'),original=rail.classList.add;
  rail.classList.add=cls=>{if(cls==='no-transition')disabled++;original(cls)};
  h.run('renderGallery()');assert.equal(disabled,0);
  h.run('browseGalleryPage(1)');assert.equal(disabled,1);
});

test('慢歌词请求不阻塞下一次播放，迟到歌词与诊断不覆盖新歌', async () => {
  const h = harness();
  await flush();
  h.run(`
    let releaseLyric, lyricNotes = [];
    fetch = async (url) => {
      if (url.includes('/lyrics?')) return new Promise(resolve => { releaseLyric = resolve; });
      return { ok: true, json: async () => ({ ok: true }) };
    };
    playbackSession.version = 10;
    const lyricPending = loadLyrics({id:'old'}, 10, line => lyricNotes.push(line));
  `);
  await flush();
  assert.equal((await h.run("request('play?track=new', 'POST')")).ok, true);
  h.run(`
    playbackSession.version = 11;
    resetLyrics('新歌歌词');
    releaseLyric({ok:true, json:async()=>({lyrics:'[00:00]旧歌歌词', attempts:[{provider:'kugou',outcome:'ready'}]})});
  `);
  await h.run('lyricPending');
  assert.equal(h.get('lyricCurrent').textContent, '新歌歌词');
  assert.equal(h.run('lyricNotes.length'), 0);
});

test('歌词服务失败显示可重试文案与诊断，不修改播放来源；拖动仍同步', async () => {
  const h = harness();
  await flush();
  h.run(`
    let lyricNotes = [];
    playbackSession.version = 12;
    $('currentSource').textContent = '当前音源：酷狗';
    fetch = async () => ({ok:true,json:async()=>({state:'unavailable',lyrics:'',attempts:[{provider:'kugou',outcome:'failed',httpStatus:403,platformCode:123}]})});
  `);
  await h.run("loadLyrics({id:'1'},12,line=>lyricNotes.push(line))");
  assert.match(h.get('lyricCurrent').textContent, /重试/);
  assert.match(h.run('lyricNotes[0]'), /HTTP 403.*123/);
  h.run(`fetch = async () => ({ok:true,json:async()=>({state:'ready',provider:'netease',lyrics:'[00:00]开始\\n[00:10]第二句',attempts:[{provider:'netease',outcome:'ready'}]})});`);
  await h.run("loadLyrics({id:'1'},12,line=>lyricNotes.push(line))");
  h.run('audio.currentTime = 12; updateLyrics();');
  assert.equal(h.get('lyricCurrent').textContent, '第二句');
  assert.equal(h.get('currentSource').textContent, '当前音源：酷狗');
});
test('单文件语法正确并且主画廊永久只有九张卡片', () => {
  assert.equal((html.match(/<figure\b/g) || []).length, 9);
  assert.doesNotThrow(() => harness());
});
test('同步开关默认开启并持久化；账号退出取消排队历史', async () => {
  const h = harness();
  assert.equal(h.get('historySync').checked, true);
  h.run("$('historySync').checked=false;$('historySync').onchange()");
  assert.equal(h.storage.get('higherweb.historySync.v1'), 'false');
  assert.equal(h.run('listening.enabled'), false);
  h.run("$('historySync').checked=true;$('historySync').onchange();songs=[{id:'a',hash:'a'.repeat(32)}];listening.begin(songs[0],audio)");
  const pending = h.run("listening.send({songId:'a',hash:'a'.repeat(32),playbackId:listening.round.playbackId}).catch(e=>e.name)");
  h.run('listening.cancelPending();stopAudio()');
  assert.equal(await pending, 'AbortError');
});
test('选择歌单只更新预览列表，不更改活动画廊或自动打开列表', async () => {
  const h = harness();
  await flush();
  h.run("globalThis.requested=[];globalThis.fetch=async(url)=>{requested.push(url);return {ok:true,json:async()=>url.includes('inspect')?{state:'allowed',playbackState:'allowed',playable:true}:{tracks:[{id:'a',title:'A',inspection:{state:'unknown'}},{id:'b',title:'B'}]}}};$('playlists').value='1'");
  await h.run('selectPlaylist()');
  assert.equal(h.run('JSON.stringify(requested)'), '["/api/tracks?playlist=1"]');
  assert.equal(h.run('songs.length'), 0);
  assert.equal(h.run('rawTracks.length'), 0);
  assert.equal(h.run('browsePlaylist.tracks.length'), 2);
  assert.equal(h.run('rejected.length'), 0);
  assert.equal(h.get('playlistBrowser').open, undefined);
  assert.equal(h.get('playlistBrowseList').children.length, 2);
});
test('全量检查完成后顶部重新检查会真正请求，并刷新一次账号权益', async () => {
  const h = harness();
  await flush();
  h.run("rawTracks=[{id:'a',hash:'a',title:'A',cover:'https://example.com/a.jpg'},{id:'b',hash:'b',title:'B',cover:'https://example.com/b.jpg'}];checkedIds.add('a');checkedIds.add('b');globalThis.requested=[];globalThis.fetch=async(url)=>{requested.push(url);return {ok:true,json:async()=>({state:'allowed',playbackState:'allowed',playable:true})}};$('check').onclick()");
  for (let n = 0; n < 8; n++) await flush();
  assert.equal(h.run('JSON.stringify(requested)'), '["/api/inspect?track=a&fresh=1&accountFresh=1","/api/inspect?track=b&fresh=1"]');
});

test('已达标历史排在慢检查后，正常下一首不会取消原歌曲的提交', async () => {
  const h = harness();
  await flush();
  h.run("songs=[{id:'a',title:'A',hash:'a'.repeat(32)},{id:'b',title:'B',hash:'b'.repeat(32)}];index=0;listening.begin(songs[0],audio);globalThis.reports=[];globalThis.fetch=(url,options)=>url.includes('slow')?new Promise(resolve=>globalThis.release=resolve):Promise.resolve({ok:true,json:async()=>{if(url.includes('report_history'))reports.push(JSON.parse(options.body));return {ok:true,accepted:true}}});playCurrent=async()=>{}");
  const blocker = h.run("request('inspect?track=slow','POST')");
  await flush();
  const report = h.run("listening.send({songId:'a',hash:'a'.repeat(32),playbackId:listening.round.playbackId})");
  h.run("goTo(1,false);release({ok:true,json:async()=>({})})");
  await blocker;
  await report;
  assert.equal(h.run('reports.length'), 1);
  assert.equal(h.run('reports[0].songId'), 'a');
  assert.equal(h.run('index'), 1);
});

test('8秒中断后自动恢复保留轮次和累计时间，再听8秒只上报一次', async () => {
  const h = harness();
  await flush();
  h.run("songs=[{id:'a',title:'A',hash:'a'.repeat(32)}];index=0;playbackSession.begin(songs[0],{}).phase='started';testMedia.paused=false;testMedia.readyState=4;audio.currentTime=8;globalThis.clock=0;listening.now=()=>clock;listening.begin(songs[0],audio);listening.round.seconds=8;globalThis.originalRound=listening.round;globalThis.reports=[];loadSource=async()=>{testMedia.paused=false;audio.currentTime=0};globalThis.fetch=async(url,options)=>({ok:true,json:async()=>{if(url.includes('report_history')){reports.push(JSON.parse(options.body));return {ok:true,accepted:true}}return {state:'allowed',playbackState:'allowed',url:'/api/audio?ticket='+'a'.repeat(48),expectedDuration:240}}})");
  await h.run('playCurrent(8,true)');
  assert.equal(h.run('listening.round === originalRound'), true);
  assert.equal(h.run('listening.round.seconds'), 8);
  assert.equal(h.run('audio.currentTime'), 8);
  for (let n = 0; n < 8; n++) h.run('clock+=1000;audio.currentTime+=1;listening.tick(audio)');
  for (let n = 0; n < 4; n++) await flush();
  assert.equal(h.run('reports.length'), 1);
  assert.equal(h.run('reports[0].playbackId === originalRound.playbackId'), true);
  await h.run('playCurrent(16,true)');
  for (let n = 0; n < 8; n++) h.run('clock+=1000;audio.currentTime+=1;listening.tick(audio)');
  await flush();
  assert.equal(h.run('reports.length'), 1);
});

test('自动定位不算用户拖动，真实拖动仍永久取消本轮', () => {
  const h = harness();
  h.run("songs=[{id:'a',hash:'a'.repeat(32)}];testMedia.paused=false;listening.begin(songs[0],audio);automaticSeek={version:playbackSession.version,target:8};audio.currentTime=8;audio.dispatchEvent(new Event('seeking'))");
  assert.equal(h.run('listening.round.invalid'), false);
  h.run("automaticSeek=null;audio.currentTime=60;audio.dispatchEvent(new Event('seeking'))");
  assert.equal(h.run('listening.round.invalid'), true);
});
test('中途故障最多恢复一次并携带进度，切歌后旧恢复任务失效', async () => {
  const h = harness();
  h.run("songs=[{id:'a'}];playbackSession.begin(songs[0],{}).phase='started';testMedia.paused=false;audio.currentTime=27;globalThis.restores=[];playCurrent=async(...args)=>restores.push(args);scheduleRecovery(true)");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('JSON.stringify(restores)'), '[[27,true]]');
  h.run('scheduleRecovery(true)');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('restores.length'), 1);
  h.run('playbackSession.current.recoveryAttempts=0;scheduleRecovery(true);playbackSession.cancel()');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('restores.length'), 1);
});
test('清洗歌名歌手并保留同源封面票据；待确认和无音源不能进入画廊', () => {
  const h = harness();
  const cover = '/api/artwork?ticket=' + 'a'.repeat(64);
  const track = h.run(
    `cleanTrack({id:'a',title:'Aimer - Brave Shine.mp3',cover:'${cover}'},{url:'https://example.com/a',expectedDuration:234})`,
  );
  assert.equal(track.title, 'Brave Shine');
  assert.equal(track.artist, 'Aimer');
  assert.equal(track.cover, cover);
  assert.equal(h.run("cleanTrack({cover:'https://example.com/cover.png'}).cover"), '');
  assert.equal(
    h.run(
      "isPlayable({state:'unknown',playbackState:'unknown'},{audio:'https://example.com/a'})",
    ),
    false,
  );
  assert.equal(
    h.run("isPlayable({state:'allowed',playbackState:'allowed'},{audio:''})"),
    false,
  );
});
test('远距搜索只提交目标一次，动效期间不改播放索引并在结束后解除锁定', async () => {
  const h = harness();
  h.run(
    "songs=Array.from({length:129},(_,i)=>({id:String(i),title:'歌曲'+i,artist:'歌手',cover:''}));index=2;globalThis.started=[];playCurrent=async()=>started.push(index);globalThis.visual=[];HigherSpineJump.run=async options=>{visual.push({target:options.target,index,flashing});return true}",
  );
  await h.run('searchJumpTo(72)');
  assert.equal(h.run('JSON.stringify(visual)'), '[{"target":72,"index":2,"flashing":true}]');
  assert.equal(h.run('JSON.stringify(started)'), '[72]');
  assert.equal(h.run('index'), 72);
  assert.equal(h.run('flashing'), false);
  assert.equal(h.cards.length, 9);
});

test('书脊寻址采样最多十五首，包含真实目标且短歌单不重复', () => {
  const h=harness();
  for(const length of [0,1,8,129,10000]){
    const target=Math.max(0,length-2);
    const sample=h.run(`HigherSpineJump.rackIndices(${length},${target})`);
    assert.equal(sample.length,Math.min(15,length));assert.equal(new Set(sample).size,sample.length);
    if(length)assert.equal(sample[Math.floor(sample.length/2)],target);
  }
});

test('取消或退出后迟到的书脊动效不能提交目标或重新播放', async () => {
  const h=harness();
  h.run("songs=Array.from({length:129},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=2;globalThis.started=[];playCurrent=async()=>started.push(index);HigherSpineJump.run=()=>new Promise(r=>globalThis.finishSpines=r);globalThis.pendingJump=searchJumpTo(72)");
  assert.equal(h.run('flashing'),true);
  h.run('stopAudio();finishSpines(true)');await h.run('pendingJump');
  assert.equal(h.run('index'),2);assert.equal(h.run('started.length'),0);assert.equal(h.run('flashing'),false);
});

test('连续远距搜索只采纳最后一次，歌单版本变化后旧任务失效', async () => {
  const h=harness();
  h.run("songs=Array.from({length:129},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=2;globalThis.started=[];playCurrent=async()=>started.push(index);globalThis.finishers=[];HigherSpineJump.run=()=>new Promise(r=>finishers.push(r));globalThis.first=searchJumpTo(72);globalThis.second=searchJumpTo(95);finishers[0](true)");
  await h.run('first');assert.equal(h.run('index'),2);assert.equal(h.run('flashing'),true);
  h.run('finishers[1](true)');await h.run('second');assert.equal(h.run('JSON.stringify(started)'),'[95]');
  h.run('globalThis.stale=searchJumpTo(50);viewVersion++;finishers[2](true)');await h.run('stale');
  assert.equal(h.run('index'),95);assert.equal(h.run('started.length'),1);assert.equal(h.run('flashing'),false);
});

test('首尾相邻搜索继续复用邻居卡片；沉浸搜索保持原视图', async () => {
  const h=harness();
  h.run("songs=Array.from({length:129},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=128;renderGallery();playCurrent=async()=>{};HigherSpineJump.run=async()=>{throw Error('不应启动远距动效')}");
  const beforeCards=h.run('cards.slice()');
  const incomingText=h.run('cards[5].querySelector("h1").textContent');
  await h.run('searchJumpTo(0)');
  assert.equal(h.run('index'),0);
  // 相邻搜索只换内容不重建节点：重建会让封面重新解码，滑动时可见闪烁
  const afterCards=h.run('cards.slice()');
  assert.ok(afterCards.every(card=>beforeCards.includes(card)),'相邻搜索不应重建卡片节点');
  assert.equal(h.run('cards[4].querySelector("h1").textContent'),incomingText);
  h.run("document.body.classList.add('immersive')");
  await h.run('searchJumpTo(80)');
  assert.equal(h.run('index'),80);
  assert.equal(h.run("document.body.classList.contains('immersive')"),true);
});
test('自定义背景按稳定歌曲 ID 保存文件名，不存储图片数据，恢复默认会移除映射', async () => {
  const h = harness();
  h.run("songs=[{id:'a',title:'A'},{id:'b',title:'B'}];saveBackground('风景 图.jpg');");
  assert.equal(JSON.parse(h.storage.get('higherweb.backgrounds.v1')).a, '风景 图.jpg');
  h.run("index=1;saveBackground('second.webp');index=0;saveBackground('');");
  const map = JSON.parse(h.storage.get('higherweb.backgrounds.v1'));
  assert.equal(map.a, undefined);
  assert.equal(map.b, 'second.webp');
  assert.equal(h.run("safeImageName('../secret.png')"), false);
});
test('封面不构造第三方地址；背景文件接口拒绝路径穿越和可执行图片类型', async () => {
  assert.equal(coverUrl('javascript:bad'), '');
  assert.equal(coverUrl('http://example.com/{size}.jpg'), 'https://example.com/500.jpg');
  assert.equal(await backgroundFile('../secret.png'), null);
  assert.equal(await backgroundFile('script.svg'), null);
});

test('从自定义背景歌曲切到未设置背景的歌曲时恢复深色，不把专辑封面铺满背景', async () => {
  const h = harness();
  h.storage.set('higherweb.backgrounds.v1', JSON.stringify({ a: '风景 图.jpg' }));
  h.run(
    "songs=[{id:'a',title:'A',cover:'https://example.com/a.jpg'},{id:'b',title:'B',cover:'https://example.com/b.jpg'}];index=0;",
  );
  await h.run('setBackground()');
  const layers = ['bgA', 'bgB'].map((id) => h.get(id));
  assert.match(
    layers.find((e) => e.classList.contains('active')).style.backgroundImage,
    /\/Image169\//,
  );
  h.run('index=1;renderGallery()');
  await flush();
  assert.equal(layers.filter((e) => e.classList.contains('active')).length, 1);
  assert.equal(
    layers.find((e) => e.classList.contains('active')).style.backgroundImage,
    'none',
  );
  for (const id of ['bgA', 'bgB'])
    assert.doesNotMatch(h.get(id).style.backgroundImage, /example\.com/);
});

test('预加载首尾相邻封面；快速换绑时清掉旧图，迟到的旧请求不能覆盖新图', async () => {
  const h = harness({ autoImages: false });
  h.run(
    "songs=Array.from({length:3},(_,i)=>({id:String(i),title:'歌曲'+i,cover:'https://example.com/'+i+'.jpg'}));index=2;renderGallery();renderGallery();",
  );
  for (const n of [0, 1, 2])
    assert.equal(
      h.images.filter((x) => x.src === `https://example.com/${n}.jpg`).length,
      1,
    );
  const img = h.get('probe');
  img.src = 'old.jpg';
  img.classList.add('is-loaded');
  h.run("paintCover($('probe'),'https://example.com/old-late.jpg')");
  assert.equal(img.src, '');
  assert.equal(img.classList.contains('is-loaded'), false);
  h.run("paintCover($('probe'),'https://example.com/new.jpg')");
  h.images.find((x) => x.src.endsWith('/old-late.jpg')).onload();
  await flush();
  assert.equal(img.src, '');
  h.images.find((x) => x.src.endsWith('/new.jpg')).onload();
  await flush();
  assert.equal(img.src, 'https://example.com/new.jpg');
  assert.equal(img.classList.contains('is-loaded'), true);
});

test('封面下载失败保持占位并回退，不重新显示旧图片', async () => {
  const h = harness({ autoImages: false }),
    img = h.get('probe');
  img.src = 'old.jpg';
  h.run("paintCover($('probe'),'https://example.com/broken.jpg')");
  h.images.find((x) => x.src.endsWith('broken.jpg')).onerror();
  await flush();
  assert.equal(img.src, '');
  assert.equal(img.classList.contains('is-loaded'), false);
  h.images.find((x) => x.src.startsWith('data:')).onload();
  await flush();
  assert.match(img.src, /^data:image\/svg\+xml/);
  assert.equal(img.classList.contains('is-loaded'), true);
});

test('最后到第一首、第一首到最后都按指定方向平移，沿用相邻卡片且始终九张', async () => {
  const h = harness();
  h.run(
    "songs=Array.from({length:3},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=2;renderGallery();playCurrent=async()=>{};",
  );
  const beforeCards = h.run('cards.slice()');
  await h.run('goTo(wrapIndex(index+1),true,1)');
  assert.equal(h.run('index'), 0);
  assert.equal(h.run('cards[4].querySelector("h1").textContent'), '歌曲0');
  assert.equal(h.get('previous').disabled, false);
  assert.equal(h.get('next').disabled, false);
  await h.run('goTo(wrapIndex(index-1),true,-1)');
  assert.equal(h.run('index'), 2);
  assert.equal(h.run('cards[4].querySelector("h1").textContent'), '歌曲2');
  // 首尾平移只在既有槽位内换内容，节点必须复用，否则封面会重新解码闪一下
  const afterCards = h.run('cards.slice()');
  assert.ok(afterCards.every(card => beforeCards.includes(card)), '首尾平移不应重建卡片节点');
  assert.equal(h.cards.length, 9);
  assert.equal(h.run('cards[5].querySelector("h1").textContent'), '歌曲0');
});

test('顺序自然结束回到第一首；单曲循环仍重播当前曲；空歌单安全停止', async () => {
  const h = harness();
  h.run(
    "songs=[{id:'a',title:'A'},{id:'b',title:'B'}];index=1;playCurrent=async()=>{};advance(1,true);",
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('index'), 0);
  h.run("$('mode').value='single';advance(1,true)");
  assert.equal(h.run('index'), 0);
  h.run('songs=[];advance(-1);renderGallery()');
  assert.equal(h.run('wrapIndex(-1)'), -1);
  assert.equal(h.get('previous').disabled, true);
});

test('LRC 正负毫秒偏移与全局秒偏移叠加，逐帧同步并支持往回拖动', () => {
  const h = harness();
  h.run(
    "const parsed=parseLrc('[offset:+250]\\n[00:01.00]第一句\\n[00:02.00]第二句');lyricLines=parsed.lines;lrcOffset=parsed.offset;audio.currentTime=.9;testMedia.paused=false;startLyricSync();startLyricSync();",
  );
  assert.equal(h.rafs.size, 1);
  assert.equal(h.get('lyricCurrent').textContent, '♪');
  h.run('audio.currentTime=1.01');
  h.stepFrame();
  assert.equal(h.get('lyricCurrent').textContent, '第一句');
  h.run('audio.currentTime=2.01');
  h.stepFrame();
  assert.equal(h.get('lyricCurrent').textContent, '第二句');
  h.run('audio.currentTime=.1;audio.onseeked()');
  assert.equal(h.get('lyricCurrent').textContent, '♪');
  assert.equal(h.run("parseLrc('[offset:-120]\\n[00:01]句子').offset"), -0.12);
  h.run('audio.pause()');
  assert.equal(h.rafs.size, 0);
  h.run('testMedia.paused=false;startLyricSync();testMedia.ended=true');
  h.stepFrame();
  assert.equal(h.rafs.size, 0);
});

test('微调按钮每次恰好 0.1 秒，保存后刷新恢复，损坏设置使用默认值', () => {
  const h = harness({ savedOffset: '-0.7' });
  assert.equal(h.run('lyricOffset'), -0.7);
  h.run('lyricPlus.onclick();lyricPlus.onclick();lyricMinus.onclick()');
  assert.equal(h.run('lyricOffset'), -0.6);
  assert.equal(h.run('lyricOffsetOutput.textContent'), '-0.6s');
  assert.equal(h.storage.get('higherweb.lyricOffset.v1'), '-0.6');
  assert.equal(
    harness({ savedOffset: h.storage.get('higherweb.lyricOffset.v1') }).run(
      'lyricOffset',
    ),
    -0.6,
  );
  assert.equal(harness({ savedOffset: 'broken' }).run('lyricOffset'), -0.2);
});

test('图片和音频仍在加载时连续切歌立即更新索引，九节点固定并预取窗口外围', () => {
  const h = harness({ autoImages: false });
  h.run(
    "songs=Array.from({length:30},(_,i)=>({id:String(i),title:'歌曲'+i,cover:'https://example.com/'+i+'.jpg'}));index=10;renderGallery();playCurrent=async()=>{};playbackSession.begin(songs[index],{});advance(1);advance(1);advance(-1);",
  );
  assert.equal(h.run('index'), 11);
  assert.equal(h.run('cards[4]').querySelector('h1').textContent, '歌曲11');
  assert.equal(h.cards.length, 9);
  for (const n of [4, 5, 14, 15, 16])
    assert.ok(h.images.some((x) => x.src === `https://example.com/${n}.jpg`));
  assert.equal(h.run('sliding'), false);
});

test('切换沉浸模式不改变音频地址、播放状态或进度，唱臂随暂停联动', () => {
  const h = harness();
  h.run(
    "testMedia.src='https://example.com/song.mp3';audio.currentTime=37;testMedia.paused=false;toggleImmersive();",
  );
  assert.equal(h.run("document.body.classList.contains('immersive')"), true);
  assert.equal(h.get('audio').src, 'https://example.com/song.mp3');
  assert.equal(h.get('audio').currentTime, 37);
  assert.equal(h.get('audio').paused, false);
  h.run('audio.onplaying()');
  assert.equal(
    h.run("document.querySelector('.record-deck').classList.contains('is-playing')"),
    true,
  );
  h.run('audio.pause();toggleImmersive()');
  assert.equal(
    h.run("document.querySelector('.record-deck').classList.contains('is-playing')"),
    false,
  );
  assert.equal(h.run("document.body.classList.contains('immersive')"), false);
  assert.equal(h.get('audio').currentTime, 37);
});

test('近距离搜索平移后合并播放，不重复启动旧任务', async () => {
  const h = harness();
  h.run(
    "songs=[{id:'a',title:'A'},{id:'b',title:'B'}];let calls=0;playCurrent=async()=>{calls++};playTimer=setTimeout(()=>playCurrent(),120);",
  );
  await h.run('searchJumpTo(1)');
  assert.equal(h.run('index'), 1);
  await new Promise((resolve) => setTimeout(resolve, 260));
  // 跳转只应启动一次播放；旧的 120ms 计时器不得再触发第二次
  assert.equal(h.run('calls'), 1);
});

test('沉浸标题与歌手在右侧更新，同源音源凭据可清洗且拒绝任意相对路径', () => {
  const h = harness();
  h.run("songs=[{id:'a',title:'Brave Shine',artist:'Aimer'}];renderGallery()");
  assert.equal(h.get('immersiveTitle').textContent, 'Brave Shine');
  assert.equal(h.get('immersiveArtist').textContent, 'Aimer');
  const ticket = '/api/audio?ticket=' + 'a'.repeat(48);
  assert.equal(h.run(`cleanTrack({id:'a'},{url:'${ticket}'}).audio`), ticket);
  assert.equal(h.run("cleanTrack({id:'a'},{url:'/somewhere'}).audio"), '');
  assert.doesNotMatch(html, /<svg\s+class="tonearm"/);
  assert.match(html, /id="musicSpectrum"/);
});

test('酷狗常规线路打不开时试授权线路，网易云高音质失败后再试标准音质', async () => {
  const h = harness();
  await flush();
  h.run(`songs=[{id:'test',title:'测试曲'}];
    globalThis.routes=[];
    globalThis.fetch=async url=>{
      routes.push(url);
      const netease=url.includes('alternate=1')||url.includes('retry=standard');
      const standard=url.includes('retry=standard');
      const token=standard?'d':netease?'c':url.includes('authorized')?'b':'a';
      return {ok:true,json:async()=>({state:'allowed',playbackState:'allowed',
        url:'/api/audio?ticket='+token.repeat(48),
        quality:netease?(standard?'128k':'FLAC'):undefined,
        playbackSource:{provider:netease?'netease':'kugou',name:netease?'网易云':'酷狗',fallback:netease}
      })};
    };
    loadSource=async url=>{if(!url.endsWith('d'.repeat(48)))throw Error('线路失败')};
  `);
  await h.run('playCurrent()');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(routes.filter(url=>url.startsWith("/api/play?")))')), [
    '/api/play?track=test','/api/play?track=test&retry=authorized',
    '/api/play?track=test&alternate=1','/api/play?track=test&retry=standard',
  ]);
  assert.equal(h.get('currentSource').textContent, '当前音源：网易云（备用） · 128k');
  assert.equal(h.run('listening.round'), null);
});

test('酷狗 CDN 明确拒绝后直接切到网易云，同一轮不确认酷狗起播', async () => {
  const h = harness();
  await flush();
  h.run(`songs=[{id:'test',title:'测试曲'}];
    globalThis.routes=[];
    globalThis.fetch=async url=>{
      routes.push(url);
      if(url.includes('audio-status') && url.endsWith('a'.repeat(48)))
        return {ok:true,json:async()=>({failure:{code:'http',status:403}})};
      const alternate=url.includes('alternate=1');
      return {ok:true,json:async()=>({state:'allowed',playbackState:'allowed',
        url:'/api/proxy?ticket='+(alternate?'b':'a').repeat(48), playbackToken:'fixture',
        playbackSource:{provider:alternate?'netease':'kugou',name:alternate?'网易云':'酷狗',history:!alternate}
      })};
    };
    loadSource=async url=>{if(url.endsWith('a'.repeat(48)))throw Error('线路失败')};
  `);
  await h.run('playCurrent()');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(routes.filter(url=>url.startsWith("/api/play?")))')), [
    '/api/play?track=test','/api/play?track=test&alternate=1',
  ]);
  assert.equal(h.run('routes.filter(url => url === "/api/play-started").length'), 1);
  assert.equal(h.run('routes.includes("/api/report_history")'), false);
  assert.equal(h.run('listening.round'), null);
});

test('顺序播放跳过不可播歌曲，整队失败后停止，不重新循环', async () => {
  const h = harness();
  await flush();
  h.run(`songs=[{id:'a',title:'A'},{id:'b',title:'B'}];
    $('mode').value='sequence';globalThis.routes=[];
    globalThis.fetch=async url=>{
      routes.push(url);
      return {ok:true,json:async()=>({state:'unknown',playbackState:'unknown',reason:'模拟失败'})};
    };
  `);
  await h.run('playCurrent()');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(routes.filter(url=>url.startsWith("/api/play?")))')),
    ['/api/play?track=a', '/api/play?track=b']);
  assert.match(h.get('status').textContent, /队列暂时没有可播放/);
  assert.match(h.get('playbackDiagnosticsText').textContent, /A · 模拟失败/);
  assert.equal(h.run('songs.length'), 0);
  assert.equal(h.run('rejected.map(song=>song.id).join()'), 'a,b');
});


test('待确认单曲刷新按钮更新原歌单，并明确提示购买查询未完成', async () => {
  const h = harness(); await flush();
  h.run("rawTracks=[{id:'a',title:'A'}];rejected=[{id:'a',title:'A',eligible:true,entitlement:'purchased',reason:'已购',diagnostics:[{stage:'standard_url',outcome:'wrong_recording'}]}];renderRejected();globalThis.requested=[];globalThis.fetch=async(url)=>{requested.push(url);return {ok:true,json:async()=>({state:'allowed',eligibilityState:'allowed',eligible:true,entitlement:'purchased',playbackState:'allowed',playable:true,refreshIncomplete:true})}};");
  const row=h.get('rejectedList').children[0];
  assert.match(row.children[3].children[1].textContent,/标识/);
  row.children[2].children[1].onclick();
  for(let i=0;i<8;i++) await flush();
  assert.match(h.run('JSON.stringify(requested)'),/accountFresh=1/);
  assert.equal(h.run('rawTracks[0].inspection.entitlement'),'purchased');
  assert.equal(h.run('rejected.length'),0);
  assert.match(h.get('status').textContent,/部分刷新未完成/);
});


test('预览B保留A画廊与播放会话，选中后明确进入才提交全部歌曲',async()=>{
  const h=harness();await flush();
  h.run("globalThis.window=globalThis;playlistRows=[{id:'A',name:'A'},{id:'B',name:'B'}];activePlaylistId='A';rawTracks=[{id:'a',title:'A song'}];songs=[cleanTrack(rawTracks[0])];index=0;globalThis.before=playbackSession.version;globalThis.fetch=async()=>({ok:true,json:async()=>({tracks:[{id:'b1',title:'B one'},{id:'b2',title:'B two',inspection:{sourceChecked:true,playable:false}}]})});$('playlists').value='B'");
  await h.run('selectPlaylist()');
  assert.equal(h.run('songs[0].id'),'a');assert.equal(h.run('rawTracks[0].id'),'a');
  assert.equal(h.run('playbackSession.version===before'),true);
  h.run("Array.from($('playlistBrowseList').children).find(el => el.textContent.includes('B two'))?.onclick?.()");
  assert.equal(h.run('browsePlaylist.selected'),'b2');assert.equal(h.run('songs[0].id'),'a');
  await h.run('enterSelectedGallery()');
  assert.equal(h.run('activePlaylistId'),'B');assert.equal(h.run('songs.length'),2);
  assert.equal(h.run('songs[index].id'),'b2');assert.equal(h.run('playbackSession.current'),null);
});

test('快速预览B到C时迟到的B不能覆盖C，空歌单可明确进入',async()=>{
  const h=harness();await flush();
  h.run("globalThis.window=globalThis;globalThis.releaseB=null;globalThis.fetch=async url=>({ok:true,json:async()=>url.includes('playlist=B')?await new Promise(r=>releaseB=r):{tracks:[]}});$('playlists').value='B';globalThis.oldRead=selectPlaylist()");
  await flush();h.run("$('playlists').value='C'");await h.run('selectPlaylist()');
  h.run("releaseB({tracks:[{id:'b',title:'late'}]})");await h.run('oldRead');
  assert.equal(h.run('browsePlaylist.id'),'C');assert.equal(h.run('browsePlaylist.tracks.length'),0);
  await h.run('enterSelectedGallery()');assert.equal(h.run('activePlaylistId'),'C');assert.equal(h.run('songs.length'),0);
});

test('预览读取失败不替换活动歌曲，刷新检查保留画廊的未知和失败歌曲',async()=>{
  const h=harness();await flush();
  h.run("songs=[{id:'a',title:'A'}];rawTracks=[{id:'a',title:'A'}];activePlaylistId='A';globalThis.fetch=async()=>({ok:false,json:async()=>({error:'unavailable'})});$('playlists').value='B'");
  await h.run('selectPlaylist()');assert.equal(h.run('browsePlaylist.status'),'error');assert.equal(h.get('enterGallery').disabled,true);assert.equal(h.run('songs[0].id'),'a');
  h.run("rawTracks.push({id:'unknown',title:'Unknown'},{id:'bad',title:'Bad',inspection:{sourceChecked:true,playable:false}});refreshPlayableGallery()");
  assert.equal(h.run('songs.length'),3);
});

/* 页面共享状态、曲目模型与 API 客户端。 */
const API_BASE = ''; // 同源路径，无需修改域名或端口
// 单位：秒；按要求以 audio.currentTime + lyricOffset 比对，正数提前，负数延后。
/* 【可调参数】默认歌词偏移（秒）：负值延后、正值提前；浏览器已保存值优先于这里。 */
let lyricOffset = -0.2;
const LYRIC_OFFSET_KEY = 'higherweb.lyricOffset.v1';
try {
  const saved = HigherSettings.getItem(LYRIC_OFFSET_KEY);
  if (saved !== null && saved.trim() !== '' && Number.isFinite(Number(saved)))
    lyricOffset = Math.round(Number(saved) * 10) / 10;
} catch {}
/* 【DOM 工具】$ 按 id 查元素；audio 是唯一播放器，cards 保存九张卡片的当前逻辑排列。 */
const $ = (id) => document.getElementById(id);
const mediaEngine = new HigherMedia.EngineHost(HigherMedia.createHtmlAudioEngine($('audio')));
const audio = mediaEngine; // Existing UI names now refer to the engine host, never the DOM decoder.
const cards = [...document.querySelectorAll('.card')];
// 直接插入现有底栏，无需改动页面架构或增加外部组件。
const lyricAdjust = document.createElement('div');
lyricAdjust.className = 'lyric-adjust';
lyricAdjust.setAttribute('role', 'group');
lyricAdjust.setAttribute('aria-label', '歌词时间微调');
const lyricLabel = document.createElement('span');
lyricLabel.textContent = '歌词';
const lyricMinus = document.createElement('button');
lyricMinus.textContent = '−';
lyricMinus.setAttribute('aria-label', '歌词延后 0.1 秒');
lyricMinus.title = '歌词延后 0.1 秒';
const lyricOffsetOutput = document.createElement('output');
lyricOffsetOutput.setAttribute('aria-label', '歌词偏移秒数');
const lyricPlus = document.createElement('button');
lyricPlus.textContent = '+';
lyricPlus.setAttribute('aria-label', '歌词提前 0.1 秒');
lyricPlus.title = '歌词提前 0.1 秒';
lyricAdjust.append(lyricLabel, lyricMinus, lyricOffsetOutput, lyricPlus);
$('status').before(lyricAdjust);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/* 【封面占位】内嵌 SVG，无网络封面时显示；这是占位图，不是自定义全屏背景。 */
const FALLBACK =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#242525"/><circle cx="250" cy="250" r="145" fill="none" stroke="#555650"/><circle cx="250" cy="250" r="70" fill="none" stroke="#555650"/><text x="250" y="270" text-anchor="middle" fill="#97988f" font-size="50">♪</text></svg>',
  );
/* 【歌曲与版本状态】songs=可播放曲；rawTracks=原歌单；rejected=本次未入选。
 * index=当前曲；playbackSession.loadedId=已加载曲；view/play/loginVersion 分别隔离歌单、播放和扫码的迟到结果。 */
let activePlaylistId = '';
let songs = [],
  rawTracks = [],
  rejected = [],
  index = 0,
  viewVersion = 0,
  loginVersion = 0;
/* 【界面状态】busy=权限检查中；flashing=快闪中；playbackSession.loading=音频加载中。
 * sliding 当前预留为动画守卫；stopCheck 请求在当前检查结束后停止；bgVersion 隔离背景异步解码。 */
let busy = false,
  sliding = false,
  flashing = false,
  stopCheck = false,
  backgroundSide = 0,
  bgVersion = 0;
/* 【异步任务】API 队列在 api-client.js 中；playTimer 合并快速切歌。
 * wheelSum/wheelAt 累计滚轮距离与间隔；pollTimer 管扫码轮询。 */
let pollTimer,
  wheelSum = 0,
  wheelAt = 0;
/* 【歌词与随机历史】lyricLines=按时间排序的歌词；lyricIndex=-2 表示尚未渲染。
 * playbackQueue 统一维护成功播放历史与随机候选池。 */
let lyricLines = [],
  lyricIndex = -2,
  playlistRows = [];
/* lrcOffset 为 LRC 文件头偏移（秒）；lyricFrame 为逐帧回调句柄；playTimer 为延迟播放句柄。 */
let lrcOffset = 0,
  lyricFrame = 0,
  playTimer;
const playbackQueue = new HigherPlayer.PlaybackQueue();
const checkedIds = new Set();
// 仅用于服务端换源后的自动定位；用户拖动始终使本轮失效。
let automaticSeek = null;
const SYNC_KEY = 'higherweb.historySync.v1';
const listening = new HigherListening.ListeningTracker({
  send: (body, valid = () => true) => {
    const generation = listening.generation;
    return request(
      'report_history',
      'POST',
      () => listening.enabled && generation === listening.generation && valid(),
      { body, priority: 5 },
    );
  },
});
try { listening.setEnabled(HigherSettings.getItem(SYNC_KEY) !== 'false'); } catch {}
$('historySync').checked = listening.enabled;
$('historySync').onchange = () => {
  listening.setEnabled($('historySync').checked);
  if (listening.enabled && !audio.paused) listening.resume(audio);
  try { HigherSettings.setItem(SYNC_KEY, String(listening.enabled)); }
  catch { console.warn('听歌历史同步设置无法保存。'); }
};
document.defaultView?.addEventListener('storage', (event) => {
  if (event.key !== SYNC_KEY) return;
  listening.setEnabled(event.newValue !== 'false');
  $('historySync').checked = listening.enabled;
  if (listening.enabled && !audio.paused) listening.resume(audio);
});

/* 底栏提示、毫秒等待、秒转“分:秒”和网络图片 URL 规范化的轻量工具。 */
const status = (text) => ($('status').textContent = text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const time = (n) =>
  Number.isFinite(n)
    ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
    : '0:00';
const https = (value) =>
  typeof value === 'string' && /^https?:\/\//i.test(value)
    ? value.replace(/^http:/i, 'https:').replaceAll('{size}', '500')
    : '';

// 所有 fetch 都通过 API_BASE；串行请求避免现有后端的会话 busy 限制。
/* request()：统一调用 /api/。route 不带 /api/ 前缀；method 默认 GET；valid 在真正出队时校验任务是否仍有效。
 * 队列按优先级串行处理；出队前校验任务，失败不会阻断后续请求。 */
const request = HigherApi.createApiClient(API_BASE);
// 【数据清洗】四个统一展示字段 + 仅供业务使用的稳定 ID、时长等元数据。
/* cleanTrack()：将歌单 raw 与当次播放 result 合并成统一歌曲对象。
 * 拆分“歌手 - 歌名”、去扩展名、规范封面和音源；id 用于背景绑定与切歌校验，duration 的单位是秒。 */
function cleanTrack(raw, result = {}) {
  let title = String(raw.title || raw.name || raw.filename || '未命名歌曲')
    .replace(/\.(mp3|flac|wav|ogg)$/i, '')
    .trim();
  let artist = String(raw.artist || raw.singername || '').trim();
  if (!artist && title.includes(' - ')) {
    const parts = title.split(' - ');
    artist = parts.shift();
    title = parts.join(' - ');
  }
  const mediaUrl = (value) =>
    typeof value === 'string' && /^\/api\/(?:proxy|audio)\?ticket=[a-f0-9]{48}$/.test(value)
      ? value
      : https(value);
  const urls = [result.url, ...(Array.isArray(result.urls) ? result.urls : []), raw.audio]
    .map(mediaUrl)
    .filter(Boolean);
  return {
    title,
    artist: artist || '未知歌手',
    audio: urls[0] || '',
    cover: [result.cover, raw.cover].find((value) =>
      typeof value === 'string' && /^\/api\/(?:proxy|artwork)\?ticket=[a-f0-9]{64}$/.test(value)) || '',
    id: String(raw.id || raw.albumAudioId || raw.hash || ''),
    provider: raw.provider,
    hash: String(raw.hash || ''),
    urls: [...new Set(urls)],
    duration: Number(result.expectedDuration || raw.duration) || 0,
  };
}
/* isPlayable()：只有账号/播放结果均为 allowed 且存在音源，才允许进入可播放画廊；待确认不等于免费或已授权。 */
function isPlayable(result, track) {
  return (
    result.state === 'allowed' && result.playbackState === 'allowed' && (!!track.audio || result.playable === true)
  );
}

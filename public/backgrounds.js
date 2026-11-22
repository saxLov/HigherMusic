const BG_KEY = 'higherweb.backgrounds.v1';
/* readBackgroundMap()：读取 {歌曲稳定 ID: Image169 文件名}；存储损坏或不可读时返回空对象。 */
function readBackgroundMap() {
  try {
    const value = JSON.parse(HigherSettings.getItem(BG_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
/* safeImageName()：只接受没有路径分隔符的 png/jpg/jpeg/webp/avif 文件名，阻止前端传入任意路径。 */
function safeImageName(name) {
  return (
    typeof name === 'string' &&
    !/[\\/]/.test(name) &&
    /\.(png|jpe?g|webp|avif)$/i.test(name)
  );
}
/* imagePath()：把合法文件名编码为同源 /Image169/ 地址；空格和中文由 encodeURIComponent 处理。 */
function imagePath(name) {
  return API_BASE + '/Image169/' + encodeURIComponent(name);
}
const ambientPalettes = new Map();
let backgroundRequestKey = '';
let backgroundPaintKey = '';
function decodeBackgroundImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timeout = setTimeout(() => { img.onload = img.onerror = null; reject(Error('背景图片超时')); }, 3500);
    img.onload = async () => {
      try { await img.decode(); clearTimeout(timeout); img.onload = img.onerror = null; resolve(img); }
      catch (error) { clearTimeout(timeout); reject(error); }
    };
    img.onerror = () => { clearTimeout(timeout); reject(Error('背景图片不可用')); };
    img.src = url;
  });
}
async function coverMist(url) {
  if (!url || url === FALLBACK) return '';
  if (ambientPalettes.has(url)) return ambientPalettes.get(url);
  const task = (async () => {
    const loading = preloadCover(url);
    const cached = coverCache.get(url);
    await loading;
    const img = cached?.image || await decodeBackgroundImage(url);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 32, 32);
    return HigherAmbient.mist(HigherAmbient.palette(ctx.getImageData(0, 0, 32, 32).data));
  })();
  ambientPalettes.set(url, task);
  task.catch(() => { if (ambientPalettes.get(url) === task) ambientPalettes.delete(url); });
  while (ambientPalettes.size > 24) ambientPalettes.delete(ambientPalettes.keys().next().value);
  return task;
}
function paintBackground(paint, kind, version) {
  if (version !== bgVersion) return;
  const key = kind + ':' + paint;
  if (key === backgroundPaintKey) return;
  const next = backgroundSide ? $('bgA') : $('bgB'), old = backgroundSide ? $('bgB') : $('bgA');
  next.style.backgroundImage = paint || 'none';
  next.dataset.backgroundKind = kind;
  next.classList.add('active'); old.classList.remove('active');
  backgroundSide = 1 - backgroundSide; backgroundPaintKey = key;
}
/* 手动图片 > 封面取色 > 雅黑。异步结果只属于当前请求。 */
async function setBackground() {
  const song = songs[index], name = song ? readBackgroundMap()[song.id] : '';
  const key = JSON.stringify([song?.id, name, song?.cover]);
  document.body.classList.toggle('ambient-enabled', !!song);
  if (key === backgroundRequestKey) return;
  backgroundRequestKey = key;
  const version = ++bgVersion;
  if (!song) { paintBackground('', 'black', version); return; }
  // 清掉上一首的意境；准备新背景不阻塞音频。
  paintBackground('', 'black', version);
  if (safeImageName(name)) {
    try {
      const img = await decodeBackgroundImage(imagePath(name));
      paintBackground(`url("${img.src}")`, 'manual', version); return;
    } catch {}
  }
  if (version !== bgVersion) return;
  try { const paint = await coverMist(song.cover); paintBackground(paint, paint ? 'mist' : 'black', version); }
  catch { paintBackground('', 'black', version); }
}

/* saveBackground()：为当前歌曲保存文件名；空字符串表示清除映射。保存后更新背景并关闭选择框。 */
function saveBackground(name) {
  const song = songs[index];
  if (!song) return;
  const map = readBackgroundMap();
  if (name) map[song.id] = name;
  else delete map[song.id];
  try {
    HigherSettings.setItem(BG_KEY, JSON.stringify(map));
    setBackground();
    $('backgroundDialog').close();
    status(name ? '已为这首歌保存背景' : '已移除自选图片，使用封面雾色或雅黑');
  } catch {
    status('浏览器不允许保存本地背景设置');
  }
}
/* openBackgrounds()：向后端读取 Image169 目录并生成缩略图按钮，点击后调用 saveBackground。
 * 仅展示可用图片，不上传图片，也不会直接读取用户磁盘的任意文件夹。 */
async function openBackgrounds() {
  if (!songs[index]) return;
  $('backgroundDialog').showModal();
  $('backgroundOptions').replaceChildren();
  $('backgroundHint').textContent = '正在读取背景图片…';
  try {
    const d = await request('backgrounds');
    $('backgroundHint').textContent = d.images.length
      ? '为「' + songs[index].title + '」选择一张背景。'
      : (globalThis.higherDesktop ? '点击“导入图片”为当前歌曲设置背景。' : '请把横图放入 public/Image169 文件夹，再重新打开这里。');
    for (const name of d.images.filter(safeImageName)) {
      const button = document.createElement('button'),
        img = document.createElement('img'),
        label = document.createElement('span');
      img.src = imagePath(name);
      img.alt = '';
      img.loading = 'lazy';
      label.textContent = name;
      button.append(img, label);
      button.onclick = () => saveBackground(name);
      $('backgroundOptions').append(button);
    }
  } catch (e) {
    $('backgroundHint').textContent = e.message;
  }
}


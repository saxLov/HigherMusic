/* 画廊渲染、封面预加载和画廊手势。 */
// 有界预加载缓存：当前曲和前后曲共享同一次下载，不往画廊插入额外 DOM。
const coverCache = new Map();
// 仅右侧翻组使用独立浏览锚点，绝不把它写入播放索引或播放历史。
let galleryBrowse = null;
let lastGalleryLayout = '';
function galleryCenter() {
  if (galleryBrowse?.version === viewVersion && galleryBrowse.playlist === activePlaylistId) {
    const at = songs.findIndex(song => song.id === galleryBrowse.id);
    if (at >= 0) return at;
  }
  galleryBrowse = null;
  return index;
}
function browseGalleryPage(direction) {
  if (['spine', 'wall'].includes(globalThis.HigherGalleryModes?.mode)) {
    HigherGalleryModes.browse(direction);
    return;
  }
  if (songs.length <= 5 || flashing || document.body.classList.contains('immersive')) return;
  const at = wrapIndex(galleryCenter() + direction * 5);
  galleryBrowse = at === index ? null : { id: songs[at].id, version: viewVersion, playlist: activePlaylistId };
  renderGallery();
}
function returnToPlayingGallery() {
  galleryBrowse = null;
  renderGallery();
}
/* preloadCover()：按 URL 缓存一次封面加载 Promise；先下载并解码，成功后返回 URL。
 * 15 秒无响应视为失败；失败移出缓存可重试；最多保留 24 项，避免长歌单无限占用内存。 */
function preloadCover(url) {
  const key = url || FALLBACK;
  if (coverCache.has(key)) return coverCache.get(key);
  let decodedImage;
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    decodedImage = image;
    let timer;
    const clean = () => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
    };
    image.onload = async () => {
      try {
        await image.decode?.();
        clean();
        resolve(key);
      } catch (e) {
        clean();
        reject(e);
      }
    };
    image.onerror = () => {
      clean();
      reject(Error('封面加载失败'));
    };
    timer = setTimeout(() => {
      clean();
      reject(Error('封面加载超时'));
    }, 15000);
    image.src = key;
  });
  promise.image = decodedImage;
  coverCache.set(key, promise);
  promise.catch(() => {
    if (coverCache.get(key) === promise) coverCache.delete(key);
  });
  const coverLimit = ['wall','spine'].includes(globalThis.HigherGalleryModes?.mode) ? 48 : 24;
  while (coverCache.size > coverLimit) coverCache.delete(coverCache.keys().next().value);
  return promise;
}
/* wrapIndex()：把任意正负索引折回 0…songs.length-1，实现首尾循环；空歌单返回 -1。 */
function wrapIndex(value) {
  return songs.length ? ((value % songs.length) + songs.length) % songs.length : -1;
}
/* preloadNeighbors()：预取当前曲前后各 6 首的封面，超出列表边界时循环；只预加载图片，不创建额外卡片。 */
function preloadNeighbors() {
  if (songs.length)
    for (let offset = -6; offset <= 6; offset++)
      preloadCover(songs[wrapIndex(galleryCenter() + offset)].cover).catch(() => {});
}
/* paintCover()：给一个 img 绑定新封面，下载时先隐藏旧图。
 * 通过 coverVersion 丢弃迟到回调，防止快速切歌显示错封面；失败时回退 FALLBACK 占位。 */
function paintCover(img, url) {
  const key = url || FALLBACK;
  if (img.dataset.coverUrl === key) return;
  const version = String(Number(img.dataset.coverVersion || 0) + 1);
  img.dataset.coverVersion = version;
  img.dataset.coverUrl = key;
  img.onload = img.onerror = null;
  img.classList.remove('is-loaded');
  img.removeAttribute('src');
  /* 回调执行前确认图片仍绑定这一版本，防止旧图先后到达顺序不同造成串图。 */
  const current = () => img.dataset.coverVersion === version;
  const fail = () => {
    if (!current()) return;
    img.onload = img.onerror = null;
    if (key !== FALLBACK) paintCover(img, FALLBACK);
  };
  preloadCover(key).then(() => {
    if (!current()) return;
    const reveal = async () => {
      try {
        await img.decode?.();
        if (current()) img.classList.add('is-loaded');
      } catch {
        fail();
      }
    };
    img.onload = reveal;
    img.onerror = fail;
    img.src = key;
    if (img.complete && img.naturalWidth > 0) reveal();
  }, fail);
}
/* fillCard()：填充一张可复用卡片。offset 是相对当前曲的位置，范围通常为 -4…4。
 * data-offset 交给错落展墙样式定位；九个节点仍按前后歌曲循环复用。 */
function fillCard(card, offset) {
  const at = wrapIndex(galleryCenter() + offset),
    song = songs[at];
  card.style.setProperty('--offset', offset);
  card.dataset.offset = String(offset);
  card.dataset.trackId = song?.id || '';
  // 短歌单不重复展示同一曲；等距时保留负方向那张。
  const distinct = Math.abs(offset) <= Math.floor(songs.length / 2) &&
    !(songs.length % 2 === 0 && offset === songs.length / 2);
  const visible = !!song && distinct;
  card.style.visibility = visible ? 'visible' : 'hidden';
  card.setAttribute('aria-hidden', String(!visible || Math.abs(offset) > 2));
  const pick = card.querySelector('.gallery-pick');
  pick.tabIndex = visible && Math.abs(offset) <= 2 && !document.body.classList.contains('immersive') ? 0 : -1;
  pick.setAttribute('aria-label', song ? `播放 ${song.title} · ${song.artist}` : '没有歌曲');
  pick.onclick = event => { if (event.detail === 0) selectGalleryCard(offset); };
  const img = card.querySelector('img');
  paintCover(img, song?.cover);
  img.alt = song ? `${song.title} 封面` : '';
  card.querySelector('h1').textContent = song?.title || '';
  card.querySelector('p').textContent = song?.artist || '';
  let badge=card.querySelector('.gallery-source-state');
  if(!badge){badge=document.createElement('small');badge.className='gallery-source-state';card.append(badge);}
  const detail=rawTracks.find(t=>t.id===song?.id)?.inspection;
  badge.hidden=!(detail?.sourceChecked && !isPlayable(detail,{}));
  badge.textContent='音源暂不可用 · 可重试';
  card.querySelector('.number').textContent = song
    ? `${String(at + 1).padStart(2, '0')} / ${songs.length}`
    : '';
}
/* renderGallery()：刷新九张卡片、沉浸标题、唱片封面及当前背景。
 * reset=true 暂时关掉位移过渡，用于首次显示或直接跳转；false 保留 CSS 平移动画。 */
function renderGallery(reset = true) {
  updateGalleryMode();
  const layout = JSON.stringify([viewVersion, activePlaylistId, songs.length, songs[galleryCenter()]?.id]);
  // 异步检查/失败标记只更新同一张展墙，不应截断正在进行的位移动画。
  const reposition = reset && layout !== lastGalleryLayout;
  lastGalleryLayout = layout;
  const selected = songs[index];
  $('immersiveTitle').textContent = selected?.title || '选择你的第一首歌';
  $('immersiveArtist').textContent = selected?.artist || '你的私人音乐空间';
  $('recordNumber').textContent = '唱片 ' + String(index + 1).padStart(2, '0');
  $('immersiveTitle').title = selected?.title || '';
  if (reposition) $('rail').classList.add('no-transition');
  cards.forEach((card, i) => fillCard(card, i - 4));
  if (reposition) {
    void $('rail').offsetWidth;
    $('rail').classList.remove('no-transition');
  }
  $('rail').hidden = !songs.length;
  $('empty').hidden = !!songs.length;
  $('emptyText').textContent=activePlaylistId && !songs.length ? '这份歌单还没有歌曲。打开 Setting 可选择另一份歌单。' : '扫码连接酷狗，选择歌单，再点击进入画廊。';
  $('previous').disabled = $('next').disabled = !songs.length;
  $('toggle').disabled = !songs.length;
  $('backgroundOpen').disabled = !songs.length;
  preloadNeighbors();
  paintCover($('discCover'), songs[index]?.cover);
  setBackground();
  document.dispatchEvent(new Event('higher:queue-changed'));
}

function updateGalleryMode() {
  const active = !!songs.length && !document.body.classList.contains('immersive');
  document.body.classList.toggle('vertical-gallery', active);
  const browsing = galleryCenter() !== index;
  document.body.classList.toggle('gallery-browsing', browsing);
  $('galleryNavigation').hidden = !active;
  $('galleryPrevious').disabled = $('galleryNext').disabled = songs.length <= 5;
  $('galleryReturn').hidden = !browsing;
  $('galleryPrevious').title = '浏览前五首（不切换播放）';
  $('galleryNext').title = '浏览后五首（不切换播放）';
  $('galleryPrevious').textContent = '↑';
  $('galleryNext').textContent = '↓';
  $('galleryPrevious').setAttribute('aria-label', '浏览前五首');
  $('galleryNext').setAttribute('aria-label', '浏览后五首');
  document.querySelector('.hint').textContent = active ? '滚轮 / ↑ ↓ 切歌 · 拖动或点击封面 / I 搜索' : '滚轮切歌 / ← → / I 搜索';
}
function selectGalleryCard(offset) {
  if (!songs.length || flashing || document.body.classList.contains('immersive')) return;
  const center = galleryCenter();
  const target = wrapIndex(center + offset);
  if (target !== index) goTo(target, true, Math.sign(offset) || Math.sign(target - index));
  else {
    const browsing = center !== index;
    returnToPlayingGallery();
    if (!browsing) playbackCommand('toggle');
    else if (audio.paused) playbackCommand('play');
  }
}
$('galleryPrevious').onclick = () => browseGalleryPage(-1);
$('galleryNext').onclick = () => browseGalleryPage(1);
$('galleryReturn').onclick = returnToPlayingGallery;

/* 【沉浸自动隐去选项】仅在沉浸模式启用，停止操作 1000ms 后隐藏顶部选项和光标。
 * 复用单个计时器；移动、按键或操作控件立即唤醒，退出沉浸模式会取消计时并清除状态。
 * 弹窗、正在输入、键盘焦点与按住指针期间不隐藏，避免打断搜索、下拉选择或拖动进度条。 */
let immersiveIdleTimer = null;
let immersivePointerHeld = false;
function wakeImmersiveControls() {
  clearTimeout(immersiveIdleTimer);
  immersiveIdleTimer = null;
  document.body.classList.remove('controls-idle');
  if (!document.body.classList.contains('immersive') || document.hidden) return;
  immersiveIdleTimer = setTimeout(() => {
    immersiveIdleTimer = null;
    const focused = document.activeElement;
    const editing = focused?.matches('input,textarea,select,[contenteditable]');
    const keyboardControl = focused?.closest('header .tools') && focused.matches(':focus-visible');
    if (immersivePointerHeld || document.querySelector('dialog[open]') || editing || keyboardControl) return;
    document.body.classList.add('controls-idle');
  }, 1000);
}
document.addEventListener('pointermove', wakeImmersiveControls, { passive: true });
document.addEventListener('pointerdown', () => {
  immersivePointerHeld = true;
  wakeImmersiveControls();
}, { passive: true });
function releaseImmersivePointer() {
  immersivePointerHeld = false;
  wakeImmersiveControls();
}
document.addEventListener('pointerup', releaseImmersivePointer, { passive: true });
document.addEventListener('pointercancel', releaseImmersivePointer, { passive: true });
document.addEventListener('lostpointercapture', releaseImmersivePointer);
// 捕获阶段唤醒，使 Tab 在执行默认焦点移动前就能找到顶部控件。
document.addEventListener('keydown', wakeImmersiveControls, true);
document.addEventListener('focusin', wakeImmersiveControls);
document.addEventListener('focusout', wakeImmersiveControls);
document.addEventListener('close', wakeImmersiveControls, true);
document.addEventListener('visibilitychange', releaseImmersivePointer);
document.defaultView?.addEventListener('blur', releaseImmersivePointer);

/* toggleImmersive()：切换 body.immersive 和顶部按钮文本，由 CSS 控制画廊/沉浸布局。
 * 不改 audio 的地址、进度或播放状态，因此切换视图不会重新播放歌曲。 */
function toggleImmersive() {
  cancelSearchJump();
  const active = document.body.classList.toggle('immersive');
  updateGalleryMode();
  cards.forEach((card, i) => {
    card.querySelector('.gallery-pick').tabIndex = !active && card.style.visibility !== 'hidden' && Math.abs(i - 4) <= 2 ? 0 : -1;
  });
  wakeImmersiveControls();
  $('viewToggle').setAttribute('aria-pressed', String(active));
  $('viewToggle').textContent = active ? '画廊 · F' : '沉浸 · F';
  globalThis.HigherGalleryModes?.refresh();
  // 只切换视觉状态：不调用 pause/play/load，不修改 src/currentTime。
  document
    .querySelector('.station')
    .animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease-out' });
}
$('viewToggle').onclick = toggleImmersive;

/* 【竖向拖动】仅有歌曲的画廊响应；复用同一轨道，松手后切歌或选择封面。 */
let drag = null;
$('stage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drag || flashing || !songs.length || document.body.classList.contains('immersive')) return;
  // 编辑与交互控件保留原生行为，不捕获它们的指针，也不影响输入框选择文字。
  const pick = e.target.closest('.gallery-pick');
  if (!pick && e.target.closest('input,textarea,select,button,a,[contenteditable]')) return;
  drag = { id: e.pointerId, y: e.clientY, x: e.clientX,
    offset: pick ? Number(pick.closest('.card').dataset.offset) : null };
  $('stage').classList.add('is-dragging');
  $('stage').setPointerCapture(e.pointerId);
});
$('stage').addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (document.body.classList.contains('immersive')) return finishDrag({ pointerId: e.pointerId, type: 'pointercancel' });
  const distance = e.clientY - drag.y;
  // 有限阻尼，拖动不会把整面展墙抛出视窗。
  $('rail').style.transform = `translateY(${Math.sign(distance) * Math.min(90, Math.abs(distance) * .4)}px)`;
});
/* finishDrag()：纵向超过 45px 切歌；短点按选择封面；取消/丢失捕获只复位。 */
function finishDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const distance = e.clientY - drag.y;
  const horizontal = e.clientX - drag.x;
  const offset = drag.offset;
  drag = null;
  $('stage').classList.remove('is-dragging');
  $('rail').style.transform = '';
  if (e.type !== 'pointerup' || document.body.classList.contains('immersive')) return;
  if (Math.abs(distance) > 45 && Math.abs(distance) > Math.abs(horizontal)) advance(distance < 0 ? 1 : -1);
  else if (offset !== null && Math.hypot(distance, horizontal) < 8) selectGalleryCard(offset);
}
$('stage').addEventListener('pointerup', finishDrag);
$('stage').addEventListener('pointercancel', finishDrag);
// 窗口失焦等情况可能结束指针捕获，同样清理拖动状态。
$('stage').addEventListener('lostpointercapture', finishDrag);

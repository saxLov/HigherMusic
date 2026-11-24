/* 页面启动与跨区域的交互入口。 */
lyricMinus.onclick = () => adjustLyricOffset(-0.1);
lyricPlus.onclick = () => adjustLyricOffset(0.1);
updateOffsetLabel();

bindSearch();

/* 【工具按钮】搜索、背景选择、清除当前歌曲背景。 */
$('searchOpen').onclick = search;
$('backgroundOpen').onclick = openBackgrounds;
$('clearBackground').onclick = () => saveBackground('');

/* 【键盘】输入框/下拉框/弹窗内不拦截按键；F 切视图，I 搜索，左右切歌，空格播放暂停。 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchJumpControl) { e.preventDefault(); cancelSearchJump(); return; }
  if (
    e.target.closest('input,select,textarea,[contenteditable="true"]') ||
    document.querySelector('dialog[open]')
  )
    return;
  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toggleImmersive();
  } else if (e.key.toLowerCase() === 'i') {
    e.preventDefault();
    search();
  } else if (e.key === 'ArrowDown' && document.body.classList.contains('vertical-gallery')) {
    e.preventDefault();
    playbackCommand('next');
  } else if (e.key === 'ArrowUp' && document.body.classList.contains('vertical-gallery')) {
    e.preventDefault();
    playbackCommand('previous');
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    playbackCommand('next');
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    playbackCommand('previous');
  } else if (e.code === 'Space') {
    if (e.target.closest('.gallery-pick,.spine-book,.spine-detail button')) return;
    e.preventDefault();
    $('toggle').click();
  }
});
document.addEventListener(
  /* 【滚轮】只处理主要为纵向的滚动；220ms 内累计到 70px 才切歌，减少触控板轻微移动导致误触。 */
  'wheel',
  (e) => {
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    if (flashing || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const now = performance.now();
    if (now - wheelAt > 220) wheelSum = 0;
    wheelAt = now;
    wheelSum += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    if (Math.abs(wheelSum) >= 70) {
      advance(wheelSum > 0 ? 1 : -1);
      wheelSum = 0;
    }
  },
  { passive: false },
);

renderGallery();
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => {
  cancelSearchJump();
  stopAudio(); mediaEngine.dispose();
}, { once: true });
/* 【启动】先渲染空画廊，再向后端恢复当前会话；已有登录时读取歌单，否则提示扫码。 */
(async () => {
  if (location.protocol === 'file:') {
    status('请通过 http://127.0.0.1:3211/ 打开；双击文件无法共享登录会话');
    return;
  }
  try {
    const d = await request('session');
    setAccount(d.user, d);
    if (d.user) await loadPlaylists();
    else status(d.loginNotice || (d.ready ? '连接已就绪，请扫码登录' : '请先启动并安装后端连接组件'));
  } catch (e) {
    status('无法连接后端：' + e.message);
  }
})();

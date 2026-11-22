/* 搜索选中与实际播放之间的可取消视觉阶段。常规切歌不经过此处。 */
let searchJumpControl = null;
function cancelSearchJump() {
  const previous = searchJumpControl;
  searchJumpControl = null;
  previous?.abort();
  HigherSpineJump.cancel();
  if (previous) flashing = false;
}
async function searchJumpTo(target) {
  if (sliding || !Number.isInteger(target) || target < 0 || target >= songs.length) return;
  const horizontal = ['spine','wall'].includes(globalThis.HigherGalleryModes?.mode);
  cancelSearchJump();
  if (target === index && !horizontal) { galleryBrowse = null; renderGallery(); resetFailedRun(); return playCurrent(); }
  const delta = target-index;
  const direction = Math.abs(delta) <= songs.length/2 ? Math.sign(delta) : -Math.sign(delta);
  // 三种画廊共用书脊寻址；沉浸与减少动态效果保留轻量切换。
  if (reducedMotion.matches || document.body.classList.contains('immersive')) {
    if (horizontal) return HigherGalleryModes.preview(songs[target].id);
    goTo(target, !reducedMotion.matches, direction); return;
  }
  const control = new AbortController(), version = viewVersion, song = songs[target], from = songs[index]?.id;
  searchJumpControl = control;
  const valid = () => !control.signal.aborted && version === viewVersion && songs[index]?.id === from && songs.includes(song);
  clearTimeout(playTimer); playTimer = null;
  if (!horizontal) { cancelPreparation(); listening.reset(); playbackSession.cancel(); resetFailedRun(); }
  if (horizontal) HigherGalleryModes.prepareSearch();
  flashing = true;
  let committed = false;
  try {
    await HigherSpineJump.run({ viewport: horizontal ? $('spineGallery') : $('rail').parentElement,
      rail: horizontal ? $('spineGallery').querySelector('.spine-rack') : $('rail'), tracks: songs,
      target, preload: preloadCover, fallback: FALLBACK, signal: control.signal });
    if (!valid()) return;
    if (horizontal) { HigherGalleryModes.preview(song.id); return; }
    // 缩放窗口中止动效后仍提交用户选中的歌曲，不保留失效的旧坐标。
    index = songs.indexOf(song); galleryBrowse = null;
    renderGallery(); committed = true;
    const caption = $('rail').querySelector('.card[data-offset="0"] figcaption');
    if (!reducedMotion.matches) caption?.animate?.([{ opacity:0, transform:'translateY(8px)' },{ opacity:1, transform:'translateY(0)' }],{duration:180,easing:'ease-out'});
  } catch (error) {
    if (valid()) {
      if (horizontal) HigherGalleryModes.preview(song.id);
      else { index = songs.indexOf(song); galleryBrowse = null; renderGallery(); committed = true; }
    }
  } finally {
    if (searchJumpControl === control) { searchJumpControl = null; flashing = false; }
  }
  if (committed && !control.signal.aborted && version === viewVersion && songs[index] === song) return playCurrent();
}

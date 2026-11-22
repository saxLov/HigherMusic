/* 搜索动效：最多十五张临时封套，九张常驻画廊卡片保持原位；结束或取消即回收。 */
(function (root) {
  const MAX_JACKETS = 15;
  const DURATION = 1700;
  let active = null;
  function rackIndices(length, target) {
    const count = Math.min(MAX_JACKETS, length), selected = Math.floor(count / 2);
    return Array.from({ length: count }, (_, i) => ((target + i - selected) % length + length) % length);
  }
  function cancel() {
    if (!active) return;
    active.control.abort();
    active.cleanup();
    active = null;
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(new DOMException('跳转已取消', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function run({ viewport, rail, tracks, target, preload, fallback, signal, duration = DURATION }) {
    cancel();
    if (!viewport?.getBoundingClientRect || !rail?.getBoundingClientRect || !tracks[target]) return false;
    const control = new AbortController(), animations = [], nodes = [];
    const relay = () => control.abort();
    if (signal?.aborted) control.abort(); else signal?.addEventListener('abort', relay, { once: true });
    let layer, cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      animations.forEach(a => a.cancel());
      layer?.remove();
      viewport.classList.remove('spine-jumping');
      signal?.removeEventListener('abort', relay);
      root.removeEventListener?.('resize', resize);
    };
    const job = { control, cleanup }; active = job;
    const resize = () => control.abort();
    const animate = (element, frames, options) => {
      const a = element.animate(frames, options); animations.push(a);
      a.finished.catch(() => {}); return a;
    };
    try {
      control.signal.throwIfAborted();
      const indices = rackIndices(tracks.length, target), selected = Math.floor(indices.length / 2);
      const loading = Promise.all(indices.map(at => preload(tracks[at].cover).catch(() => fallback)));
      // 图片慢或失败只影响占位，不无限延迟点播。动效总等待始终有界。
      await Promise.race([loading, sleep(200, control.signal)]);
      control.signal.throwIfAborted();
      rail.querySelectorAll('.card').forEach(card => card.getAnimations?.().forEach(a => { try { a.finish(); } catch {} }));
      const bounds = viewport.getBoundingClientRect();
      const cover = rail.querySelector('.card[data-offset="0"] .cover');
      const fallbackSize = Math.min(bounds.width * .22, bounds.height * .43);
      const main = cover?.getBoundingClientRect() || {
        left: bounds.left + (bounds.width-fallbackSize)/2,
        top: bounds.top + bounds.height*.54-fallbackSize/2,
        width: fallbackSize
      };
      if (bounds.width <= 0 || main.width <= 0 || typeof rail.animate !== 'function') return false;
      const mainX = main.left - bounds.left, mainY = main.top - bounds.top, size = main.width;
      const jacketSize = size * 420 / 510, rackY = mainY + size * 76 / 510;
      const left = bounds.width * 40 / 1434;
      const spacing = bounds.width * .8 / Math.max(1, indices.length - 1);
      const destinations = [-2,-1,1,2].map(offset => {
        const card = rail.querySelector(`.card[data-offset="${offset}"] .cover`)?.getBoundingClientRect() || {
          left: main.left + offset * size * .86, top: main.top + Math.abs(offset)*size*.12, width:size*.7
        };
        return { offset, x: card.left - bounds.left, y: card.top - bounds.top, size: card.width };
      });
      layer = document.createElement('div'); layer.className = 'spine-jump-layer';
      layer.setAttribute('aria-hidden', 'true'); layer.style.perspective = Math.max(size * 2.75, 600) + 'px';
      viewport.append(layer); viewport.classList.add('spine-jumping');
      root.addEventListener?.('resize', resize);
      animate(rail, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.86)' }],
        { duration: duration * .2, fill: 'forwards' });
      indices.forEach((at, i) => {
        const track = tracks[at], node = document.createElement('div'), image = document.createElement('img'), label = document.createElement('span');
        node.className = 'spine-jump-jacket'; node.dataset.trackId = track.id;
        node.style.cssText = `left:${left+i*spacing}px;top:${rackY}px;width:${jacketSize}px;height:${jacketSize}px;z-index:${i===selected?30:i};opacity:${i===selected?1:.48};transform:rotateY(-72deg)`;
        image.alt = ''; image.src = track.cover || fallback;
        image.onerror = () => { image.onerror = null; image.src = fallback; };
        label.textContent = `${at + 1} / ${tracks.length}`;
        node.append(image, label); layer.append(node); nodes.push(node);
        animate(node, [{ transform: 'translateX(120px) rotateY(-88deg)', opacity: 0 },
          { transform: 'translateX(0) rotateY(-72deg)', opacity: i===selected?1:.48 }],
        { duration: duration*.43, delay: i*duration*.009, fill: 'forwards', easing: 'cubic-bezier(.2,.75,.2,1)' });
      });
      await sleep(duration * .58, control.signal);
      const chosen = nodes[selected], selectedX = left + selected*spacing;
      chosen.getAnimations().forEach(a => a.cancel());
      const dx = mainX-selectedX, dy = mainY-rackY+(size-jacketSize)/2;
      animate(chosen, [{ transform: 'rotateY(-72deg) scale(1)' },
        { transform: `translate(${dx}px,${dy}px) rotateY(0deg) scale(${size/jacketSize})` }],
      { duration: duration*.42, fill: 'forwards', easing: 'cubic-bezier(.16,1,.3,1)' });
      // 复用四张书脊展开成目标邻居，不额外创建一整排歌单节点。
      const supporting = nodes.map((node, i) => ({node,i})).filter(item => item.i !== selected).slice(0,4);
      nodes.forEach((node, i) => {
        if (i === selected || supporting.some(item => item.node === node)) return;
        animate(node, [{ transform: 'rotateY(-72deg)', opacity: .48 },
          { transform: `translateY(${i<selected?-size*.53:size*.53}px) rotateY(-88deg)`, opacity: 0 }],
        { duration: duration*.3, fill: 'forwards', easing: 'ease-in' });
      });
      supporting.forEach(({node,i}, n) => {
        const to = destinations[n], at = ((target+to.offset)%tracks.length+tracks.length)%tracks.length;
        node.getAnimations().forEach(a => a.cancel());
        node.querySelector('img').src = tracks[at].cover || fallback;
        node.querySelector('span').textContent = `${at+1} / ${tracks.length}`;
        const x = left+i*spacing, scale = to.size/jacketSize;
        const transform = `translate(${to.x-x}px,${to.y-rackY+(jacketSize-to.size)/2}px) rotateY(0deg) scale(${scale})`;
        animate(node, [{ transform: 'translateY(40px) rotateY(-72deg) scale(.65)', opacity: 0 },
          { transform, opacity: .52 }], { duration: duration*.37, delay: duration*.03, fill: 'forwards', easing: 'cubic-bezier(.16,1,.3,1)' });
      });
      await sleep(duration * .42, control.signal);
      control.signal.throwIfAborted();
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return false;
      throw error;
    } finally { cleanup(); if (active === job) active = null; }
  }
  root.HigherSpineJump = { run, cancel, rackIndices, duration: DURATION, maxJackets: MAX_JACKETS };
})(globalThis);

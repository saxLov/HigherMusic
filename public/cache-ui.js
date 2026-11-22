(() => {
  if (typeof window === 'undefined' || !window.higherDesktop) return;
  const button = $('cacheOpen'), dialog = $('cacheDialog'), hint = $('cacheHint'), toggle = $('cacheEnabled');
  button.hidden = false;
  const render = data => {
    toggle.disabled = data.available === false;
    $('clearCache').disabled = data.available === false;
    toggle.checked = data.enabled === true;
    hint.textContent = data.available === false ? '磁盘缓存不可用，仍可正常在线播放。' :
      `${data.count} 首完整缓存 · ${(data.bytes / 1024 ** 2).toFixed(1)} MB / ${Math.round(data.maxBytes / 1024 ** 2)} MB · ${data.ttlDays} 天后过期`;
  };
  button.onclick = async () => {
    if (!dialog.open) dialog.showModal();
    try { render(await request('cache')); } catch (error) { hint.textContent = error.message; }
  };
  async function update(body) {
    toggle.disabled = $('clearCache').disabled = true;
    try { render(await request('cache', 'POST', () => true, { body })); }
    catch (error) { hint.textContent = error.message; toggle.disabled = $('clearCache').disabled = false; }
  }
  toggle.onchange = () => update({ action: 'enabled', value: toggle.checked });
  $('clearCache').onclick = () => update({ action: 'clear' });
})();

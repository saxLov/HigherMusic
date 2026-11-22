const shortcuts = [
  ['', '关闭'],
  ['Control+Alt+Space', 'Ctrl + Alt + Space'],
  ['Control+Shift+Space', 'Ctrl + Shift + Space'],
  ['Control+Alt+P', 'Ctrl + Alt + P'],
];

export function validateDesktopSetting(key, value) {
  if (key === 'minimizeToTray' && ['true', 'false'].includes(value)) return value;
  if (key === 'playbackShortcut' && shortcuts.some(([code]) => code === value)) return value;
  throw new Error('无效桌面控制设置');
}

export function createDesktopControls({ app, globalShortcut, settings, executable, createTray,
  buildMenu, showWindow, sendCommand, showError, refreshMenu, windows = process.platform === 'win32' }) {
  const startup = { path: executable, args: [] };
  let tray, registered = '';
  let playback = { title: '', playing: false, available: false };

  function registerShortcut(code) {
    if (!code || code === registered) return true;
    try { return globalShortcut.register(code, () => sendCommand('toggle')); }
    catch { return false; }
  }

  function chooseShortcut(code) {
    if (!registerShortcut(code)) {
      showError('快捷键不可用，可能已被其他应用占用。');
      refreshMenu();
      return;
    }
    try { settings.set('playbackShortcut', code); }
    catch {
      if (code && code !== registered) globalShortcut.unregister(code);
      showError('无法保存快捷键设置。');
      refreshMenu();
      return;
    }
    if (registered && registered !== code) globalShortcut.unregister(registered);
    registered = code;
    refreshMenu();
  }

  function getAutostart() {
    if (!windows) return false;
    try {
      const state = app.getLoginItemSettings(startup);
      return state.openAtLogin && state.executableWillLaunchAtLogin !== false;
    } catch { return false; }
  }

  function setAutostart(enabled) {
    try {
      app.setLoginItemSettings({ ...startup, openAtLogin: enabled, enabled });
      if (getAutostart() !== enabled) throw new Error('startup state mismatch');
    } catch { showError('无法更改开机自启。请检查 Windows 的启动应用设置。'); }
    refreshMenu();
  }

  function updateTray() {
    if (!tray) return;
    tray.setToolTip(playback.title ? `Higher Music · ${playback.title}`.slice(0, 110) : 'Higher Music');
    tray.setContextMenu(buildMenu([
      { label: playback.title || 'Higher Music', enabled: false },
      { label: '显示窗口', click: showWindow },
      { type: 'separator' },
      { label: playback.playing ? '暂停' : '播放', enabled: playback.available,
        click: () => sendCommand(playback.playing ? 'pause' : 'play') },
      { label: '上一首', enabled: playback.available, click: () => sendCommand('previous') },
      { label: '下一首', enabled: playback.available, click: () => sendCommand('next') },
      { type: 'separator' },
      { label: '退出 Higher Music', click: () => app.quit() },
    ]));
  }

  return {
    start() {
      try {
        tray = createTray();
        tray.on('click', showWindow);
        updateTray();
      } catch {
        tray?.destroy();
        tray = undefined;
        showError('系统托盘不可用，窗口仍可正常播放。');
      }
      const code = settings.snapshot().playbackShortcut || '';
      if (registerShortcut(code)) registered = code;
      else showError('已保存的快捷键当前不可用，请重新选择。');
    },
    menu() {
      const values = settings.snapshot();
      return [
        { label: '最小化到系统托盘', type: 'checkbox', enabled: !!tray, checked: values.minimizeToTray === 'true',
          click(item) {
            try { settings.set('minimizeToTray', String(item.checked)); }
            catch { showError('无法保存托盘设置。'); }
            refreshMenu();
          } },
        { label: '全局播放／暂停快捷键', submenu: shortcuts.map(([code, label]) => ({
          label, type: 'radio', checked: registered === code, click: () => chooseShortcut(code),
        })) },
        { label: '开机自启', type: 'checkbox', enabled: windows, checked: getAutostart(),
          click: item => setAutostart(item.checked) },
      ];
    },
    minimize(window) {
      if (tray && settings.snapshot().minimizeToTray === 'true') window.hide();
    },
    update(value) {
      const title = typeof value?.title === 'string' ? value.title.replace(/[\x00-\x1f]/g, ' ').slice(0, 96) : '';
      const next = { title, playing: value?.playing === true, available: value?.available === true };
      if (Object.keys(next).every(key => next[key] === playback[key])) return;
      playback = next;
      updateTray();
    },
    stop() {
      if (registered) globalShortcut.unregister(registered);
      registered = '';
      tray?.destroy();
      tray = undefined;
    },
  };
}

const { contextBridge, ipcRenderer } = require('electron');

// 仅暴露列举的设置与图片选择接口；不向页面提供平台凭据、磁盘路径或通用 IPC。
const initial = ipcRenderer.sendSync('higher:bootstrap');
const values = { ...(initial?.values || {}) };
contextBridge.exposeInMainWorld('higherDesktop', {
  version: initial?.version || '',
  getSetting: (key) => Object.hasOwn(values, key) ? values[key] : null,
  setSetting: (key, value) => {
    const result = ipcRenderer.sendSync('higher:setting', key, value);
    if (!result?.ok) throw new Error(result?.error || '设置保存失败');
    values[key] = value;
  },
  importBackground: () => ipcRenderer.invoke('higher:background'),
  publishPlayback: (value) => ipcRenderer.send('higher:playback-state', value),
  onPlaybackCommand: (callback) => {
    if (typeof callback === 'function')
      ipcRenderer.on('higher:playback-command', (_, command) => callback(command));
  },
  onPower: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('higher:power', (_, event) => callback(event));
  },
});

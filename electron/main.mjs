import { safeStorage, app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, dialog, session, screen, powerMonitor, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createSettingsStore } from './settings.mjs';
import { importBackground } from './background-import.mjs';
import { startDesktopService } from './service.mjs';
import { checkPublicDns } from '../lib/gateway/network.mjs';
import { createDesktopControls, validateDesktopSetting } from './desktop-controls.mjs';

app.setName('Higher Music');
app.setAppUserModelId('com.highermusic.desktop');
// QA 使用隔离的数据目录，不接触用户的真实设置或登录。
if (!app.isPackaged && process.env.HIGHER_MUSIC_TEST_DATA) app.setPath('userData', path.resolve(process.env.HIGHER_MUSIC_TEST_DATA));
const root = path.dirname(fileURLToPath(import.meta.url));
let win, service, settings, desktopControls, localFiles, audioCache, backgroundRoot, quitting = false, importPending = false, musicImportPending = false;
const show = () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } };

function trusted(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && new URL(event.senderFrame.url).origin === service.origin;
}
function installIPC() {
  ipcMain.on('higher:bootstrap', event => {
    event.returnValue = trusted(event) ? { version: app.getVersion(), values: settings.snapshot() } : null;
  });
  ipcMain.on('higher:setting', (event, key, value) => {
    try { if (!trusted(event)) throw new Error('无效窗口'); settings.set(key, value); event.returnValue = { ok: true }; }
    catch { event.returnValue = { ok: false, error: '设置保存失败，请检查数据目录是否可写' }; }
  });
  ipcMain.on('higher:playback-state', (event, value) => {
    if (trusted(event)) desktopControls?.update(value);
  });
  ipcMain.handle('higher:background', async event => {
    if (!trusted(event) || importPending) return { canceled: true };
    importPending = true;
    try {
      const result = await dialog.showOpenDialog(win, { title: '导入歌曲背景', properties: ['openFile'], filters: [{ name: '图片（最多 20 MB）', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif'] }] });
      if (result.canceled) return { canceled: true };
      const name = await importBackground(result.filePaths[0], backgroundRoot);
      // 解码失败时不绑定给歌曲；文件签名检查与真实解码分别完成。
      if (/\.(png|jpg|webp)$/.test(name) && nativeImage.createFromPath(path.join(backgroundRoot, name)).isEmpty()) throw new Error('图片无法解码');
      return { name };
    } catch (error) { return { error: /图片|格式|文件/.test(error.message) ? error.message : '图片导入失败，请检查文件及数据目录' }; }
    finally { importPending = false; }
  });
}
function trayIcon() {
  const size = 24;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const radius = Math.hypot(x - 11.5, y - 11.5);
      if (radius > 10.8) continue;
      const color = radius < 2 ? [33, 33, 36] : radius < 4.2 ? [150, 173, 230] :
        Math.floor(radius * 1.4) % 2 ? [92, 92, 104] : [43, 43, 48];
      pixels.set([...color, 255], (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
async function transferSettings(importing) {
  try {
    if (importing) {
      const result = await dialog.showOpenDialog(win, { title: '导入 Higher Music 设置', properties: ['openFile'], filters: [{ name: 'JSON 设置', extensions: ['json'] }] });
      if (result.canceled) return;
      if ((await stat(result.filePaths[0])).size > 3 * 1024 * 1024) throw new Error('设置文件过大');
      settings.import(await readFile(result.filePaths[0], 'utf8'));
      win.reload();
    } else {
      const result = await dialog.showSaveDialog(win, { title: '导出设置（不包含账号凭据和图片）', defaultPath: 'Higher-Music-settings.json', filters: [{ name: 'JSON 设置', extensions: ['json'] }] });
      if (!result.canceled) await writeFile(result.filePath, settings.export(), { mode: 0o600 });
    }
  } catch { dialog.showErrorBox('设置操作失败', '请确认文件格式正确，且所选目录可以读写。'); }
}
function createWindow() {
  const saved = settings.window();
  const width = Math.max(960, Math.min(saved.width || 1440, screen.getPrimaryDisplay().workAreaSize.width));
  const height = Math.max(640, Math.min(saved.height || 900, screen.getPrimaryDisplay().workAreaSize.height));
  const position = Number.isInteger(saved.x) && Number.isInteger(saved.y) && screen.getAllDisplays().some(({ workArea: a }) => saved.x + width > a.x + 100 && saved.x < a.x + a.width - 100 && saved.y >= a.y && saved.y < a.y + a.height - 100) ? { x: saved.x, y: saved.y } : {};
  const profile = session.fromPartition('higher-music'); // 本地服务 Cookie 仅在进程内；可选平台登录凭据由系统加密另存。
  profile.setPermissionRequestHandler((_, __, callback) => callback(false));
  profile.setPermissionCheckHandler(() => false);
  profile.webRequest.onBeforeSendHeaders({ urls: [`${service.origin}/*`] }, (details, callback) => {
    if (details.webContentsId !== win?.webContents.id) return callback({ cancel: true });
    callback({ requestHeaders: { ...details.requestHeaders, 'X-Higher-Music': service.secret } });
  });
  profile.on('will-download', event => event.preventDefault());
  win = new BrowserWindow({ width, height, ...position, minWidth: 960, minHeight: 640, show: false, autoHideMenuBar: true, backgroundColor: '#121212', title: 'Higher Music',
    webPreferences: { preload: path.join(root, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, session: profile, spellcheck: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== service.origin) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (new URL(url).origin !== service.origin) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.once('ready-to-show', () => { if (saved.maximized) win.maximize(); win.show(); });
  win.on('minimize', () => desktopControls?.minimize(win));
  win.on('close', () => {
    try { settings.setWindow({ ...win.getNormalBounds(), maximized: win.isMaximized() }); }
    catch { /* 退出不因磁盘故障被卡住。 */ }
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('render-process-gone', () => { dialog.showErrorBox('播放器已停止', '页面进程意外退出，请重新启动 Higher Music。'); app.quit(); });
  return win.loadURL(service.origin);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    desktopControls?.stop();
    const force = setTimeout(() => app.exit(0), 4000);
    Promise.resolve(service?.stop()).finally(() => { audioCache?.close(); localFiles?.close(); clearTimeout(force); app.quit(); });
  });
  app.whenReady().then(async () => {
    const dataRoot = app.getPath('userData');
    await mkdir(dataRoot, { recursive: true });
    settings = createSettingsStore(dataRoot, { filename: 'settings-7.3.7.json' });
    const modeKey = 'highermusic.kugouMode.v1';
    const kugouMode = settings.snapshot()[modeKey] ?? 'lite';
    process.env.platform = kugouMode === 'lite' ? 'lite' : '';
    const switchKugouMode = async (mode) => {
      if (mode === kugouMode) return;
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['切换并重启', '取消'], cancelId: 1,
        message: mode === 'lite' ? '切换到酷狗概念版' : '切换到酷狗标准版',
        detail: '播放器将重启。切换模式后请重新扫码登录。',
      });
      if (response !== 0) return;
      try { settings.set(modeKey, mode); }
      catch { dialog.showErrorBox('无法切换', '无法保存酷狗模式，请检查数据目录。'); return; }
      app.relaunch();
      app.quit();
    };
    backgroundRoot = path.join(dataRoot, 'backgrounds-7.3.7');
    await mkdir(backgroundRoot, { recursive: true });
    process.env.HIGHER_MUSIC_BACKGROUNDS = backgroundRoot;
    process.env.HIGHER_MUSIC_LIBRARY = path.join(dataRoot, 'library');
    if (app.isPackaged) process.env.HIGHER_MUSIC_PROVIDER_PATH = path.join(process.resourcesPath, 'provider');
    const { createMusicServer } = !app.isPackaged && process.env.HIGHER_MUSIC_PREVIEW === '1'
      ? { createMusicServer: (({ createPreview }) => options => createPreview(options).server)(await import('../scripts/preview.mjs')) }
      : await import('../server.mjs');
    const audioSession = session.fromPartition('higher-music-audio', { cache: false });
    service = await startDesktopService(createMusicServer, {
      localFiles,
      audioCache,
      loginStore: null,
      kugouMediaFetch: async (url, init) => {
        await checkPublicDns(new URL(url).hostname, init.signal);
        return audioSession.fetch(url, {
          ...init, redirect: 'error', credentials: 'omit', bypassCustomProtocolHandlers: true,
        });
      },
    });
    installIPC();
    const refreshMenu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Higher Music', submenu: [
        { label: '关于 Higher Music', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Higher Music', message: `Higher Music ${app.getVersion()}`, detail: '沉浸式音乐播放器\n关闭窗口即退出；最小化可继续播放。\n登录仅保留在本次运行期间。' }) },
        { type: 'separator' }, { label: '导入设置…', click: () => transferSettings(true) }, { label: '导出设置…', click: () => transferSettings(false) },
        { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => app.quit() },
      ] },
      { label: '音源', submenu: [
        { label: kugouMode === 'standard' ? '酷狗标准版（当前）' : '切换到酷狗标准版…', enabled: kugouMode !== 'standard', click: () => switchKugouMode('standard') },
        { label: kugouMode === 'lite' ? '酷狗概念版（当前）' : '切换到酷狗概念版…', enabled: kugouMode !== 'lite', click: () => switchKugouMode('lite') },
        { type: 'separator' },
        { label: '打开酷狗网页版', click: () => shell.openExternal('https://www.kugou.com/').catch(() =>
          dialog.showErrorBox('无法打开浏览器', '请在浏览器访问 www.kugou.com。')) },
      ] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { label: '系统全屏', role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
      { label: '桌面控制', submenu: desktopControls.menu() },
    ]));
    desktopControls = createDesktopControls({
      app, globalShortcut, executable: process.execPath,
      windows: process.platform === 'win32' && app.isPackaged,
      settings: createSettingsStore(dataRoot, { filename: 'desktop-controls.json', validate: validateDesktopSetting }),
      createTray: () => new Tray(trayIcon()),
      buildMenu: template => Menu.buildFromTemplate(template),
      showWindow: show,
      sendCommand: command => {
        if (win && !win.isDestroyed()) win.webContents.send('higher:playback-command', command);
      },
      showError: message => dialog.showErrorBox('桌面控制', message),
      refreshMenu,
    });
    desktopControls.start();
    refreshMenu();
    powerMonitor.on('suspend', () => win?.webContents.send('higher:power', 'suspend'));
    powerMonitor.on('resume', () => win?.webContents.send('higher:power', 'resume'));
    await createWindow();
  }).catch(error => { console.error('Higher Music startup:', error); if (!app.isPackaged && process.env.HIGHER_MUSIC_TEST_DATA) { app.quit(); return; } dialog.showErrorBox('Higher Music 启动失败', '无法启动本地播放器，请确认应用文件完整、数据目录可写。'); app.quit(); });
}


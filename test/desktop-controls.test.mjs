import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopControls, validateDesktopSetting } from '../electron/desktop-controls.mjs';

test('托盘跟随实际播放，最小化可选，退出释放托盘和快捷键', () => {
  const commands = [], errors = [], listeners = new Map(), registered = new Map(), settings = {};
  let trayMenu, startup, destroyed = false, hidden = 0, shown = 0, quit = 0;
  const tray = {
    on: (name, callback) => listeners.set(name, callback),
    setToolTip() {}, setContextMenu: value => { trayMenu = value; },
    destroy: () => { destroyed = true; },
  };
  const controls = createDesktopControls({
    windows: true, executable: 'D:/Higher Music.exe',
    app: { quit: () => quit++, getLoginItemSettings: () => ({ openAtLogin: !!startup?.openAtLogin }),
      setLoginItemSettings: value => { startup = value; } },
    globalShortcut: {
      register(code, callback) {
        if (code === 'Control+Alt+P') return false;
        registered.set(code, callback); return true;
      },
      unregister: code => registered.delete(code),
    },
    settings: { snapshot: () => ({ ...settings }), set: (key, value) => { settings[key] = validateDesktopSetting(key, value); } },
    createTray: () => tray, buildMenu: items => items, showWindow: () => shown++,
    sendCommand: command => commands.push(command), showError: message => errors.push(message), refreshMenu() {},
  });
  controls.start();
  assert.equal(startup, undefined);
  assert.equal(registered.size, 0);
  assert.equal(trayMenu.find(item => item.label === '播放').enabled, false);
  controls.update({ title: '已起播的歌', available: true, playing: true });
  assert.equal(trayMenu[0].label, '已起播的歌');
  trayMenu.find(item => item.label === '暂停').click();
  trayMenu.find(item => item.label === '下一首').click();
  listeners.get('click')();
  assert.equal(shown, 1);
  const window = { hide: () => hidden++ };
  controls.minimize(window);
  assert.equal(hidden, 0);
  controls.menu()[0].click({ checked: true });
  controls.minimize(window);
  assert.equal(hidden, 1);
  controls.menu()[1].submenu[1].click();
  controls.menu()[1].submenu[3].click();
  assert.equal(errors.length, 1);
  assert.ok(controls.menu()[1].submenu[1].checked);
  registered.get('Control+Alt+Space')();
  controls.menu()[2].click({ checked: true });
  assert.deepEqual(startup, { path: 'D:/Higher Music.exe', args: [], openAtLogin: true, enabled: true });
  controls.menu()[2].click({ checked: false });
  assert.equal(startup.openAtLogin, false);
  trayMenu.at(-1).click();
  assert.equal(quit, 1);
  controls.stop();
  assert.equal(registered.size, 0);
  assert.equal(destroyed, true);
  assert.deepEqual(commands, ['pause', 'next', 'toggle']);
});

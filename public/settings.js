// 桌面设置与端口无关；浏览器模式继续兼容已有的 localStorage 键。
(function(root) {
  root.HigherSettings = {
    getItem(key) { return root.higherDesktop ? root.higherDesktop.getSetting(key) : localStorage.getItem(key); },
    setItem(key, value) { return root.higherDesktop ? root.higherDesktop.setSetting(key, String(value)) : localStorage.setItem(key, String(value)); },
  };
})(globalThis);

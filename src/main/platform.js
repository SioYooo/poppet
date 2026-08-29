'use strict';
// macOS / Windows 的差异全部收在这里，其余代码不再出现 process.platform 判断。

const { app, nativeImage } = require('electron');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = !isMac && !isWin;

// 开机自启：系统登录项是唯一真相，不在 settings.json 存副本（用户可能在
// 系统设置里改，双真相必然漂移）。未打包的开发运行（electron .）注册的会
// 是 Electron 二进制而不是 Poppet，故仅在打包产物里暴露该能力。
function loginItemSupported() {
  return app.isPackaged && (isMac || isWin);
}

function getLoginItemEnabled() {
  if (!loginItemSupported()) return false;
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setLoginItemEnabled(enabled) {
  if (!loginItemSupported()) return false;
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return true;
  } catch {
    return false;
  }
}

// 桌宠窗口的构造参数。两边都要"无边框 + 透明 + 不进任务栏/程序坞"。
function petWindowOptions() {
  const base = {
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,        // 位置一律由主进程 setPosition 控制，避免系统拖拽与自绘拖拽打架
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,     // Windows：不占任务栏；macOS 上无副作用
    alwaysOnTop: true,
  };
  if (isMac) {
    // 新版 Electron 的无边框窗口默认带圆角，会把贴边的像素裁掉
    base.roundedCorners = false;
    base.titleBarStyle = 'customButtonsOnHover';
  }
  if (isWin) {
    // Windows 上透明窗口必须关掉缩略图，否则任务视图里会出现黑底方块
    base.thickFrame = false;
  }
  return base;
}

// 置顶层级：要浮在普通窗口甚至全屏应用之上，但不至于盖住系统菜单。
function applyAlwaysOnTop(win) {
  win.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) {
    // 跟随切换所有桌面空间，并在别的 App 全屏时依然可见
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
}

// 托盘图标尺寸：macOS 菜单栏按 pt 算（18pt 左右），Windows 通知区域是 16px。
function trayImage(pngPath) {
  const img = nativeImage.createFromPath(pngPath);
  return resizeTrayImage(img);
}

function trayImageDataURL(dataURL) {
  const img = nativeImage.createFromDataURL(dataURL);
  return resizeTrayImage(img);
}

function resizeTrayImage(img) {
  const size = isMac ? 18 : 16;
  return img.resize({ width: size, height: size, quality: 'good' });
}

// 纯托盘应用：macOS 要藏程序坞图标，Windows 靠 skipTaskbar 已经够了。
function hideFromDock() {
  if (isMac && app.dock) app.dock.hide();
}

// 需要把管理窗口拉到前台时，macOS 隐藏了 dock 就拿不到焦点，得显式抢一次。
function focusApp() {
  if (isMac) app.focus({ steal: true });
}

module.exports = {
  isMac, isWin, isLinux,
  petWindowOptions, applyAlwaysOnTop, trayImage, trayImageDataURL, hideFromDock, focusApp,
  loginItemSupported, getLoginItemEnabled, setLoginItemEnabled,
};

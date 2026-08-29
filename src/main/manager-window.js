'use strict';
// 角色管理窗口：导入图片、预览处理结果、校准五官、切换/删除角色。
// 图像处理全在这个窗口的 renderer 里跑（那边有 Canvas），主进程只负责落盘。

const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { isMac } = require('./platform');

let managerWin = null;
const DEVELOPMENT = !app.isPackaged && process.argv.includes('--dev');

function openManager() {
  if (managerWin && !managerWin.isDestroyed()) {
    managerWin.show();
    managerWin.focus();
    return managerWin;
  }
  managerWin = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'Poppet 角色管理',
    backgroundColor: '#14131a',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-manager.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // accessory 应用（dock 已隐藏、无应用菜单）没有菜单等价快捷键，
  // Cmd+W/Cmd+Q 在这个窗口里默认不生效——按构造补齐，而不是赌系统行为。
  if (isMac) {
    managerWin.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.meta || input.alt || input.control || input.shift) return;
      const key = String(input.key || '').toLowerCase();
      if (key === 'w') {
        event.preventDefault();
        managerWin?.close();
      } else if (key === 'q') {
        event.preventDefault();
        app.quit();
      }
    });
  }
  managerWin.loadFile(path.join(__dirname, '../renderer/manager/index.html'),
    DEVELOPMENT ? { query: { poppetDev: '1' } } : undefined);
  managerWin.once('ready-to-show', () => { managerWin.show(); managerWin.focus(); });
  managerWin.on('closed', () => { managerWin = null; });
  return managerWin;
}

function getManagerWindow() {
  return managerWin && !managerWin.isDestroyed() ? managerWin : null;
}

module.exports = { openManager, getManagerWindow };

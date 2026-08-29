'use strict';
// 桌宠窗口的桥。renderer 拿不到 node，能做的动作都在这张白名单里。

const { contextBridge, ipcRenderer } = require('electron');
const { CH } = require('./channels');

contextBridge.exposeInMainWorld('pet', {
  ready: () => ipcRenderer.invoke(CH.PET_READY),
  frameReady: () => ipcRenderer.invoke(CH.PET_FRAME_READY),
  setInteractive: (on) => ipcRenderer.send(CH.PET_SET_INTERACTIVE, !!on),
  dragStart: () => ipcRenderer.send(CH.PET_DRAG_START),
  dragEnd: () => ipcRenderer.send(CH.PET_DRAG_END),
  moveBy: (dx, dy) => ipcRenderer.invoke(CH.PET_MOVE_BY, { dx, dy }),
  getBounds: () => ipcRenderer.invoke(CH.PET_GET_BOUNDS),
  contextMenu: () => ipcRenderer.send(CH.PET_CONTEXT_MENU),
  log: (...args) => ipcRenderer.send(CH.PET_LOG, args.map(String).join(' ')),

  onCharacter: (fn) => ipcRenderer.on(CH.PET_CHARACTER, (_e, data) => fn(data)),
  onSettings: (fn) => ipcRenderer.on(CH.PET_SETTINGS, (_e, data) => fn(data)),
  onCommand: (fn) => ipcRenderer.on(CH.PET_COMMAND, (_e, data) => fn(data)),
  onDropped: (fn) => ipcRenderer.on(CH.PET_DROPPED, () => fn()),
  onDragMove: (fn) => ipcRenderer.on(CH.PET_DRAG_MOVE, (_e, p) => fn(p)),
});

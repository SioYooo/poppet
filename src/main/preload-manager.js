'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { CH } = require('./channels');

contextBridge.exposeInMainWorld('poppet', {
  platform: process.platform,
  list: () => ipcRenderer.invoke(CH.LIB_LIST),
  pickFile: () => ipcRenderer.invoke(CH.LIB_PICK_FILE),
  import: (payload) => ipcRenderer.invoke(CH.LIB_IMPORT, payload),
  finalizeImport: (id) => ipcRenderer.invoke(CH.LIB_FINALIZE_IMPORT, id),
  remove: (id) => ipcRenderer.invoke(CH.LIB_DELETE, id),
  activate: (id) => ipcRenderer.invoke(CH.LIB_ACTIVATE, id),
  ensureActive: (id) => ipcRenderer.invoke(CH.LIB_ENSURE_ACTIVE, id),
  flowClock: () => ipcRenderer.invoke(CH.FLOW_CLOCK),
  load: (id) => ipcRenderer.invoke(CH.LIB_LOAD, id),
  updateMeta: (id, patch) => ipcRenderer.invoke(CH.LIB_UPDATE_META, { id, patch }),
  getSettings: () => ipcRenderer.invoke(CH.SETTINGS_GET),
  setSettings: (patch) => ipcRenderer.invoke(CH.SETTINGS_SET, patch),
  importPack: () => ipcRenderer.invoke(CH.PACK_IMPORT),
  // 拖放导入：renderer 只交出系统路径，包字节永不经过 renderer IPC，
  // 主进程用与对话框导入完全相同的 fail-closed 管线读取与校验。
  importPackAtPath: (file) => {
    const filePath = webUtils.getPathForFile(file);
    return filePath ? ipcRenderer.invoke(CH.PACK_IMPORT_PATH, filePath) : Promise.resolve(null);
  },
  exportPack: (id) => ipcRenderer.invoke(CH.PACK_EXPORT, id),
  getLoginItem: () => ipcRenderer.invoke(CH.LOGIN_ITEM_GET),
  setLoginItem: (enabled) => ipcRenderer.invoke(CH.LOGIN_ITEM_SET, enabled),
  onChanged: (fn) => ipcRenderer.on(CH.LIB_CHANGED, () => fn()),
});

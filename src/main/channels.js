'use strict';
// IPC 通道名。主进程与两个 preload 共用，避免字符串写错。

const CH = {
  // 桌宠窗口 -> 主进程
  PET_READY: 'pet:ready',                 // renderer 初始化完成，请求角色数据
  PET_FRAME_READY: 'pet:first-frame-ready', // 首个非空内容帧已实际画进 canvas
  PET_SET_INTERACTIVE: 'pet:interactive', // 鼠标是否落在不透明像素上，切换点击穿透
  PET_DRAG_START: 'pet:drag-start',
  PET_DRAG_END: 'pet:drag-end',
  PET_MOVE_BY: 'pet:move-by',             // 桌宠自主走动，按屏幕像素位移
  PET_GET_BOUNDS: 'pet:get-bounds',       // 取窗口在当前显示器工作区内的位置与边界
  PET_CONTEXT_MENU: 'pet:context-menu',
  PET_LOG: 'pet:log',

  // 主进程 -> 桌宠窗口
  PET_CHARACTER: 'pet:character',         // 下发角色素材（dataURL + 元数据）
  PET_SETTINGS: 'pet:settings',
  PET_COMMAND: 'pet:command',             // 托盘菜单触发的动作，如 sit / wander / greet
  PET_DROPPED: 'pet:dropped',             // 拖拽结束，通知播放落地动画
  PET_DRAG_MOVE: 'pet:drag-move',         // 拖拽中的光标位置，用来算甩动倾角

  // 管理窗口 <-> 主进程
  LIB_LIST: 'lib:list',
  LIB_IMPORT: 'lib:import',               // 传入处理好的角色素材，落盘
  LIB_FINALIZE_IMPORT: 'lib:finalize-import', // 幂等确认 rename 后父目录 durability
  LIB_DELETE: 'lib:delete',
  LIB_ACTIVATE: 'lib:activate',
  LIB_ENSURE_ACTIVE: 'lib:ensure-active', // 幂等地显示已保存角色；不会把现有窗口收起
  LIB_LOAD: 'lib:load',                   // 读一个已保存角色，用于只改属性不重跑管线
  LIB_UPDATE_META: 'lib:update-meta',
  LIB_PICK_FILE: 'lib:pick-file',         // 打开系统文件选择框，返回图片 dataURL
  LIB_CHANGED: 'lib:changed',             // 主进程 -> 管理窗口，角色库有变化
  PACK_IMPORT: 'pack:import',             // 选择并导入一个 .poppetpack 角色包
  PACK_IMPORT_PATH: 'pack:import-path',   // 按拖放得到的本地路径导入角色包
  PACK_EXPORT: 'pack:export',             // 把一个已保存角色导出为 .poppetpack
  LOGIN_ITEM_GET: 'login-item:get',       // 读系统"开机自启"真相（不存 settings 副本）
  LOGIN_ITEM_SET: 'login-item:set',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  FLOW_CLOCK: 'flow:clock',               // 严格无参数的 main 单调时钟校准
};

module.exports = { CH };

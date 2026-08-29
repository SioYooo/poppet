'use strict';
// 显示器热拔救援：显示器被拔掉或分辨率/排列变化后，不溜达的桌宠会滞留在
// 已消失的坐标上。监听 screen 事件，去抖后对每一只做一次现有的 clampToDisplay()，
// 再统一 persistPets() 落盘。纯模块，不 require electron：screen/定时器都由调用方注入。

const EVENTS = ['display-removed', 'display-metrics-changed'];

function createDisplayRescue({
  screen,
  getPets,
  persistPets,
  delayMs = 100,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  log = null,
} = {}) {
  if (!screen || typeof screen.on !== 'function') throw new TypeError('screen is required');
  if (typeof getPets !== 'function') throw new TypeError('getPets must be a function');
  if (typeof persistPets !== 'function') throw new TypeError('persistPets must be a function');

  let timer = null;
  let attached = false;
  let disposed = false;

  const report = (message, error) => {
    if (typeof log !== 'function') return;
    try { log(message, error); } catch { /* 日志本身不能再抛 */ }
  };

  // 定时器回调里的任何异常都会变成主进程 uncaughtException，这里必须全部兜住。
  const run = () => {
    timer = null;
    if (disposed) return;
    let pets;
    try {
      pets = getPets();
    } catch (error) {
      report('读取桌宠列表失败', error);
      return;
    }
    for (const p of Array.isArray(pets) ? pets : []) {
      try {
        // 与 index.js 其它生命周期判断一致：已销毁/尚未建窗的跳过。
        // clampToDisplay 自己只挡 !win，对已销毁窗口 getPosition() 会抛。
        if (!p || !p.win || p.win.isDestroyed()) continue;
        p.clampToDisplay();
      } catch (error) {
        report('桌宠对齐显示器失败', error);
      }
    }
    // persistPets 是唯一落盘入口；与托盘"都回到屏幕右下角"一样，处理完统一写一次。
    try {
      persistPets();
    } catch (error) {
      report('保存桌宠位置失败', error);
    }
  };

  // 拔一块显示器时系统会连发 display-removed 与剩余显示器的 metrics-changed，
  // 尾沿去抖：每次事件都重置计时，安静 delayMs 后只执行一次。
  const schedule = () => {
    if (disposed) return;
    if (timer !== null) clearTimeoutImpl(timer);
    timer = setTimeoutImpl(run, delayMs);
  };

  const attach = () => {
    if (attached || disposed) return;
    attached = true;
    for (const event of EVENTS) screen.on(event, schedule);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (attached) {
      attached = false;
      for (const event of EVENTS) screen.removeListener(event, schedule);
    }
  };

  return { attach, dispose };
}

module.exports = { createDisplayRescue, DISPLAY_RESCUE_EVENTS: EVENTS };

'use strict';
// 桌宠窗口：透明置顶、按像素判定的点击穿透、主进程驱动的拖拽、多显示器边界。

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, screen } = require('electron');
const { petWindowOptions, applyAlwaysOnTop } = require('./platform');
const { CH } = require('./channels');

// 精灵四周留出的余量，跳跃/拉伸/走动时不会被窗口裁掉。
// 纵向只需容下跳跃(≈16)+拉伸(≈7%)，给多了桌宠就会浮在半空、离屏幕底边太远。
const PAD_X = 1.5;
const PAD_Y = 1.18;
const DRAG_TICK_MS = 16;
const DEVELOPMENT = !app.isPackaged && process.argv.includes('--dev');

function firstFrameError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class PetWindow {
  // character 在建窗之前就要给：renderer 一挂载就发 PET_READY，
  // 主进程必须知道"这个窗口是哪只"才答得上来——多只同屏时靠一个全局 activeCharacter 会串。
  constructor(character = null, slot = 0) {
    this.character = character;
    this.characterId = character ? character.id : null;
    this.slot = slot;            // 第几只，只用来错开默认落点
    this.win = null;
    this.dragTimer = null;
    this.dragOffset = null;
    // 初值故意用 null 而不是 false：setInteractive 靠"值变了才动手"来省调用，
    // 若初值就是 false，启动时那次 setInteractive(false) 会被短路吃掉，
    // 结果 setIgnoreMouseEvents 一次都没调过——窗口整块矩形从冷启动起就一直挡着下面的窗口。
    this.interactive = null;
    this.settings = null;
    this.onDrop = null;
    this.onUnavailable = null;
    // 位置的权威副本，浮点。走一步只有 2.16 点，若每帧都回读 getPosition() 再取整，
    // 小数部分会被反复丢掉，桌宠就在原地抖而走不动。
    this.pos = { x: 0, y: 0 };
    this.firstFrameReadyAt = null;
    this.firstFrameVisibleAt = null;
    this._firstFrameVisible = false;
    this._firstFrameTerminal = null;
    this._firstFrameSettled = false;
    this._firstFrameWaiters = new Set();
  }

  // saved 是**这一只**上次的位置。不能在这里读 settings.position——
  // 那是单只时代留下的全局字段，多只同屏会让每一只都落在同一个点上，
  // 而且 ready-to-show 是异步的，还会把外面显式设好的位置盖掉。
  create(settings, spriteSize, saved = null) {
    this.settings = settings;
    const { width, height } = this.windowSizeFor(settings.scale, spriteSize);

    this.win = new BrowserWindow({
      ...petWindowOptions(),
      width,
      height,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload-pet.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // preload 要 require 本地的 channels 模块，沙箱里的 preload 只能拿到少数内置模块。
        // contextIsolation 仍然开着，renderer 依旧碰不到 Node，安全边界没有放宽。
        sandbox: false,
        backgroundThrottling: false, // 窗口失焦时动画不能停
      },
    });

    applyAlwaysOnTop(this.win);
    // 所有失败监听必须在 loadFile 前挂上；否则 preload/导航的早期失败会漏掉，
    // Manager 就会一直等到超时，甚至把晚到的 ack 当成成功。
    this.win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame !== false) {
        this.failFirstFrame(firstFrameError('POPPET_PET_LOAD_FAILED', '桌宠页面加载失败'));
        this._notifyUnavailable();
      }
      if (DEVELOPMENT) console.error(`[pet-renderer] 加载失败 ${code} ${desc} ${url}`);
    });
    this.win.webContents.on('preload-error', (_e, p, err) => {
      this.failFirstFrame(firstFrameError('POPPET_PET_PRELOAD_FAILED', '桌宠启动桥加载失败'));
      this._notifyUnavailable();
      if (DEVELOPMENT) console.error(`[pet-renderer] preload 出错 ${p}: ${err.message}`);
    });
    this.win.webContents.on('render-process-gone', (_e, details) => {
      this.failFirstFrame(firstFrameError('POPPET_PET_RENDERER_GONE', '桌宠渲染进程提前退出'));
      this._notifyUnavailable();
      if (DEVELOPMENT) console.error(`[pet-renderer] renderer 提前退出: ${details?.reason || 'unknown'}`);
    });
    if (DEVELOPMENT) {
      // 桌宠窗口没有可见的开发者工具入口，把 renderer 的日志转出来才能排查
      this.win.webContents.on('console-message', (_e, level, message, line, source) => {
        console.log(`[pet-renderer] ${message}  (${String(source).split('/').pop()}:${line})`);
      });
    }
    const markVisible = () => {
      if (this._firstFrameTerminal || this._firstFrameVisible) return;
      this._firstFrameVisible = true;
      this.firstFrameVisibleAt = performance.now();
      this._settleFirstFrame();
    };
    this.win.on('show', markVisible);
    this.win.once('ready-to-show', () => {
      if (!this.win || this.win.isDestroyed() || this._firstFrameTerminal) return;
      try {
        this.placeInitial(saved);
        this.win.show();
        // BrowserWindow 的 show 事件是权威 latch；极简测试 double 若不发事件，
        // 仍可用 isVisible() 兜底，但不会因为一次 false 永久卡死。
        if (this.win.isVisible()) markVisible();
      } catch (error) {
        if (DEVELOPMENT) console.error('[pet-renderer] 显示窗口失败:', error);
        this.failFirstFrame(firstFrameError('POPPET_PET_SHOW_FAILED', '桌宠窗口显示失败'));
        this._notifyUnavailable();
      }
    });
    this.win.on('closed', () => {
      this.failFirstFrame(firstFrameError('POPPET_PET_CLOSED', '桌宠窗口在首帧完成前关闭'));
      this.stopDrag();
      this.win = null;
      this._notifyUnavailable();
    });
    // 起手先穿透：鼠标飘过空白处不该挡住下面的窗口
    this.setInteractive(false);
    this.win.loadFile(path.join(__dirname, '../renderer/pet/index.html'),
      DEVELOPMENT ? { query: { poppetDev: '1' } } : undefined)
      .catch(error => {
        if (DEVELOPMENT) console.error('[pet-renderer] loadFile rejected:', error);
        this.failFirstFrame(firstFrameError('POPPET_PET_LOAD_FAILED', '桌宠页面加载失败'));
        this._notifyUnavailable();
      });
    return this.win;
  }

  markFirstFrameReady() {
    if (this._firstFrameTerminal) {
      return { ready: false, terminal: true, message: this._firstFrameTerminal.message };
    }
    if (this.firstFrameReadyAt !== null) {
      return { ready: true, duplicate: true, readyAt: this.firstFrameReadyAt };
    }
    this.firstFrameReadyAt = performance.now();
    this._settleFirstFrame();
    return { ready: true, duplicate: false, readyAt: this.firstFrameReadyAt };
  }

  waitForFirstFrame(timeoutMs = 5000) {
    if (this._firstFrameTerminal) return Promise.reject(this._firstFrameTerminal);
    if (this._firstFrameSettled) {
      return Promise.resolve({ readyAt: this.firstFrameReadyAt, visibleAt: this.firstFrameVisibleAt });
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.failFirstFrame(firstFrameError('POPPET_PET_FRAME_TIMEOUT', '等待桌宠首个非空帧超时'));
      }, timeoutMs);
      this._firstFrameWaiters.add(waiter);
      this._settleFirstFrame();
    });
  }

  failFirstFrame(error) {
    if (this._firstFrameSettled || this._firstFrameTerminal) return false;
    this._firstFrameTerminal = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this._firstFrameWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this._firstFrameTerminal);
    }
    this._firstFrameWaiters.clear();
    return true;
  }

  _settleFirstFrame() {
    if (this._firstFrameSettled || this._firstFrameTerminal
        || this.firstFrameReadyAt === null || !this._firstFrameVisible) return;
    this._firstFrameSettled = true;
    const result = { readyAt: this.firstFrameReadyAt, visibleAt: this.firstFrameVisibleAt };
    for (const waiter of this._firstFrameWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    this._firstFrameWaiters.clear();
  }

  isFirstFrameLive() {
    return this._firstFrameSettled && !!this.win && !this.win.isDestroyed()
      && this._firstFrameVisible && this.win.isVisible();
  }

  _notifyUnavailable() {
    if (typeof this.onUnavailable !== 'function') return;
    try { this.onUnavailable(this); } catch (error) {
      if (DEVELOPMENT) console.error('[pet-renderer] unavailable 回调失败:', error);
    }
  }

  windowSizeFor(scale, spriteSize) {
    return {
      width: Math.ceil(spriteSize.width * scale * PAD_X),
      height: Math.ceil(spriteSize.height * scale * PAD_Y),
    };
  }

  // 换角色或改缩放后重新定尺寸，尽量保持脚底位置不动
  resize(scale, spriteSize) {
    if (!this.win) return;
    const { width, height } = this.windowSizeFor(scale, spriteSize);
    const [, oldH] = this.win.getSize();
    // 底边不动地换尺寸，桌宠才不会在改大小时"跳"起来
    const x = Math.round(this.pos.x);
    const y = Math.round(this.pos.y) + (oldH - height);
    this.win.setBounds({ x, y, width, height });
    this.pos = { x, y };
    this.clampToDisplay();
  }

  // saved 是上次退出时的位置。给的坐标可能落在已经拔掉的显示器上，
  // 所以一律走 clamp，由它兜到最近的那块屏幕的工作区里。
  placeInitial(saved) {
    const [w, h] = this.win.getSize();
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      this.pos = { x: saved.x, y: saved.y };
      this.setPositionClamped(saved.x, saved.y);
      return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    this.setPositionClamped(
      Math.round(area.x + area.width * 0.72),
      Math.round(area.y + area.height - h));
    // 多只同屏时逐只往左错开，否则新放的几只会精确重叠，看起来像只有一只。
    // 必须在 clamp **之后**再错开：默认角落本来就可能贴着屏幕右边，
    // 先减再 clamp 的话所有槽位都会被压回同一个右边界，错开等于没做。
    const step = 44 * (this.slot || 0);
    if (step) this.setPositionClamped(this.pos.x - step, this.pos.y);
  }

  // 点击穿透：renderer 逐帧测鼠标处的 alpha，只有压在角色身上才把事件收回来。
  // forward:true 是关键——穿透状态下 renderer 仍然收得到 mousemove，否则一旦穿透就再也切不回来。
  setInteractive(on) {
    if (!this.win || this.interactive === on) return;
    this.interactive = on;
    this.win.setIgnoreMouseEvents(!on, { forward: true });
    this.ignoreMouseCalls = (this.ignoreMouseCalls || 0) + 1; // 供回归测试确认初始化那次没被短路吃掉
  }

  startDrag() {
    if (!this.win || this.dragTimer) return;
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = this.win.getPosition();
    this.dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
    // 用定时轮询光标，而不是 -webkit-app-region 或 renderer 的 mousemove：
    // 前者在快速甩动时窗口会脱手，后者一旦划出窗口就收不到事件了。
    this.dragTimer = setInterval(() => {
      if (!this.win) return this.stopDrag();
      const p = screen.getCursorScreenPoint();
      this.pos = { x: p.x - this.dragOffset.x, y: p.y - this.dragOffset.y };
      this.win.setPosition(Math.round(this.pos.x), Math.round(this.pos.y));
      // 窗口是跟着光标走的，光标相对窗口的位置几乎不变，renderer 那边根本收不到 mousemove。
      // 甩动倾角只能由这里把屏幕坐标推过去。
      this.send(CH.PET_DRAG_MOVE, { x: p.x, y: p.y });
    }, DRAG_TICK_MS);
  }

  stopDrag() {
    if (this.dragTimer) { clearInterval(this.dragTimer); this.dragTimer = null; }
    this.dragOffset = null;
  }

  endDrag() {
    if (!this.dragTimer) return;
    this.stopDrag();
    this.clampToDisplay();
    if (this.onDrop) this.onDrop();
  }

  // 走动：renderer 只说"往哪挪多少"，边界与显示器判断都在主进程
  moveBy(dx, dy) {
    if (!this.win || this.dragTimer) return null;
    return this.setPositionClamped(this.pos.x + dx, this.pos.y + dy);
  }

  // x/y 收浮点，内部保留小数，只有真正调 setPosition 时才取整
  setPositionClamped(x, y) {
    const [w, h] = this.win.getSize();
    // 以窗口中心决定归属哪块屏，跨屏走动时才不会突然被拽回来
    const area = screen.getDisplayNearestPoint({
      x: Math.round(x) + (w >> 1), y: Math.round(y) + (h >> 1),
    }).workArea;
    const nx = Math.min(Math.max(x, area.x), area.x + area.width - w);
    const ny = Math.min(Math.max(y, area.y), area.y + area.height - h);
    this.pos = { x: nx, y: ny };
    this.win.setPosition(Math.round(nx), Math.round(ny));
    return {
      x: Math.round(nx), y: Math.round(ny), width: w, height: h,
      atLeft: nx <= area.x + 0.5,
      atRight: nx >= area.x + area.width - w - 0.5,
      atBottom: ny >= area.y + area.height - h - 0.5,
      area,
    };
  }

  clampToDisplay() {
    if (!this.win) return null;
    // 拖拽结束等场景下窗口可能被系统挪过，以实际位置为准重新对齐
    const [x, y] = this.win.getPosition();
    this.pos = { x, y };
    return this.setPositionClamped(x, y);
  }

  bounds() {
    if (!this.win) return null;
    const x = Math.round(this.pos.x), y = Math.round(this.pos.y);
    const [w, h] = this.win.getSize();
    const area = screen.getDisplayNearestPoint({ x: x + (w >> 1), y: y + (h >> 1) }).workArea;
    return { x, y, width: w, height: h, area };
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  destroy() {
    this.failFirstFrame(firstFrameError('POPPET_PET_DESTROYED', '桌宠窗口在首帧完成前被销毁'));
    this.stopDrag();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { PetWindow };

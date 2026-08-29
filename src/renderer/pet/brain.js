// 桌宠的行为状态机：决定每一帧的姿态（缩放/旋转/位移）与表情（眨眼/嘴型）。
//
// 单张立绘的动作全部建立在"整体形变 + 五官覆盖"之上，不切分肢体——只有一张立绘时，
// 平移肢体必然露出没有像素的空洞，而形变与覆盖不会。
//
// 除了 pose，这里还导出一组**运动信号**（this.signals）。它们是同一套运动学的
// 另一种读法：走路的步伐相位、呼吸、离地垂挂、落地冲击、打招呼的抬臂，本来就在
// 下面各个状态里算出来了，只是过去只被折进 6 个整体标量。带关节骨架的角色改为
// 消费这组信号（src/shared/skeleton.js 的 DRIVERS），于是手臂摆动、迈腿这些动作
// 是**算出来**的而不是画出来的——作者画一次部件，不必逐帧作画。
//
// 信号约定：walkSwing / breathe / dangle / wave 取值 [-1, 1]，impact 取 [0, 1]。
// 没有骨架的角色照常只用 pose，这组信号被忽略，行为与从前逐位相同。

const TAU = Math.PI * 2;

const DEFAULT_RIG = { anchor: 'feet', flip: true, motion: 'walk', swayFrom: 0.5 };

// 落地回弹：一条衰减的弹性曲线，值是 scaleY 的目标
function squashCurve(t) {
  if (t >= 1) return 1;
  return 1 - Math.exp(-6 * t) * Math.cos(t * 18) * 0.28;
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// 眨眼时长。0.32s 在 60fps 下约 19 帧，合上/保持/睁开三段都有足够的中间帧。
const BLINK_DUR = 0.32;
const BLINK_MIN = 0.12;   // 不闭到 0：留几像素露出原图的下眼线

const CLOSE_END = 0.40;   // 合上占前 40%
const HOLD_END = 0.55;    // 中间 15% 保持闭合，眨眼才有"停顿"

// 合上快、停一下、睁开慢——照抄真实眼睑的时序，比线性来回自然得多
function blinkCurve(k) {
  if (k < CLOSE_END) {
    const t = k / CLOSE_END;
    return 1 - (1 - BLINK_MIN) * t * t;               // easeIn：越合越快
  }
  if (k < HOLD_END) return BLINK_MIN;
  const t = (k - HOLD_END) / (1 - HOLD_END);
  return BLINK_MIN + (1 - BLINK_MIN) * (1 - (1 - t) * (1 - t)); // easeOut：睁开收得慢
}

export class Brain {
  constructor(settings) {
    this.settings = settings;
    // 角色的骨架属性，决定这只桌宠该被当成"站在地上的"还是"飘着的"。
    // 由管线推断出默认值，用户可以在角色管理里改。
    this.rig = { ...DEFAULT_RIG };
    this.state = 'idle';
    this.stateTime = 0;
    this.stateLimit = 2 + Math.random() * 3;
    this.clock = 0;

    this.facing = 1;          // 1 = 原图朝向，-1 = 水平翻转
    this.walkDir = 1;
    this.walkSpeed = 26;      // 逻辑点/秒（屏幕单位，与精灵大小无关）
    // 位移类动作的幅度一律按精灵高度取比例，不能写死像素。
    // 窗口的纵向余量是按精灵高度成比例给的，跳跃幅度若是常数，
    // 换一张矮的像素图就会超出余量——每被点一下头顶都被窗口切掉。
    this.spriteH = 400;

    this.blink = 1;
    this.mouthOpen = 1;
    this.blinkTimer = this.#nextBlinkDelay();
    this.blinkPhase = null;   // { t, dur, double }

    // sway：下摆的横向摆幅（精灵像素）。渲染时按 y 位置加权成非线性形变，
    // 让裙摆/发梢跟着步伐甩，而脚底保持不动——不拆肢体也能有"在走"的观感。
    this.pose = { scaleX: 1, scaleY: 1, rotate: 0, offsetX: 0, offsetY: 0, sway: 0 };
    // 关节骨架消费的运动信号。名字与 src/shared/skeleton.js 的 DRIVERS 一一对应，
    // 中间没有翻译表可以漂移；一致性由 test/runtime/skeleton-drivers.test.mjs 守住。
    this.signals = { walkSwing: 0, breathe: 0, dangle: 0, impact: 0, wave: 0 };
    this.moveIntent = { dx: 0, dy: 0 };

    this.dragVX = 0;          // 拖拽时的水平速度，用来给身体一个甩动的倾角
    this.lastDragX = null;
  }

  updateSettings(s) { this.settings = s; }

  setSpriteHeight(h) { if (h > 0) this.spriteH = h; }

  // 换角色时 rig 必须整份替换，不能增量合并：
  // 旧角色的 character.json 里没有 rig 字段，合并的话会继承上一只的设置。
  // 另外 flip 关掉时要把 facing 归位——所有写 facing 的地方都被 flip 守着，
  // 一旦关掉就再没人能把它改回来，侧面立绘会一直保持镜像。
  setRig(rig) {
    this.rig = { ...DEFAULT_RIG, ...(rig || {}) };
    if (!this.rig.flip) this.facing = 1;
  }

  get grounded() { return this.rig.anchor !== 'center'; }

  // 把"精灵高度的百分比"换算成精灵像素
  #amp(ratio) { return this.spriteH * ratio; }

  #nextBlinkDelay() { return 2.2 + Math.random() * 4.0; }

  setState(name, limit) {
    this.state = name;
    this.stateTime = 0;
    this.stateLimit = limit ?? (2 + Math.random() * 3);
    if (this.onStateChange) this.onStateChange(name, this.stateLimit, this.walkDir);
  }

  // 外部事件 ---------------------------------------------------------------

  onGrab() {
    this.setState('drag', Infinity);
    this.lastDragX = null;
    this.dragVX = 0;
  }

  onDrop() {
    // 飘着的角色没有"落地"，压扁反而怪；给一段上下回弹当作稳住身形
    this.setState(this.grounded ? 'land' : 'settle', 0.75);
    this.dragVX = 0;
  }

  // 由 mouseup 调用，此时状态一定还是 drag（mousedown 设的），所以这里不能拿 drag 当守卫——
  // 那会把每一次单击都吞掉，紧接着到达的 PET_DROPPED 再把它变成落地压扁。
  onPoke() {
    // 飘着的角色不"蹦"，改成晃一晃
    const moves = this.grounded ? ['hop', 'shake'] : ['settle', 'shake'];
    this.setState(moves[(Math.random() * moves.length) | 0], 0.85);
  }

  // 托盘菜单与开发期演示脚本都走这里
  onCommand(action) {
    switch (action) {
      case 'greet': this.setState('greet', 1.5); break;
      case 'blink': this.blinkPhase = { t: 0, dur: BLINK_DUR, double: false }; break;
      case 'walk':
        this.walkDir = Math.random() < 0.5 ? -1 : 1;
        if (this.rig.flip) this.facing = this.walkDir;
        // 让 rig 决定用哪种步态：飘着的角色不该踩出地面步伐
        this.setState(this.rig.motion === 'float' ? 'float' : 'walk', 4);
        break;
      case 'hop': case 'shake': this.setState(action, 0.85); break;
      case 'drag': this.onGrab(); break;
      case 'land': this.onDrop(); break;
      case 'idle': this.setState('idle', 4); break;
    }
  }

  // 拖拽中由外部喂入光标横向位移，用于计算倾角
  feedDrag(screenX) {
    if (this.lastDragX !== null) {
      const dv = screenX - this.lastDragX;
      this.dragVX = this.dragVX * 0.7 + dv * 0.3;
    }
    this.lastDragX = screenX;
  }

  // 主更新 -----------------------------------------------------------------

  update(dt, env) {
    this.clock += dt;
    this.stateTime += dt;
    this.moveIntent.dx = 0;
    this.moveIntent.dy = 0;

    // 表情与姿态每帧都先归位，再由眨眼计时器和当前状态去覆盖。
    this.blink = 1;
    this.mouthOpen = 1;
    const p = this.pose;
    p.scaleX = 1; p.scaleY = 1; p.rotate = 0; p.offsetX = 0; p.offsetY = 0; p.sway = 0;
    const sg = this.signals;
    sg.walkSwing = 0; sg.breathe = 0; sg.dangle = 0; sg.impact = 0; sg.wave = 0;

    this.#updateBlink(dt);

    switch (this.state) {
      case 'idle': this.#idle(dt, env); break;
      case 'walk': this.#walk(dt, env); break;
      case 'float': this.#float(dt, env); break;
      case 'settle': this.#settle(dt); break;
      case 'drag': this.#drag(dt); break;
      case 'land': this.#land(dt); break;
      case 'hop': this.#hop(dt); break;
      case 'shake': this.#shake(dt); break;
      case 'greet': this.#greet(dt); break;
      default: this.setState('idle');
    }
    return this.pose;
  }

  #updateBlink(dt) {
    // 眨眼独立于行为状态，任何时候都在走
    if (this.blinkPhase) {
      const b = this.blinkPhase;
      b.t += dt;
      const k = b.t / b.dur;
      if (k >= 1) {
        this.blink = 1;
        if (b.double) this.blinkPhase = { t: 0, dur: BLINK_DUR * 0.8, double: false };
        else { this.blinkPhase = null; this.blinkTimer = this.#nextBlinkDelay(); }
      } else {
        this.blink = blinkCurve(k);
      }
      return;
    }
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkPhase = { t: 0, dur: BLINK_DUR, double: Math.random() < 0.22 };
    }
  }

  #breathe(amp = 0.018) {
    const s = Math.sin((this.clock / 3.1) * TAU);
    this.pose.scaleY = 1 + s * amp;
    this.pose.scaleX = 1 - s * amp * 0.6; // 体积守恒的错觉，比单轴缩放自然
    // 骨架角色的呼吸走同一条正弦，幅度由 amp 相对默认值缩放，
    // 所以"轻呼吸"（#shake 里的 0.008）在骨架上同样是轻的。
    this.signals.breathe = s * (amp / 0.018);
  }

  #idle(dt, env) {
    this.#breathe();
    // 极缓慢的左右重心摆动
    this.pose.rotate = Math.sin((this.clock / 7.3) * TAU) * 0.012;
    // 飘着的角色即使待机也该有上下浮动，否则看起来是"卡在空中"
    if (!this.grounded) this.pose.offsetY = Math.sin((this.clock / 2.6) * TAU) * this.#amp(0.012);
    if (this.stateTime < this.stateLimit) return;
    const canMove = this.settings.wander && this.rig.motion !== 'idle';
    if (canMove && Math.random() < 0.55) {
      this.walkDir = Math.random() < 0.5 ? -1 : 1;
      // 侧面立绘不能翻转——翻过去就成了脸朝后倒退走
      if (this.rig.flip) this.facing = this.walkDir;
      this.setState(this.rig.motion === 'float' ? 'float' : 'walk', 1.8 + Math.random() * 3.5);
    } else {
      this.setState('idle', 2.5 + Math.random() * 4);
    }
  }

  #walk(dt, env) {
    if (!this.settings.wander) { this.setState('idle'); return; }
    // 单张立绘拆不出腿，"在走"这件事全靠这四层叠出来：
    // 抬起-落下的起伏、落脚瞬间的压实、重心左右晃、以及下摆的甩动。
    const step = (this.clock / 0.52) * TAU;
    const stride = Math.abs(Math.sin(step));      // 0 = 刚落脚，1 = 抬到最高
    this.pose.offsetY = -stride * this.#amp(0.013);

    const impact = Math.pow(1 - stride, 3);       // 只在落脚那一瞬间接近 1
    this.pose.scaleY = 1 - impact * 0.03;
    this.pose.scaleX = 1 + impact * 0.02;
    // 关节骨架的迈步与摆臂：半频，一个完整的前后周期正好对应两步，
    // 和下面的重心摇摆、裙摆甩动同相。左右肢体靠作者写的负 gain 反相。
    this.signals.walkSwing = Math.sin(step * 0.5) * this.walkDir;
    this.signals.impact = impact;

    // 左右摇摆和裙摆甩动都是半频的：一个完整的左右周期对应两步
    this.pose.offsetX = Math.sin(step * 0.5) * this.#amp(0.004) * this.walkDir;
    if (this.rig.swayFrom !== null) {
      this.pose.sway = -Math.sin(step * 0.5) * this.#amp(0.038) * this.walkDir;
    }
    this.pose.rotate = this.walkDir * (0.018 + Math.sin(step) * 0.022);

    this.moveIntent.dx = this.walkDir * this.walkSpeed * dt;

    this.#bounceOffEdges(env);
    if (this.stateTime >= this.stateLimit) this.setState('idle', 2 + Math.random() * 4);
  }

  // 撞到工作区左右边就掉头，不会卡在墙上
  #bounceOffEdges(env) {
    if (env.atLeft && this.walkDir < 0) { this.walkDir = 1; if (this.rig.flip) this.facing = 1; }
    if (env.atRight && this.walkDir > 0) { this.walkDir = -1; if (this.rig.flip) this.facing = -1; }
  }

  // 悬浮移动：没有步伐，靠上下起伏和轻微摇摆推进
  #float(dt, env) {
    if (!this.settings.wander) { this.setState('idle'); return; }
    const t = this.clock * TAU;
    this.pose.offsetY = Math.sin(t / 1.9) * this.#amp(0.022);
    this.pose.rotate = Math.sin(t / 2.7) * 0.045 * this.walkDir;
    // 飘着的角色四肢是垂着的，并随起伏轻摆
    this.signals.dangle = 0.6 + Math.sin(t / 1.9) * 0.3;
    if (this.rig.swayFrom !== null) {
      this.pose.sway = Math.sin(t / 2.3) * this.#amp(0.03) * this.walkDir;
    }
    this.moveIntent.dx = this.walkDir * this.walkSpeed * 0.7 * dt;
    this.#bounceOffEdges(env);
    if (this.stateTime >= this.stateLimit) this.setState('idle', 2 + Math.random() * 4);
  }

  // 悬浮角色被放下后的稳定动作：上下回弹，不做压扁
  #settle(dt) {
    const k = Math.min(1, this.stateTime / this.stateLimit);
    const damp = 1 - easeOutCubic(k);
    this.pose.offsetY = Math.sin(k * Math.PI * 3) * this.#amp(0.03) * damp;
    this.pose.rotate = Math.sin(k * Math.PI * 4) * 0.05 * damp;
    if (k >= 1) this.setState('idle', 1.5 + Math.random() * 3);
  }

  #drag(dt) {
    // 被拎起来：身体略微拉长，并按甩动速度倾斜
    this.pose.scaleY = 1.07;
    this.pose.scaleX = 0.95;
    this.pose.rotate = Math.max(-0.22, Math.min(0.22, -this.dragVX * 0.012));
    // 被拎起来时四肢完全离地垂挂；甩动速度让它们滞后，就是惯性的观感。
    this.signals.dangle = Math.max(-1, Math.min(1, 1 - this.dragVX * 0.02));
    this.dragVX *= 0.88;
    this.pose.offsetY = -this.#amp(0.00375);
  }

  #land(dt) {
    const k = Math.min(1, this.stateTime / this.stateLimit);
    const sy = squashCurve(k);
    this.pose.scaleY = sy;
    this.pose.scaleX = 1 + (1 - sy) * 0.75; // 压扁时横向撑开
    // 压得越扁，膝肘屈得越深。sy 小于 1 才是压缩，回弹过冲的部分不该反向掰关节。
    this.signals.impact = Math.max(0, Math.min(1, (1 - sy) * 4));
    if (this.stateTime >= this.stateLimit) this.setState('idle', 1.5 + Math.random() * 3);
  }

  #hop(dt) {
    const k = Math.min(1, this.stateTime / this.stateLimit);
    const jump = Math.sin(k * Math.PI);
    this.pose.offsetY = -jump * this.#amp(0.04);
    this.pose.scaleY = 1 + jump * 0.06;
    this.pose.scaleX = 1 - jump * 0.04;
    this.signals.dangle = jump;          // 腾空时腿离地
    this.signals.impact = 1 - jump;      // 起跳与落地两端屈膝
    if (k >= 1) this.setState(this.grounded ? 'land' : 'settle', 0.4);
  }

  #shake(dt) {
    const k = this.stateTime / this.stateLimit;
    const damp = 1 - easeOutCubic(Math.min(1, k));
    this.pose.rotate = Math.sin(this.stateTime * 26) * 0.09 * damp;
    this.signals.wave = Math.sin(this.stateTime * 26) * 0.25 * damp;
    this.#breathe(0.008);
    if (k >= 1) this.setState('idle', 1.5 + Math.random() * 3);
  }

  #greet(dt) {
    const k = Math.min(1, this.stateTime / this.stateLimit);
    // 两次弹跳 + 张嘴
    const jump = Math.abs(Math.sin(k * Math.PI * 2));
    this.pose.offsetY = -jump * this.#amp(0.0325);
    this.pose.rotate = Math.sin(k * Math.PI * 4) * 0.05;
    this.mouthOpen = 1 + 0.7 * Math.sin(k * Math.PI);
    // 抬臂用一条 0->1->0 的包络，摆动叠在包络上：手先举起来再挥，
    // 而不是从垂着的位置直接横向抽动。
    const raise = Math.sin(Math.min(1, k) * Math.PI);
    this.signals.wave = raise * (0.75 + 0.25 * Math.sin(k * Math.PI * 8));
    if (k >= 1) { this.mouthOpen = 1; this.signals.wave = 0; this.setState('idle', 2 + Math.random() * 3); }
  }
}

// 桌宠窗口主循环：加载角色、驱动状态机、渲染、处理鼠标与点击穿透。

import { Sprite, hasVisibleStagePixel } from './sprite.js';
import { Brain } from './brain.js';
import { effectiveFrameMs, poseDrawKey } from './render-policy.js';

const QUERY = new URLSearchParams(location.search);
const POPPET_DEV = QUERY.get('poppetDev') === '1';

// 帧率。一开始按"像素风踩帧更对味"选了 12，那个理由对走路成立，对眨眼是纯缺陷：
// 0.3 秒的动作在 12 帧下只画得出两三帧，看着就是"闪一下"。
// 踩帧感其实来自位移的整数像素对齐，不需要靠低帧率去凑。
const DEFAULT_FPS = 60;
let frameMs = 1000 / DEFAULT_FPS;
const BOTTOM_MARGIN_RATIO = 0.035;
const CLICK_MOVE_TOLERANCE = 4; // 位移小于这个数才算"点了一下"而不是拖拽

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const firstFrameProbe = document.createElement('canvas');

let sprite = null;
let charId = null;   // 多只同屏时，回归测试要能确认每个窗口拿到的是它自己的角色
let brain = null;
let settings = null;
let running = false;

let dpr = window.devicePixelRatio || 1;
let drawScale = 1;
let interactive = false;
let dragging = false;
let pressPoint = null;
let lastEnv = { atLeft: false, atRight: false };
let moveInFlight = false;
let firstFrameAcked = false;
let firstFrameAckInFlight = false;
let nextFirstFrameProbeAt = 0;
// idle 降频的"近期交互"锚点与上一实绘帧的量化姿态身份（见 render-policy.js）
let lastActivityAt = performance.now();
let lastDrawKey = null;

function markActivity() {
  lastActivityAt = performance.now();
}

// ---------- 初始化 ----------

async function boot() {
  const { character, settings: s } = await window.pet.ready();
  settings = s;
  brain = new Brain(settings);
  brain.onStateChange = (name, limit, dir) => {
    markActivity(); // 状态切换后保持一段全速，动作衔接不掉帧
    window.pet?.log?.(`state=${name} limit=${limit.toFixed(2)} dir=${dir} wander=${settings.wander}`);
  };
  if (character) await setCharacter(character);
  bindEvents();
  if (!running) { running = true; requestAnimationFrame(loop); }
}

async function setCharacter(character) {
  charId = character ? character.id : null;
  lastDrawKey = null;
  markActivity();
  if (!character) { sprite = null; return; }
  sprite = new Sprite(character);
  await sprite.load(character);
  brain?.setSpriteHeight(sprite.size.height);
  brain?.setRig(character.meta.rig);
  resize();
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.imageSmoothingEnabled = false;
  drawScale = (settings?.scale ?? 0.5) * dpr;
  const fps = Math.min(120, Math.max(8, settings?.fps || DEFAULT_FPS));
  frameMs = 1000 / fps;
}

// ---------- 渲染 ----------

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!sprite) return;

  const p = brain.pose;
  const composed = sprite.compose(brain.blink, brain.mouthOpen);
  const w = sprite.size.width * drawScale;
  const h = sprite.size.height * drawScale;
  const footY = (sprite.meta.footY ?? sprite.size.height - 1) * drawScale;

  // 站立角色以脚底为锚点，呼吸/压扁/跳跃都相对地面；
  // 悬浮角色以自身中心为锚点，否则它会被强行贴在窗口底边上。
  const grounded = brain.rig.anchor !== 'center';
  const anchorX = canvas.width / 2 + p.offsetX * drawScale;
  const anchorY = grounded
    ? canvas.height * (1 - BOTTOM_MARGIN_RATIO) + p.offsetY * drawScale
    : canvas.height / 2 + p.offsetY * drawScale;
  const originY = grounded ? footY : h / 2;

  ctx.save();
  ctx.translate(anchorX, anchorY);
  ctx.rotate(p.rotate);
  ctx.scale(brain.facing * p.scaleX, p.scaleY);
  drawBody(composed, w, h, originY, p.sway * drawScale);
  ctx.restore();
}

// 分段绘制，越靠下横向偏移越大，脚底再收敛回 0。
// 效果相当于给整张图施加一个纵向渐变的水平剪切：裙摆和发梢会跟着步伐甩，
// 而人还牢牢站在地上。drawImage 只能做仿射变换，做不出这种非线性形变，只能拆成条带画。
// 剪切变形是靠一条条横带拼出来的，带与带之间必然有 1px 台阶。
// 台阶密度取决于带高：对 400px 高的精灵切 28 条（每条 14 行）看不出来，
// 同样切 28 条到 60px 高的小图上就是每条 2 行，整只角色会被撕成横纹。
// 所以固定的是"每条多少行"，不是"切多少条"。
const SWAY_ROWS_PER_BAND = 14;
const SWAY_MIN_PX = 1.2;   // 摆幅小于这个数就整体画，省得为零点几像素抖出台阶

function drawBody(composed, w, h, originY, swayPx) {
  const waist = brain.rig.swayFrom;
  if (waist === null || waist === undefined || Math.abs(swayPx) < SWAY_MIN_PX) {
    ctx.drawImage(composed, -w / 2, -originY, w, h);
    return;
  }
  const srcW = sprite.size.width;
  const srcH = sprite.size.height;
  const rows = Math.max(1, Math.min(SWAY_ROWS_PER_BAND, Math.ceil(srcH / 4))); // 至少切 4 条
  const grounded = brain.rig.anchor !== 'center';
  for (let sy = 0; sy < srcH; sy += rows) {
    const sh = Math.min(rows, srcH - sy);
    const k = (sy + sh / 2) / srcH;          // 0 = 头顶，1 = 底边
    // 腰线以上完全不动。摊得太开的话每一行都挪一点，看着像整个人在平移，
    // 恰恰是要避免的那种"滑行感"。
    let amp = k <= waist ? 0 : Math.pow((k - waist) / (1 - waist), 2);
    // 站着的角色脚要钉在地上；飘着的角色没这个约束，下摆可以一直甩到底
    if (grounded && k > 0.93) amp *= (1 - k) / 0.07;
    ctx.drawImage(
      composed, 0, sy, srcW, sh,
      -w / 2 + swayPx * amp, -originY + sy * drawScale, w, sh * drawScale,
    );
  }
}

// ---------- 主循环 ----------

// 节流用"距上次真正渲染过了多久"来判，并且留一点容差。
//
// 原来的写法是累加 elapsed、够一帧就渲染然后 acc 清零。当目标帧率接近显示器刷新率时，
// 这个写法会每隔一帧丢一帧：60Hz 屏上 rAF 的间隔是 16.6~16.7ms，而 1000/60 = 16.667，
// acc 常常差零点几毫秒凑不满 -> 整帧跳过 -> 下一帧 acc 变成 33.3ms 才渲染，
// 清零又把余量丢掉，于是循环往复。实测目标 60fps 只画到 38fps，
// 而且 dt 在 16.7 / 33.4ms 之间来回跳——**动画快的时候（点一下的跳跃、眨眼）就是肉眼可见的一卡一卡**。
// 30fps 和 12fps 同样受影响（21.9 / 10.9），只是 dt 摆幅相对小、不容易察觉。
//
// 容差取 min(2ms, 帧时长的 20%)：2ms 足够吸收 rAF 的抖动，
// 又远小于任何两档帧率之间的间隔，不会让低帧率档偷偷跑快。
const FRAME_TOLERANCE_MS = 2;

let lastRenderTime = performance.now();

// 渲染节拍探针。这个 bug 静默存在了整整一轮——目标 60fps 实际只画 38fps，
// 除了"看着有点卡"没有任何症状。加个计数器让 --test-click 能把它测出来。
// skipped：因视觉等同而被有意跳过的帧（省电优化的观测口径）。目前没有任何
// 跳帧路径，计数恒为 0；先落计量口径，让未来的 A/B 有基线可比。
const pace = { n: 0, dtMin: Infinity, dtMax: 0, t0: performance.now(),
               raf: 0, work: 0, workMax: 0, composeMiss: 0, skipped: 0 };
const INTERVAL_BUCKET_MAX_MS = 250;
const intervalDistribution = POPPET_DEV ? {
  counts: new Uint32Array(INTERVAL_BUCKET_MAX_MS + 1),
  overflowCount: 0,
  intervalCount: 0,
  longFrameCount: 0,
} : null;

function recordRenderedInterval(intervalMs) {
  if (!intervalDistribution || !Number.isFinite(intervalMs) || intervalMs < 0) return;
  intervalDistribution.intervalCount++;
  if (intervalMs > frameMs * 2) intervalDistribution.longFrameCount++;
  const bucket = Math.floor(intervalMs);
  if (bucket <= INTERVAL_BUCKET_MAX_MS) intervalDistribution.counts[bucket]++;
  else intervalDistribution.overflowCount++;
}

function intervalPercentile(fraction) {
  if (!intervalDistribution?.intervalCount) return null;
  const rank = Math.ceil(intervalDistribution.intervalCount * fraction);
  let seen = 0;
  for (let i = 0; i < intervalDistribution.counts.length; i++) {
    seen += intervalDistribution.counts[i];
    if (seen >= rank) return i + 0.5;
  }
  // The requested percentile landed in the open-ended overflow bucket. Returning
  // null is honest; 251 would be a fabricated upper bound.
  return null;
}

const paceApi = {
  miss() { pace.composeMiss++; },
  reset() { pace.n = 0; pace.dtMin = Infinity; pace.dtMax = 0; pace.t0 = performance.now();
            pace.raf = 0; pace.work = 0; pace.workMax = 0; pace.composeMiss = 0;
            pace.skipped = 0;
            intervalDistribution?.counts.fill(0);
            if (intervalDistribution) {
              intervalDistribution.overflowCount = 0;
              intervalDistribution.intervalCount = 0;
              intervalDistribution.longFrameCount = 0;
            } },
  read() {
    const sec = (performance.now() - pace.t0) / 1000;
    return { fps: sec > 0 ? pace.n / sec : 0, targetFps: 1000 / frameMs,
             dtMin: pace.dtMin, dtMax: pace.dtMax, samples: pace.n,
             rafHz: sec > 0 ? pace.raf / sec : 0,
             workAvg: pace.n ? pace.work / pace.n : 0, workMax: pace.workMax,
             composeMiss: pace.composeMiss,
             skippedFrameCount: pace.skipped,
             intervalCount: intervalDistribution?.intervalCount || 0,
             intervalP50Ms: intervalPercentile(0.50),
             intervalP95Ms: intervalPercentile(0.95),
             intervalP99Ms: intervalPercentile(0.99),
             longFrameCount: intervalDistribution?.longFrameCount || 0,
             intervalHistogram: intervalDistribution ? {
               bucketWidthMs: 1,
               maxBucketMs: INTERVAL_BUCKET_MAX_MS,
               counts: Array.from(intervalDistribution.counts),
               overflowCount: intervalDistribution.overflowCount,
             } : null };
  },
};

// 锁屏/系统休眠时由主进程下发 power-pause：桌宠本来就看不见，rAF 却仍在
// 每个 vsync 唤醒 renderer 并逼合成器工作。暂停 = 不再续订 rAF，整个
// renderer 归于安静；恢复 = 重置节拍基准后重新进入循环。
// 首帧确认前绝不暂停（确认需要真实绘制），恢复对未暂停者是无害 no-op。
let powerPaused = false;

function applyPowerCommand(action) {
  if (action === 'power-pause') {
    if (firstFrameAcked) powerPaused = true;
    return true;
  }
  if (action === 'power-resume') {
    if (powerPaused) {
      powerPaused = false;
      lastRenderTime = performance.now(); // 别把整段锁屏时长算成一个巨帧
      markActivity(); // 解锁瞬间全速恢复，第一眼不能是降频的
      requestAnimationFrame(loop);
    }
    return true;
  }
  return false;
}

function loop(now) {
  if (powerPaused) return; // 不续订：暂停期间零唤醒
  requestAnimationFrame(loop);
  pace.raf++;
  // 真静息时把节拍放慢；任何交互/状态/临近眨眼立即回到 frameMs 全速。
  const effMs = brain ? effectiveFrameMs({
    frameMs,
    firstFrameAcked,
    dragging,
    state: brain.state,
    blinkActive: !!brain.blinkPhase,
    blinkTimer: brain.blinkTimer,
    sinceActivityMs: now - lastActivityAt,
  }) : frameMs;
  const since = now - lastRenderTime;
  if (since < effMs - Math.min(FRAME_TOLERANCE_MS, effMs * 0.2)) return;
  const dt = Math.min(since, effMs * 4) / 1000; // 卡顿后不要一次补太多，免得瞬移
  lastRenderTime = now;
  pace.n++;
  if (since < pace.dtMin) pace.dtMin = since;
  if (since > pace.dtMax) pace.dtMax = since;
  recordRenderedInterval(since);

  if (!brain) return;
  const w0 = performance.now();
  // 先按行为状态选段，再推进：反过来会让切段当帧多播一帧上一段的画面。
  sprite?.setClip(brain.state);
  sprite?.tick(dt);
  brain.update(dt, lastEnv);
  applyMoveIntent();
  // 骨架角色：把本帧的运动信号解算成关节档位。必须排在 brain.update 之后——
  // 信号是这一帧算出来的，早一步取到的是上一帧的姿势。
  // 返回的档位串直接当 frameKey 用，跳帧判定因此对骨架角色一样成立。
  const boneKey = sprite
    ? sprite.applySignals(brain.signals, brain.blink, brain.mouthOpen) : null;
  // 量化姿态与上一实绘帧相同就跳过绘制：画布仍持有与屏幕逐像素一致的
  // 内容（点击穿透 alpha 采样因此天然正确）。首帧确认前与拖拽中永不跳。
  const key = sprite && firstFrameAcked && !dragging ? poseDrawKey({
    charId,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    drawScale,
    facing: brain.facing,
    pose: brain.pose,
    spriteWidth: sprite.size.width,
    spriteHeight: sprite.size.height,
    frameKey: boneKey
      ?? (sprite.frames
        ? `f${sprite.frameIndex}`
        : `${brain.blink.toFixed(3)}|${brain.mouthOpen.toFixed(3)}`),
  }) : null;
  if (key !== null && key === lastDrawKey) {
    pace.skipped++;
  } else {
    render();
    lastDrawKey = key;
  }
  maybeAckFirstFrame(now);
  const w = performance.now() - w0;
  pace.work += w;
  if (w > pace.workMax) pace.workMax = w;
}

function maybeAckFirstFrame(now = performance.now()) {
  if (firstFrameAcked || firstFrameAckInFlight || !sprite) return;
  if (now < nextFirstFrameProbeAt) return;
  nextFirstFrameProbeAt = now + 100;
  // render() 已把这一帧画进 stage；从实际 final stage 复制到有界 probe 再
  // readback。Sprite 离屏图即使不透明，也不能替代被裁掉/清空后的最终画面。
  try {
    if (!hasVisibleStagePixel(canvas, firstFrameProbe)) return;
  } catch {
    return; // GPU/context 瞬时 readback 失败由下一次有界探测重试。
  }
  firstFrameAckInFlight = true;
  window.pet.frameReady().then((response) => {
    if (response?.ready || response?.terminal) firstFrameAcked = true;
    else nextFirstFrameProbeAt = 0;
  }).catch(() => {
    // 临时 IPC 失败允许下一帧重试；in-flight 门闩避免逐帧洪泛。
    nextFirstFrameProbeAt = 0;
  }).finally(() => { firstFrameAckInFlight = false; });
}

function applyMoveIntent() {
  const { dx, dy } = brain.moveIntent;
  if ((dx === 0 && dy === 0) || dragging || moveInFlight) return;
  moveInFlight = true;
  window.pet.moveBy(dx, dy).then((res) => {
    moveInFlight = false;
    if (res) lastEnv = res;
  }).catch(() => { moveInFlight = false; });
}

// ---------- 输入 ----------

// 点击穿透：直接查主画布该点的 alpha。比反算变换矩阵可靠——
// 呼吸、旋转、翻转全都已经烘进画面里了。
function hitTest(clientX, clientY) {
  const x = Math.round(clientX * dpr);
  const y = Math.round(clientY * dpr);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
  return ctx.getImageData(x, y, 1, 1).data[3] > 8;
}

function bindEvents() {
  window.addEventListener('mousemove', (e) => {
    if (dragging) return; // 拖拽中的位移由主进程推送，见 onDragMove
    const on = hitTest(e.clientX, e.clientY);
    if (on !== interactive) {
      markActivity();
      interactive = on;
      window.pet.setInteractive(on);
      document.body.style.cursor = on ? 'grab' : 'default';
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) { window.pet.contextMenu(); return; }
    if (e.button !== 0 || !hitTest(e.clientX, e.clientY)) return;
    markActivity();
    pressPoint = { x: e.screenX, y: e.screenY };
    dragging = true;
    document.body.style.cursor = 'grabbing';
    brain.onGrab();
    window.pet.dragStart();
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    markActivity();
    dragging = false;
    document.body.style.cursor = interactive ? 'grab' : 'default';
    window.pet.dragEnd();
    const moved = pressPoint
      ? Math.hypot(e.screenX - pressPoint.x, e.screenY - pressPoint.y)
      : 0;
    pressPoint = null;
    // 没怎么动就是"戳了一下"，动了才算拖拽落地
    if (moved < CLICK_MOVE_TOLERANCE) brain.onPoke();
    else brain.onDrop();
  });

  window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.pet.contextMenu(); });
  window.addEventListener('dragstart', (e) => e.preventDefault());
  window.addEventListener('resize', resize);

  window.pet.onCharacter(async (c) => { await setCharacter(c); });
  window.pet.onSettings((s) => {
    markActivity();
    settings = s;
    brain.updateSettings(s);
    resize();
    if (!s.clickThrough) { interactive = true; window.pet.setInteractive(true); }
  });
  window.pet.onCommand(({ action }) => {
    if (applyPowerCommand(action)) return;
    markActivity();
    brain.onCommand(action);
  });
  window.pet.onDragMove(({ x }) => { if (dragging) brain.feedDrag(x); });
  // 这条只兜"主进程单方面结束了拖拽"的底。
  // 本地 mouseup 已经自己决定了是 poke 还是 drop，没有 state 守卫的话，
  // 随后到达的 PET_DROPPED 会把刚起步的单击反应动画踩成落地压扁。
  window.pet.onDropped(() => {
    if (!dragging && brain.state === 'drag') brain.onDrop();
  });
}

if (POPPET_DEV) {
  import('../dev/pet-hooks.js').then(({ installPetHooks }) => installPetHooks({
    pace: paceApi,
    act: (action) => brain && brain.onCommand(action),
    charId: () => charId,
    state: () => brain?.state,
    blink: () => brain?.blink,
    pose: () => brain?.pose,
    blinking: () => !!brain?.blinkPhase,
    sourceDataURL: () => sprite?.spriteImg?.src || null,
    atlasDataURL: () => sprite?.atlasImg?.src || null,
    meta: () => sprite?.meta ? structuredClone(sprite.meta) : null,
    frameReady: () => firstFrameAcked,
  })).catch((error) => console.error('开发钩子加载失败:', error));
}

boot().catch((err) => {
  // preload 若没挂上，window.pet 是 undefined，这里不能再依赖它
  console.error('桌宠启动失败:', err);
  window.pet?.log?.('boot failed: ' + err.message);
});

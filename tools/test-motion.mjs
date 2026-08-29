// 动作在真实帧率下还剩多少可见运动。
//
// 这类 bug 不会报错、不会掉帧、profiler 上一切正常：动画照跑，
// 只是振幅被阻尼压到了亚像素级，最近邻绘制一吸附就变成 1px 来回闪，
// 用户看到的就是“卡”。
//
// 做法：按真实帧率驱动 brain，把每帧的姿态换算成设备像素，
// 看轨迹里有多少帧其实完全没动、单帧跳变有多大、总行程够不够。
//
// 用法: node tools/test-motion.mjs [--trace 状态名]
import { Brain } from '../src/renderer/pet/brain.js';

const FPS = 50;              // 100Hz 屏上目标 60fps 的实际渲染帧率（实测）
const SPRITE_H = 400;        // 默认角色高度
const DRAW_SCALE = 1.0;      // scale 0.5 × dpr 2
const TRACE = process.argv.includes('--trace') ? process.argv[process.argv.indexOf('--trace') + 1] : null;

// 姿态 -> 屏幕上最能被看见的那个量（设备像素）。
// 平移直接算；缩放/旋转折算成角色边缘移动了多少像素。
function visibleOffsets(pose) {
  const h = SPRITE_H * DRAW_SCALE;
  return {
    y: pose.offsetY * DRAW_SCALE,
    x: pose.offsetX * DRAW_SCALE,
    squash: (pose.scaleY - 1) * h,          // 脚踩地时头顶的位移
    rot: pose.rotate * h * 0.5,             // 头顶因旋转产生的横向位移
  };
}

function snap(brain) {
  const v = visibleOffsets(brain.pose);
  return {
    state: brain.state,
    // 最近邻绘制会把位置吸附到整数设备像素——亚像素运动在屏幕上根本不存在
    y: Math.round(v.y), squash: Math.round(v.squash), rot: Math.round(v.rot),
    blink: brain.blink, blinking: !!brain.blinkPhase,
  };
}

function run(state, seconds) {
  const brain = new Brain({ wander: true });
  brain.setSpriteHeight(SPRITE_H);
  brain.setRig({ anchor: 'feet', flip: true, motion: 'walk', swayFrom: 0.5 });
  const env = { width: 1600, height: 1000, x: 800, y: 500 };
  const dt = 1 / FPS;
  const rows = [];
  // 先空跑几帧再触发动作：突变最容易发生在**进入状态的第一帧**，
  // 从触发之后才开始采样的话，那一跳正好落在采样窗口之外。
  const LEAD = 4;
  for (let f = 0; f < LEAD; f++) { brain.update(dt, env); rows.push(snap(brain)); }
  brain.onCommand(state);
  for (let f = 0; f * dt < seconds; f++) {
    brain.update(dt, env);
    rows.push(snap(brain));
    if (brain.state === 'idle' && f > 3) break;
  }
  return rows;
}

// 只统计这个动作"本来想动"的那个通道，别的通道恒为 0 会把指标稀释掉
function analyse(rows, channel) {
  const vals = rows.map(r => r[channel]);
  const span = Math.max(...vals) - Math.min(...vals);
  let still = 0, maxJump = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = Math.abs(vals[i] - vals[i - 1]);
    if (d === 0) still++; else maxJump = Math.max(maxJump, d);
  }
  return { frames: vals.length, span, stillRatio: rows.length > 1 ? still / (rows.length - 1) : 1, maxJump, vals };
}

// span：整个动作在屏幕上的总行程。小于 6px 的动作在 400px 高的角色上根本看不出是动作。
// stillRatio：连续两帧完全一样的比例。超过 0.75 说明大半时间画面是静止的，
//   而状态机还在跑——这正是"卡"的观感来源。
// maxJump：单帧跳变。超过 span 的一半说明运动被采样得太稀，会看到瞬移。
// 姿态动作不许让表情在一帧内突变。自然眨眼本身是快动作，所以它的帧要排除。
const MAX_BLINK_STEP = 0.12;

function checkBlinkContinuity(rows) {
  let worst = 0, at = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].blinking || rows[i - 1].blinking) continue;   // 自然眨眼本来就快
    const d = Math.abs(rows[i].blink - rows[i - 1].blink);
    if (d > worst) { worst = d; at = i; }
  }
  return { worst, at };
}

const CASES = [
  { action: 'hop', channel: 'y', seconds: 2.0, minSpan: 8 },
  { action: 'shake', channel: 'rot', seconds: 2.0, minSpan: 8 },
  { action: 'greet', channel: 'y', seconds: 2.5, minSpan: 8 },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const rows = run(c.action, c.seconds);
  const a = analyse(rows, c.channel);
  const okSpan = a.span >= c.minSpan;
  const okStill = a.stillRatio <= 0.75;
  const okJump = a.maxJump <= Math.max(2, a.span * 0.5);
  const bc = checkBlinkContinuity(rows);
  const okBlink = bc.worst <= MAX_BLINK_STEP;
  const ok = okSpan && okStill && okJump && okBlink;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${c.action.padEnd(7)} 行程=${String(a.span).padStart(3)}px` +
    ` 静止帧=${(a.stillRatio * 100).toFixed(0).padStart(3)}% 单帧最大跳变=${a.maxJump}px` +
    ` 眨眼单帧跳变=${bc.worst.toFixed(2)}  (${a.frames} 帧)`);
  if (!okSpan) console.log(`      行程只有 ${a.span}px，低于 ${c.minSpan}px —— 屏幕上看不出这是个动作`);
  if (!okStill) console.log(`      ${(a.stillRatio * 100).toFixed(0)}% 的帧画面完全没变，动作在真实帧率下退化成了闪烁`);
  if (!okJump) console.log(`      单帧跳 ${a.maxJump}px（总行程 ${a.span}px），运动被采样得太稀`);
  if (!okBlink) console.log(`      第 ${bc.at} 帧 blink 突变 ${bc.worst.toFixed(2)}（上限 ${MAX_BLINK_STEP}）——` +
    `眯眼没有合上的过程，上眼皮会凭空出现在眼睛中间`);
  if (TRACE === c.action || TRACE === 'all') console.log('      轨迹 ' + a.vals.join(' '));
}

console.log(`\n${pass} 通过 / ${fail} 失败 / 共 ${CASES.length}`);
process.exit(fail ? 1 : 0);

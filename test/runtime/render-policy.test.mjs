// 渲染节流与量化跳帧策略的边界回归：失败方向必须永远是"多画"。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveFrameMs, poseDrawKey, IDLE_THROTTLE_FPS, IDLE_HOLDOFF_MS, BLINK_PREBOOST_S,
} from '../../src/renderer/pet/render-policy.js';

const FULL = 1000 / 60;
const idleInput = (overrides = {}) => ({
  frameMs: FULL,
  firstFrameAcked: true,
  dragging: false,
  state: 'idle',
  blinkActive: false,
  blinkTimer: 3,
  sinceActivityMs: IDLE_HOLDOFF_MS + 1,
  ...overrides,
});

test('true quiescence throttles to the idle tier', () => {
  assert.equal(effectiveFrameMs(idleInput()), 1000 / IDLE_THROTTLE_FPS);
});

test('every non-quiescent condition individually forces full speed', () => {
  const fullSpeedCases = [
    { firstFrameAcked: false },          // 首帧确认前必须逐帧真实绘制
    { dragging: true },
    { state: 'walk' },
    { state: 'hop' },
    { blinkActive: true },               // 眨眼中
    { blinkTimer: BLINK_PREBOOST_S },    // 眨眼将至：提前升速（含边界值）
    { blinkTimer: 0.1 },
    { sinceActivityMs: IDLE_HOLDOFF_MS - 1 }, // 交互余温
  ];
  for (const overrides of fullSpeedCases) {
    assert.equal(effectiveFrameMs(idleInput(overrides)), FULL, JSON.stringify(overrides));
  }
});

test('undefined or NaN timers fail toward full speed', () => {
  assert.equal(effectiveFrameMs(idleInput({ blinkTimer: undefined })), FULL);
  assert.equal(effectiveFrameMs(idleInput({ blinkTimer: NaN })), FULL);
  assert.equal(effectiveFrameMs(idleInput({ sinceActivityMs: NaN })), FULL);
});

test('throttle never speeds up a slower user setting', () => {
  const slow = 1000 / 12;
  assert.equal(effectiveFrameMs(idleInput({ frameMs: slow })), slow);
});

const baseKeyInput = (overrides = {}) => ({
  charId: 'default',
  canvasWidth: 200,
  canvasHeight: 300,
  drawScale: 1,
  facing: 1,
  pose: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, sway: 0 },
  spriteWidth: 44,
  spriteHeight: 60,
  frameKey: '1.000|1.000',
  ...overrides,
});

function keyWithPose(pose, extra = {}) {
  const input = baseKeyInput(extra);
  return poseDrawKey({ ...input, pose: { ...input.pose, ...pose } });
}

test('sub-device-pixel pose drift quantizes to the same draw key', () => {
  const still = keyWithPose({});
  // 呼吸级别的漂移：60px 精灵上 scaleY 1.008 只有 0.48 设备像素
  assert.equal(keyWithPose({ scaleY: 1.008, scaleX: 0.9952 }), still);
  assert.equal(keyWithPose({ offsetX: 0.4, offsetY: -0.4 }), still);
  assert.equal(keyWithPose({ rotate: 0.005 }), still); // 60px 边缘位移 0.3px
});

test('a visible pose change produces a different draw key', () => {
  const still = keyWithPose({});
  assert.notEqual(keyWithPose({ scaleY: 1.017 }), still);     // 跨过 1 像素
  assert.notEqual(keyWithPose({ offsetX: 0.6 }), still);      // round 到 1
  assert.notEqual(keyWithPose({ rotate: 0.02 }), still);      // 边缘 1.2px
  assert.notEqual(keyWithPose({ sway: 1.4 }), still);
});

test('identity, viewport, facing, and frame changes always redraw', () => {
  const still = keyWithPose({});
  assert.notEqual(keyWithPose({}, { charId: 'other' }), still);
  assert.notEqual(keyWithPose({}, { canvasWidth: 201 }), still);
  assert.notEqual(keyWithPose({}, { drawScale: 2 }), still);
  assert.notEqual(keyWithPose({}, { facing: -1 }), still);
  assert.notEqual(keyWithPose({}, { frameKey: 'f3' }), still);
  assert.notEqual(keyWithPose({}, { frameKey: '0.120|1.000' }), still); // 眨眼中
});

test('larger sprites quantize scale and rotation more finely', () => {
  const big = { spriteWidth: 300, spriteHeight: 400 };
  const still = keyWithPose({}, big);
  // 同样的 0.8% 呼吸在 400px 精灵上是 3.2 像素，必须重画
  assert.notEqual(keyWithPose({ scaleY: 1.008 }, big), still);
  assert.notEqual(keyWithPose({ rotate: 0.005 }, big), still); // 边缘 2px
});

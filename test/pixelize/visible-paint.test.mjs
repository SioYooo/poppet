import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGER_PAINT_UNAVAILABLE,
  recordVisiblePaintTiming,
  waitForVisiblePaint,
} from '../../src/shared/visible-paint.js';

function scheduler() {
  let nextId = 1;
  const frames = new Map();
  const timers = new Map();
  const cancelledFrames = [];
  const clearedTimers = [];
  return {
    frames,
    timers,
    cancelledFrames,
    clearedTimers,
    requestFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    },
    setTimer(callback) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      clearedTimers.push(id);
      timers.delete(id);
    },
  };
}

test('two animation frames produce real paint evidence and clear the deadline', async () => {
  const s = scheduler();
  const pending = waitForVisiblePaint(s);
  assert.equal(s.frames.size, 1);
  const first = [...s.frames.entries()][0];
  s.frames.delete(first[0]);
  first[1]();
  assert.equal(s.frames.size, 1);
  const second = [...s.frames.entries()][0];
  s.frames.delete(second[0]);
  second[1]();

  assert.equal(await pending, true);
  assert.equal(s.timers.size, 0);
  assert.equal(s.clearedTimers.length, 1);
  assert.deepEqual(s.cancelledFrames, []);
});

test('a paint deadline continues business work but cancels dormant frame callbacks', async () => {
  const s = scheduler();
  const pending = waitForVisiblePaint(s);
  const timer = [...s.timers.entries()][0];
  s.timers.delete(timer[0]);
  timer[1]();

  assert.equal(await pending, false);
  assert.equal(s.frames.size, 0);
  assert.equal(s.cancelledFrames.length, 1);
});

test('only real paint may populate a visibility timing marker', async () => {
  const unavailable = { timings: { T1: 12 }, timingIssues: {} };
  let nowCalls = 0;
  const now = async () => { nowCalls++; return 34; };

  assert.equal(await recordVisiblePaintTiming(unavailable, 'T1', false, now), null);
  assert.equal(unavailable.timings.T1, null);
  assert.equal(unavailable.timingIssues.T1, MANAGER_PAINT_UNAVAILABLE);
  assert.equal(nowCalls, 0);

  const visible = { timings: {}, timingIssues: { T1: MANAGER_PAINT_UNAVAILABLE } };
  assert.equal(await recordVisiblePaintTiming(visible, 'T1', true, now), 34);
  assert.equal(visible.timings.T1, 34);
  assert.equal(Object.hasOwn(visible.timingIssues, 'T1'), false);
  assert.equal(nowCalls, 1);
});

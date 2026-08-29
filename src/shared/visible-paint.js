export const MANAGER_PAINT_UNAVAILABLE = 'POPPET_MANAGER_PAINT_UNAVAILABLE';

export function waitForVisiblePaint({
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = frameId => cancelAnimationFrame(frameId),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timerId => clearTimeout(timerId),
  timeoutMs = 250,
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timerId = null;
    let outerFrameId = null;
    let innerFrameId = null;

    const finish = painted => {
      if (settled) return;
      settled = true;
      if (timerId !== null) clearTimer(timerId);
      if (outerFrameId !== null) cancelFrame(outerFrameId);
      if (innerFrameId !== null) cancelFrame(innerFrameId);
      resolve(painted);
    };

    timerId = setTimer(() => finish(false), timeoutMs);
    outerFrameId = requestFrame(() => {
      outerFrameId = null;
      if (settled) return;
      innerFrameId = requestFrame(() => {
        innerFrameId = null;
        finish(true);
      });
    });
  });
}

export async function recordVisiblePaintTiming(target, key, painted, now) {
  target.timings ||= {};
  target.timingIssues ||= {};
  if (!painted) {
    target.timings[key] = null;
    target.timingIssues[key] = MANAGER_PAINT_UNAVAILABLE;
    return null;
  }

  const observed = await now();
  if (!Number.isFinite(observed)) {
    target.timings[key] = null;
    target.timingIssues[key] = MANAGER_PAINT_UNAVAILABLE;
    return null;
  }
  target.timings[key] = observed;
  delete target.timingIssues[key];
  return observed;
}

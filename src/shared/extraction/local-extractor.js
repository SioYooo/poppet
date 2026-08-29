import { colorDistance, NEIGHBORS4 } from '../imageops.js';

const DEFAULTS = {
  alphaThreshold: 160,
  bgTolerance: 42,
};

function processingError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertActive(options, stage) {
  if (typeof options.shouldCancel === 'function' && options.shouldCancel()) {
    throw processingError(`处理已取消（${stage}）`, 'POPPET_PROCESS_CANCELLED');
  }
  if (Number.isFinite(options.deadline) && Date.now() > options.deadline) {
    throw processingError(`图片处理超时（${stage}）`, 'POPPET_PROCESS_TIMEOUT');
  }
}

function alphaMaskOf(image) {
  const mask = new Uint8Array(image.width * image.height);
  for (let p = 0; p < mask.length; p++) mask[p] = image.data[p * 4 + 3] > 0 ? 1 : 0;
  return mask;
}

function result(image, decision, sharedDecision = false) {
  const needsAdvanced = decision.mode === 'none';
  return {
    image,
    mask: alphaMaskOf(image),
    mode: decision.mode,
    status: needsAdvanced ? 'needs-advanced-extraction' : 'ready',
    // Heuristic capability signal, not a calibrated probability.
    confidence: decision.mode === 'alpha' ? 1 : (decision.mode === 'chroma' ? 0.8 : 0),
    decision,
    warnings: needsAdvanced
      ? ['本地提取器无法可靠区分复杂背景；已保留原图，未进行破坏性猜测。']
      : [],
    diagnostics: {
      extractor: 'local-edge-v1',
      removedPixels: decision.removed,
      reason: decision.reason || null,
      sharedDecision,
    },
  };
}

// Built-in deterministic extractor. It intentionally mutates `image`: callers clone source
// frames before entering this boundary. A shared decision keeps animation frames stable.
export function extractLocalSubject(image, options = {}, sharedDecision = null) {
  const opt = { ...DEFAULTS, ...options };
  const { alphaThreshold, bgTolerance } = opt;
  const { width: w, height: h, data } = image;
  const total = w * h;

  if (sharedDecision) return result(image, applyDecision(image, sharedDecision, alphaThreshold, opt), true);

  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < alphaThreshold) transparent++;

  if (transparent > total * 0.02) {
    for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= alphaThreshold ? 255 : 0;
    return result(image, { mode: 'alpha', removed: transparent });
  }

  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });
  const spread = Math.max(...corners.map(c =>
    Math.max(...corners.map(d => colorDistance(c[0], c[1], c[2], d[0], d[1], d[2])))));
  if (spread > bgTolerance) {
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return result(image, {
      mode: 'none', removed: 0, reason: '四角颜色不一致，判定为满幅插画',
    });
  }

  const bg = [0, 1, 2].map(c => Math.round(corners.reduce((sum, corner) => sum + corner[c], 0) / corners.length));
  const edge = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x > 1 && y > 1 && x < w - 2 && y < h - 2) continue;
    const i = (y * w + x) * 4;
    edge.push(colorDistance(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]));
  }
  const mean = edge.reduce((sum, value) => sum + value, 0) / edge.length;
  const sd = Math.sqrt(edge.reduce((sum, value) => sum + (value - mean) ** 2, 0) / edge.length);
  const globalTol = Math.min(bgTolerance, Math.max(6, mean + sd * 3));
  const localTol = Math.max(10, globalTol);

  return result(image, floodFill(image, { mode: 'chroma', removed: 0, bg, globalTol, localTol }, opt));
}

function applyDecision(image, decision, alphaThreshold, options) {
  if (decision.mode === 'alpha') {
    let removed = 0;
    for (let i = 3; i < image.data.length; i += 4) {
      const keep = image.data[i] >= alphaThreshold;
      if (!keep) removed++;
      image.data[i] = keep ? 255 : 0;
    }
    return { ...decision, removed };
  }
  if (decision.mode === 'none') return { ...decision, removed: 0 };
  return floodFill(image, decision, options, '多帧去背扩散');
}

function floodFill(image, decision, options, stage = '去背扩散') {
  const { width: w, height: h, data } = image;
  const total = w * h;
  const { bg, globalTol, localTol } = decision;
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;
  let processed = 0;
  const push = (index) => {
    if (!seen[index]) {
      seen[index] = 1;
      stack[sp++] = index;
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  let removed = 0;
  while (sp > 0) {
    const current = stack[--sp];
    const i = current * 4;
    if (colorDistance(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) > globalTol) continue;
    seen[current] = 2;
    removed++;
    if ((++processed & 0xffff) === 0) assertActive(options, stage);
    const cx = current % w;
    const cy = (current / w) | 0;
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (seen[next]) continue;
      const j = next * 4;
      if (colorDistance(data[j], data[j + 1], data[j + 2], data[i], data[i + 1], data[i + 2]) > localTol) continue;
      push(next);
    }
  }
  for (let p = 0; p < total; p++) data[p * 4 + 3] = seen[p] === 2 ? 0 : 255;
  return { ...decision, removed };
}

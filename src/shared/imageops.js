// 通用图像算子。刻意只依赖 TypedArray，不碰 Canvas 也不碰 Node，
// 这样同一份代码能在 Electron 的 renderer 和命令行工具里跑。
//
// 图像表示统一为 { width, height, data }，data 是 RGBA8 的 Uint8ClampedArray。

export const NEIGHBORS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function createImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function getPixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

// 感知加权的色距。用亮度权重而不是欧氏距离，肉眼判断"像不像"更准。
export function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
}

// ---------- 形态学 ----------

export function dilate(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i]) { out[i] = 1; continue; }
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) { out[i] = 1; break; }
    }
  }
  return out;
}

export function erode(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    let keep = 1;
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // 越界不算缺失，免得整圈被削
      if (!mask[ny * w + nx]) { keep = 0; break; }
    }
    out[i] = keep;
  }
  return out;
}

// 从边框 flood fill 标出"外部"，其余的 0 就是内部空洞；就地补进 mask，返回补的像素数
export function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const cur = stack.pop();
    if (outside[cur] || mask[cur]) continue;
    outside[cur] = 1;
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!outside[ni] && !mask[ni]) stack.push(ni);
    }
  }
  let holes = 0;
  for (let i = 0; i < mask.length; i++) if (!mask[i] && !outside[i]) { mask[i] = 1; holes++; }
  return holes;
}

// ---------- 连通域 ----------

// mask 上的 4 连通团块。cells 是像素下标数组，方便后续做遮罩。
export function labelBlobs(mask, w, h, minSize = 1) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !mask[s]) continue;
    let sp = 0, size = 0, sumX = 0, sumY = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const cells = [];
    stack[sp++] = s; seen[s] = 1;
    while (sp > 0) {
      const cur = stack[--sp];
      const cx = cur % w, cy = (cur / w) | 0;
      size++; sumX += cx; sumY += cy; cells.push(cur);
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !mask[ni]) continue;
        seen[ni] = 1; stack[sp++] = ni;
      }
    }
    if (size < minSize) continue;
    out.push({
      size, cells,
      x0, y0, x1, y1,
      w: x1 - x0 + 1, h: y1 - y0 + 1,
      cx: sumX / size, cy: sumY / size,
    });
  }
  return out.sort((a, b) => b.size - a.size);
}

// 按 alpha 求最大连通域，其余全部抹成透明（清掉去背后残留的碎渣）
export function keepLargestOpaqueComponent(img) {
  const { width: w, height: h, data } = img;
  const total = w * h;
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let components = 0, bestSeed = -1, bestSize = 0;

  // 这里只需要最大团块，不再调用 labelBlobs：后者会把每个团块及其 cells 都保留到
  // 排序结束，碎片输入会制造数百万个 JS 数组/对象。这里逐团块计数后立即丢弃。
  for (let s = 0; s < total; s++) {
    if (seen[s] || data[s * 4 + 3] === 0) continue;
    components++;
    let sp = 0, size = 0;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp > 0) {
      const cur = stack[--sp];
      size++;
      const cx = cur % w, cy = (cur / w) | 0;
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || data[ni * 4 + 3] === 0) continue;
        seen[ni] = 1;
        stack[sp++] = ni;
      }
    }
    if (size > bestSize) { bestSize = size; bestSeed = s; }
  }
  if (components <= 1) return { removed: 0, components, kept: bestSize };

  // 复用 seen 标出最大团块，避免为所有组件保存 cells 或 component label。
  seen.fill(0);
  let sp = 0;
  stack[sp++] = bestSeed;
  seen[bestSeed] = 1;
  while (sp > 0) {
    const cur = stack[--sp];
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (seen[ni] || data[ni * 4 + 3] === 0) continue;
      seen[ni] = 1;
      stack[sp++] = ni;
    }
  }
  let removed = 0;
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] > 0 && !seen[i]) { data[i * 4 + 3] = 0; removed++; }
  }
  return { removed, components, kept: bestSize };
}

// ---------- 区域生长 ----------

// 以"相邻像素色差"为准的 flood fill，而不是"到种子的色差"。
// 像素画里渐变会连成一片，而硬描边天然把不同部件切开——正是我们要的分割。
// globalTolerance 只是个保险，防止沿着长渐变一路漂到完全不同的颜色。
export function growRegions(img, localTolerance = 26, globalTolerance = 115, minSize = 24) {
  const { width: w, height: h, data } = img;
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const regions = [];
  for (let s = 0; s < w * h; s++) {
    if (label[s] !== -1 || data[s * 4 + 3] === 0) continue;
    const id = regions.length;
    const sr = data[s * 4], sg = data[s * 4 + 1], sb = data[s * 4 + 2];
    let sp = 0, size = 0, sumX = 0, sumY = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const cells = [];
    stack[sp++] = s; label[s] = id;
    while (sp > 0) {
      const cur = stack[--sp];
      const cx = cur % w, cy = (cur / w) | 0;
      size++; sumX += cx; sumY += cy; cells.push(cur);
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      const ci = cur * 4;
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (label[ni] !== -1 || data[ni * 4 + 3] === 0) continue;
        const j = ni * 4;
        if (colorDistance(data[j], data[j + 1], data[j + 2], data[ci], data[ci + 1], data[ci + 2]) > localTolerance) continue;
        if (colorDistance(data[j], data[j + 1], data[j + 2], sr, sg, sb) > globalTolerance) continue;
        label[ni] = id; stack[sp++] = ni;
      }
    }
    regions.push({
      id, size, cells, x0, y0, x1, y1,
      w: x1 - x0 + 1, h: y1 - y0 + 1,
      cx: sumX / size, cy: sumY / size,
    });
  }
  return { label, regions: regions.filter(r => r.size >= minSize).sort((a, b) => b.size - a.size) };
}

// 某个区域内部的空洞（被它完全包围的非本区域像素），按连通域返回。
// 五官检测的核心：眼睛和嘴，就是"脸"这个区域上的洞。
export function regionHoles(region, imgW, imgH, pad = 1) {
  const x0 = Math.max(0, region.x0 - pad), y0 = Math.max(0, region.y0 - pad);
  const x1 = Math.min(imgW - 1, region.x1 + pad), y1 = Math.min(imgH - 1, region.y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const mask = new Uint8Array(w * h);
  for (const c of region.cells) {
    const gx = c % imgW, gy = (c / imgW) | 0;
    mask[(gy - y0) * w + (gx - x0)] = 1;
  }
  const filled = new Uint8Array(mask);
  fillHoles(filled, w, h);
  const holeMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) holeMask[i] = filled[i] && !mask[i] ? 1 : 0;
  // 洞的坐标是在局部窗口里算的，换算回整图坐标系再返回
  return labelBlobs(holeMask, w, h).map(b => ({
    ...b,
    x0: b.x0 + x0, x1: b.x1 + x0, y0: b.y0 + y0, y1: b.y1 + y0,
    cx: b.cx + x0, cy: b.cy + y0,
    cells: b.cells.map(c => ((c / w | 0) + y0) * imgW + (c % w) + x0),
  }));
}

// ---------- 缩放 ----------

// box filter 下采样。alpha 按覆盖面积算，超过一半就判为不透明——
// 像素画要的是硬边轮廓，半透明毛边在透明窗口上会显出一圈脏边。
export function downsampleTo(img, targetW, targetH) {
  const out = createImage(targetW, targetH);
  for (let ty = 0; ty < targetH; ty++) {
    const sy0 = (ty * img.height) / targetH, sy1 = ((ty + 1) * img.height) / targetH;
    for (let tx = 0; tx < targetW; tx++) {
      const sx0 = (tx * img.width) / targetW, sx1 = ((tx + 1) * img.width) / targetW;
      let r = 0, g = 0, b = 0, aSum = 0, wSum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const i = (sy * img.width + sx) * 4;
          const a = img.data[i + 3];
          aSum += a * weight; wSum += weight;
          if (a > 0) { r += img.data[i] * weight; g += img.data[i + 1] * weight; b += img.data[i + 2] * weight; }
        }
      }
      const covered = wSum > 0 ? aSum / (wSum * 255) : 0;
      const o = (ty * targetW + tx) * 4;
      if (covered <= 0.5) { out.data[o + 3] = 0; continue; }
      const cw = wSum * covered;
      out.data[o] = Math.round(r / cw);
      out.data[o + 1] = Math.round(g / cw);
      out.data[o + 2] = Math.round(b / cw);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

// ---------- 调色板 ----------

// 中位切分量化。AI 生成的"伪像素画"常有几万种噪声色，收敛到几十色才像素画。
export function quantize(img, n) {
  const pixels = [];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    pixels.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  if (!pixels.length) return [];
  let boxes = [pixels];
  while (boxes.length < n) {
    let bi = -1, bScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const score = Math.max(...channelRanges(boxes[i])) * Math.log2(boxes[i].length + 1);
      if (score > bScore) { bScore = score; bi = i; }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const ranges = channelRanges(box);
    const ch = ranges.indexOf(Math.max(...ranges));
    box.sort((p, q) => p[ch] - q[ch]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  const palette = boxes.filter(b => b.length).map(b => {
    let r = 0, g = 0, bl = 0;
    for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
    return [Math.round(r / b.length), Math.round(g / b.length), Math.round(bl / b.length)];
  });
  const cache = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
    let c = cache.get(key);
    if (c === undefined) {
      c = nearestPaletteIndex([img.data[i], img.data[i + 1], img.data[i + 2]], palette);
      cache.set(key, c);
    }
    img.data[i] = palette[c][0]; img.data[i + 1] = palette[c][1]; img.data[i + 2] = palette[c][2];
  }
  return palette;
}

function channelRanges(pixels) {
  const min = [255, 255, 255], max = [0, 0, 0];
  for (const p of pixels) for (let c = 0; c < 3; c++) {
    if (p[c] < min[c]) min[c] = p[c];
    if (p[c] > max[c]) max[c] = p[c];
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

export function nearestPaletteIndex(rgb, palette) {
  let best = 0, bd = Infinity;
  for (let k = 0; k < palette.length; k++) {
    const d = colorDistance(palette[k][0], palette[k][1], palette[k][2], rgb[0], rgb[1], rgb[2]);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

export function nearestPaletteColor(rgb, palette) {
  return palette.length ? palette[nearestPaletteIndex(rgb, palette)] : [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
}

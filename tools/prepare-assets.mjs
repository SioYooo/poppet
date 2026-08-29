// ⚠ DEPRECATED —— 已被 src/shared/pipeline.js 取代，请勿再改这里。
// 当初这份脚本里的判据是针对某一张图硬编码的（特定的黑色阈值、红色阈值）；
// 通用版本改用与色相无关的区域分割，并且被 renderer 和命令行共用。
// 生成内置角色请用: node tools/build-default-character.mjs
// 保留此文件仅作对照，可以安全删除。

// 素材管线：原图 -> 干净的桌宠精灵 + 眼/嘴部件图集 + 特征标注。
//
//   1. alpha 硬二值化（消掉外发光的半透明残留）
//   2. 连通域筛选，只保留角色主体
//   3. 裁剪到包围盒
//   4. box filter 下采样到运行时尺寸（原图无真实像素网格，见 detect-grid.mjs）
//   5. 中位切分调色板量化（把 5 万多种噪声色收敛成干净的像素画色板）
//   6. 定位双眼与嘴，抠出部件贴片，并对原位做 inpaint 得到"无眼无嘴"的背景板
//
// 运行时靠这套素材做眨眼/嘴型：先画背景板擦掉五官，再按开合度裁切贴片重画。
// 这是加法式合成，不需要生成新像素，因此没有任何接缝或空洞风险。
//
// 用法: node tools/prepare-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG, createImage } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets/source/original.png');

const ALPHA_TH = 160;      // 低于此值视为背景
const MARGIN = 4;          // 裁剪留边
const TARGET_HEIGHT = 400; // 运行时精灵高度（px，约合 200pt @2x）
const PALETTE_SIZE = 48;
const ICON_SIZE = 44;      // 托盘图标 22pt @2x

// ============ 1) alpha 二值化 ============
function binarizeAlpha(img) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = out.data[i] >= ALPHA_TH ? 255 : 0;
  return out;
}

// ============ 2) 保留最大连通域 ============
function keepLargestComponent(img) {
  const { width: W, height: H, data } = img;
  const label = new Int32Array(W * H).fill(-1);
  const sizes = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (data[start * 4 + 3] === 0 || label[start] !== -1) continue;
    const id = sizes.length;
    let size = 0, sp = 0;
    stack[sp++] = start; label[start] = id;
    while (sp > 0) {
      const cur = stack[--sp];
      size++;
      const cx = cur % W, cy = (cur / W) | 0;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (label[ni] !== -1 || data[ni * 4 + 3] === 0) continue;
        label[ni] = id; stack[sp++] = ni;
      }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  let removed = 0;
  for (let i = 0; i < W * H; i++) {
    if (label[i] !== -1 && label[i] !== main) { data[i * 4 + 3] = 0; removed++; }
  }
  return { removedPixels: removed, components: sizes.length, mainSize: sizes[main] };
}
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ============ 3) 裁剪 ============
function cropToContent(img, margin) {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin);
  x1 = Math.min(W - 1, x1 + margin); y1 = Math.min(H - 1, y1 + margin);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = createImage(cw, ch);
  for (let y = 0; y < ch; y++) {
    img.data.copy(out.data, y * cw * 4, ((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + cw) * 4);
  }
  return { img: out, bbox: [x0, y0, x1, y1] };
}

// ============ 4) box filter 下采样 ============
function downsample(img, targetH) {
  const TW = Math.max(1, Math.round(img.width * (targetH / img.height)));
  const TH = targetH;
  const out = createImage(TW, TH);
  for (let ty = 0; ty < TH; ty++) {
    const sy0 = (ty * img.height) / TH, sy1 = ((ty + 1) * img.height) / TH;
    for (let tx = 0; tx < TW; tx++) {
      const sx0 = (tx * img.width) / TW, sx1 = ((tx + 1) * img.width) / TW;
      let r = 0, g = 0, b = 0, aSum = 0, wSum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * img.width + sx) * 4;
          const a = img.data[i + 3];
          aSum += a * w; wSum += w;
          if (a > 0) { r += img.data[i] * w; g += img.data[i + 1] * w; b += img.data[i + 2] * w; }
        }
      }
      const covered = wSum > 0 ? aSum / (wSum * 255) : 0;
      const o = (ty * TW + tx) * 4;
      if (covered <= 0.5) { out.data[o + 3] = 0; continue; } // alpha 保持硬边
      const cw = wSum * covered;
      out.data[o] = Math.round(r / cw);
      out.data[o + 1] = Math.round(g / cw);
      out.data[o + 2] = Math.round(b / cw);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

// ============ 5) 中位切分量化 ============
function quantize(img, n) {
  const pixels = [];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    pixels.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  let boxes = [pixels];
  while (boxes.length < n) {
    let bi = -1, bScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const score = Math.max(...extents(boxes[i])) * Math.log2(boxes[i].length + 1);
      if (score > bScore) { bScore = score; bi = i; }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const ch = extents(box).indexOf(Math.max(...extents(box)));
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
      let best = 0, bd = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const dr = palette[k][0] - img.data[i], dg = palette[k][1] - img.data[i + 1], db = palette[k][2] - img.data[i + 2];
        const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (d < bd) { bd = d; best = k; }
      }
      cache.set(key, c = best);
    }
    img.data[i] = palette[c][0]; img.data[i + 1] = palette[c][1]; img.data[i + 2] = palette[c][2];
  }
  return palette;
}
function extents(pixels) {
  const min = [255, 255, 255], max = [0, 0, 0];
  for (const p of pixels) for (let c = 0; c < 3; c++) {
    if (p[c] < min[c]) min[c] = p[c];
    if (p[c] > max[c]) max[c] = p[c];
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

// ============ 通用连通域 ============
function findBlobs(img, pred) {
  const { width: W, height: H, data } = img;
  const at = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  const seen = new Uint8Array(W * H), stack = new Int32Array(W * H), res = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !pred(...at(s % W, (s / W) | 0))) continue;
    let sp = 0, size = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    const cells = [];
    stack[sp++] = s; seen[s] = 1;
    while (sp > 0) {
      const cur = stack[--sp];
      const cx = cur % W, cy = (cur / W) | 0;
      size++; cells.push(cur);
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (seen[ni] || !pred(...at(nx, ny))) continue;
        seen[ni] = 1; stack[sp++] = ni;
      }
    }
    res.push({ size, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cells });
  }
  return res.sort((a, b) => b.size - a.size);
}

// ============ 6) 五官定位 ============
// 眼睛 = 眼眶暗色 + 虹膜棕（max<150 且不偏蓝，以排除深蓝夹克）连成的近方形团块。
// 眼白量化后与肤色同色，无法用颜色区分，所以靠"被眼眶包围的空洞"补进遮罩。
// b-r<35 用来排除深蓝夹克（b 远大于 r），但保留眼影里偏冷的暗色（如 rgb(86,82,92)）
const isEyeInk = (r, g, b, a) => a > 0 && Math.max(r, g, b) < 150 && b - r < 35;
const isLipRed = (r, g, b, a) => a > 0 && r > 200 && g < 170 && b < 170 && r - g > 90;

function locateFeatures(img) {
  const { width: W, height: H } = img;
  const headZone = H * 0.4;

  const eyeCandidates = findBlobs(img, isEyeInk).filter(b =>
    b.y1 < headZone &&                    // 只在头部
    b.size > W * H * 0.005 &&             // 足够大
    b.w < W * 0.35 && b.h < H * 0.15 &&   // 不是长条的头发描边
    b.w / b.h > 0.55 && b.w / b.h < 2.2   // 近方形
  );
  if (eyeCandidates.length < 2) {
    throw new Error(`双眼定位失败：仅找到 ${eyeCandidates.length} 个候选团块`);
  }
  const eyes = eyeCandidates.slice(0, 2).sort((a, b) => a.x0 - b.x0);
  // 两眼应大致等高：中心 y 差不超过眼高
  const dyCenters = Math.abs((eyes[0].y0 + eyes[0].y1) - (eyes[1].y0 + eyes[1].y1)) / 2;
  if (dyCenters > Math.max(eyes[0].h, eyes[1].h)) {
    throw new Error(`双眼定位可疑：中心 y 相差 ${dyCenters.toFixed(1)}px`);
  }

  const lips = findBlobs(img, isLipRed).filter(b => b.y1 < headZone && b.size > 30);
  if (!lips.length) throw new Error('嘴部定位失败：未找到红色团块');
  const mouth = lips[0];

  return { eyeL: eyes[0], eyeR: eyes[1], mouth };
}

// 把团块扩成实心遮罩：先闭运算（膨胀→填洞→腐蚀）把眼眶的细缝封上，
// 这样眼白这类"开口朝外的空腔"也能被判成内部并纳入遮罩。
function solidMask(img, blob, pad, closeRadius = 2) {
  const { width: W } = img;
  const x0 = blob.x0 - pad, y0 = blob.y0 - pad;
  const mw = blob.w + pad * 2, mh = blob.h + pad * 2;
  let mask = new Uint8Array(mw * mh);
  for (const c of blob.cells) {
    const mx = (c % W) - x0, my = ((c / W) | 0) - y0;
    if (mx >= 0 && my >= 0 && mx < mw && my < mh) mask[my * mw + mx] = 1;
  }
  const raw = mask.slice();
  for (let i = 0; i < closeRadius; i++) mask = dilate(mask, mw, mh);
  const holes = fillHoles(mask, mw, mh);
  for (let i = 0; i < closeRadius; i++) mask = erode(mask, mw, mh);
  // 腐蚀可能削掉原始团块的细枝，补回来，保证眼眶像素一个不漏
  for (let i = 0; i < mask.length; i++) if (raw[i]) mask[i] = 1;
  fillHoles(mask, mw, mh);
  return { mask, x: x0, y: y0, w: mw, h: mh, holes };
}

function dilate(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i]) { out[i] = 1; continue; }
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) { out[i] = 1; break; }
    }
  }
  return out;
}

function erode(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    let keep = 1;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // 越界不算缺失，避免削边
      if (!mask[ny * w + nx]) { keep = 0; break; }
    }
    out[i] = keep;
  }
  return out;
}

// 从边框 flood fill 标记"外部"，其余的 0 即内部空洞，就地补进遮罩，返回补的数量
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const cur = stack.pop();
    if (outside[cur] || mask[cur]) continue;
    outside[cur] = 1;
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of NEIGHBORS) {
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

// 抠出部件贴片（遮罩内原样，遮罩外透明）
function extractPart(img, m) {
  const out = createImage(m.w, m.h);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (!m.mask[y * m.w + x]) continue;
    const si = ((y + m.y) * img.width + (x + m.x)) * 4;
    const di = (y * m.w + x) * 4;
    out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1];
    out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
  }
  return out;
}

// inpaint：Laplacian 调和插值填补遮罩区域。
// 最近邻 BFS 传播会留下明显的放射状条纹，肉眼可见；调和插值（迭代取四邻均值直到收敛）
// 得到的是平滑渐变，正好贴合脸颊肤色 + 腮红这种缓变区域。填完再吸附回调色板保持像素画风格。
function inpaintPatch(img, m, palette) {
  // 遮罩紧贴的一圈里眼眶黑与头发都在，全拿来当填充源会插出灰斑。
  // 通用做法：先取紧邻环带的颜色众数——那就是"被五官盖住的地方本来是什么底色"（对脸即肤色），
  // 只有与它足够接近的像素才算合格源。不依赖任何具体色相，换张图照样成立。
  const skin = dominantRingColor(img, m);
  const ok = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= img.width || gy >= img.height) return null;
    const lx = gx - m.x, ly = gy - m.y;
    if (lx >= 0 && ly >= 0 && lx < m.w && ly < m.h && m.mask[ly * m.w + lx]) return null;
    const gi = (gy * img.width + gx) * 4;
    if (img.data[gi + 3] === 0) return null;
    const c = [img.data[gi], img.data[gi + 1], img.data[gi + 2]];
    return colorDist(c[0], c[1], c[2], skin) <= SKIN_TOL ? c : null;
  };
  // 填充策略：整块平涂环带主导色，只在紧贴遮罩边缘的一圈跟随外侧邻居取色。
  //
  // 试过调和插值和多方向扫描线插值，两者都不行——前者远离边界处褪成灰白，
  // 后者留下十字网格纹。根因是脸颊本就近乎单色，插值出的零点几度差异被调色板
  // 量化放大成了可见色块。像素画是平涂的，平涂才是对的答案。
  const base = nearestPaletteColor(skin, palette);
  const out = createImage(m.w, m.h);
  let filled = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const di = (y * m.w + x) * 4;
    const gx = m.x + x, gy = m.y + y;
    const gi = (gy * img.width + gx) * 4;
    if (!m.mask[y * m.w + x]) {
      out.data[di] = img.data[gi]; out.data[di + 1] = img.data[gi + 1];
      out.data[di + 2] = img.data[gi + 2]; out.data[di + 3] = img.data[gi + 3];
      continue;
    }
    out.data[di] = base[0]; out.data[di + 1] = base[1]; out.data[di + 2] = base[2]; out.data[di + 3] = 255;
    filled++;
  }
  return { img: out, filled };
}

const SKIN_TOL = 78; // 感知色距阈值，够宽以容纳腮红/阴影，够窄以排除头发与描边

function colorDist(r, g, b, c) {
  const dr = r - c[0], dg = g - c[1], db = b - c[2];
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
}

// 遮罩外 1~RING 圈环带里出现最多的颜色。用它代表"这块被遮住的区域本该是什么底色"。
// 环带大多落在 patch 之外，所以要在放大的坐标系里做膨胀，否则会被 patch 边界截断。
function dominantRingColor(img, m, ring = 3) {
  const pad = ring + 1;
  const sw = m.w + pad * 2, sh = m.h + pad * 2;
  let cur = new Uint8Array(sw * sh);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (m.mask[y * m.w + x]) cur[(y + pad) * sw + (x + pad)] = 1;
  }
  const counts = new Map();
  for (let r = 0; r < ring; r++) {
    const next = dilate(cur, sw, sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      if (!next[i] || cur[i]) continue;
      const gx = m.x - pad + x, gy = m.y - pad + y;
      if (gx < 0 || gy < 0 || gx >= img.width || gy >= img.height) continue;
      const gi = (gy * img.width + gx) * 4;
      if (img.data[gi + 3] === 0) continue;
      const key = (img.data[gi] << 16) | (img.data[gi + 1] << 8) | img.data[gi + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    cur = next;
  }
  if (!counts.size) throw new Error('遮罩环带为空，无法推断底色');
  let bestKey = 0, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k; }
  return [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255];
}

function nearestPaletteColor(rgb, palette) {
  let best = palette[0], bd = Infinity;
  for (const p of palette) {
    const dr = p[0] - rgb[0], dg = p[1] - rgb[1], db = p[2] - rgb[2];
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ============ 图集打包 ============
function packAtlas(entries) {
  const GAP = 2;
  const totalW = entries.reduce((s, e) => s + e.img.width + GAP, GAP);
  const maxH = Math.max(...entries.map(e => e.img.height)) + GAP * 2;
  const atlas = createImage(totalW, maxH);
  let cx = GAP;
  const frames = {};
  for (const e of entries) {
    for (let y = 0; y < e.img.height; y++) {
      const si = y * e.img.width * 4;
      e.img.data.copy(atlas.data, ((y + GAP) * totalW + cx) * 4, si, si + e.img.width * 4);
    }
    frames[e.name] = { sx: cx, sy: GAP, sw: e.img.width, sh: e.img.height };
    cx += e.img.width + GAP;
  }
  return { atlas, frames };
}

// ============ 托盘图标 ============
function makeIcon(img, feat, size) {
  // 以脸为中心取正方形，缩到 size
  const cx = (feat.eyeL.x0 + feat.eyeR.x1) / 2;
  const cy = (feat.eyeL.y0 + feat.mouth.y1) / 2;
  const side = Math.round((feat.eyeR.x1 - feat.eyeL.x0) * 1.9);
  const x0 = Math.round(cx - side / 2), y0 = Math.round(cy - side / 2);
  const crop = createImage(side, side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const gx = x0 + x, gy = y0 + y;
    if (gx < 0 || gy < 0 || gx >= img.width || gy >= img.height) continue;
    const si = (gy * img.width + gx) * 4, di = (y * side + x) * 4;
    crop.data[di] = img.data[si]; crop.data[di + 1] = img.data[si + 1];
    crop.data[di + 2] = img.data[si + 2]; crop.data[di + 3] = img.data[si + 3];
  }
  return downsample(crop, size);
}

// ============ 主流程 ============
const src = decodePNG(SRC);
console.log(`源图 ${src.width}x${src.height}`);

const bin = binarizeAlpha(src);
const comp = keepLargestComponent(bin);
console.log(`连通域 ${comp.components} 个，保留主体 ${comp.mainSize}px，清除杂散 ${comp.removedPixels}px`);

const { img: cropped, bbox } = cropToContent(bin, MARGIN);
console.log(`裁剪包围盒 [${bbox}] -> ${cropped.width}x${cropped.height}`);

const sprite = downsample(cropped, TARGET_HEIGHT);
console.log(`下采样 -> ${sprite.width}x${sprite.height}`);

const palette = quantize(sprite, PALETTE_SIZE);
console.log(`调色板量化 -> ${palette.length} 色`);

const feat = locateFeatures(sprite);
console.log(`定位 左眼[${feat.eyeL.x0},${feat.eyeL.y0}]-${feat.eyeL.w}x${feat.eyeL.h}` +
            ` 右眼[${feat.eyeR.x0},${feat.eyeR.y0}]-${feat.eyeR.w}x${feat.eyeR.h}` +
            ` 嘴[${feat.mouth.x0},${feat.mouth.y0}]-${feat.mouth.w}x${feat.mouth.h}`);

const parts = {};
const atlasEntries = [];
for (const [name, blob] of Object.entries(feat)) {
  const m = solidMask(sprite, blob, 2);
  const partImg = extractPart(sprite, m);
  const { img: cleanImg, filled } = inpaintPatch(sprite, m, palette);
  atlasEntries.push({ name, img: partImg });
  atlasEntries.push({ name: name + 'Clean', img: cleanImg });
  parts[name] = { x: m.x, y: m.y, w: m.w, h: m.h };
  console.log(`  ${name}: 遮罩 ${m.w}x${m.h}，补内部空洞 ${m.holes}px，inpaint ${filled}px`);
}

const { atlas, frames } = packAtlas(atlasEntries);
for (const name of Object.keys(parts)) {
  parts[name].frame = frames[name];
  parts[name].cleanFrame = frames[name + 'Clean'];
}

// 脚底行
let footY = 0;
for (let y = sprite.height - 1; y >= 0; y--) {
  let any = false;
  for (let x = 0; x < sprite.width; x++) if (sprite.data[(y * sprite.width + x) * 4 + 3] > 0) { any = true; break; }
  if (any) { footY = y; break; }
}
// 描边色（最深且最多的颜色）
const darkCount = new Map();
for (let i = 0; i < sprite.data.length; i += 4) {
  if (sprite.data[i + 3] === 0) continue;
  const r = sprite.data[i], g = sprite.data[i + 1], b = sprite.data[i + 2];
  if (Math.max(r, g, b) < 40) {
    const k = `${r},${g},${b}`;
    darkCount.set(k, (darkCount.get(k) || 0) + 1);
  }
}
const outline = [...darkCount.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);

const icon = makeIcon(sprite, feat, ICON_SIZE);

const features = {
  sprite: { width: sprite.width, height: sprite.height, file: 'pet.png' },
  atlas: { file: 'parts.png', width: atlas.width, height: atlas.height },
  parts,
  footY,
  outline,
  palette,
  source: { file: 'assets/source/original.png', cropBBox: bbox, alphaThreshold: ALPHA_TH, targetHeight: TARGET_HEIGHT },
};

const outDir = path.join(ROOT, 'assets');
const b1 = encodePNG(path.join(outDir, 'pet.png'), sprite);
const b2 = encodePNG(path.join(outDir, 'parts.png'), atlas);
const b3 = encodePNG(path.join(outDir, 'icon.png'), icon);
fs.writeFileSync(path.join(outDir, 'features.json'), JSON.stringify(features, null, 2));
console.log(`\n写出 pet.png ${(b1 / 1024).toFixed(1)}KB · parts.png ${atlas.width}x${atlas.height} ${(b2 / 1024).toFixed(1)}KB · icon.png ${(b3 / 1024).toFixed(1)}KB · features.json`);
console.log(`描边色 rgb(${outline})  脚底 y=${footY}`);

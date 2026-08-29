// 离线复刻运行时的五官合成逻辑，把多个眨眼/嘴型帧渲染成一张对比图，供肉眼验收。
// 运行时（renderer/sprite.js）必须与这里的算法保持一致。
// 用法: node tools/verify-face.mjs [scale]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG, createImage, setPixel } from './png.mjs';
import { normalizeParts } from '../src/shared/parts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = Number(process.argv[2]) || 5;
const CHAR = process.argv[3] || 'default';
const OUT = process.env.POPPET_OUT || path.join(ROOT, '.artifacts', 'verify-face.png');

const DIR = path.join(ROOT, 'assets/characters', CHAR);
if (!fs.existsSync(DIR)) {
  console.error(`找不到角色 ${CHAR}（在 assets/characters/ 下）`);
  process.exit(1);
}
// 多帧素材不做五官合成，压根不会产出 parts.png——这里没什么可验的
const atlasPath = path.join(DIR, 'parts.png');
if (!fs.existsSync(atlasPath)) {
  console.error(`角色 ${CHAR} 没有 parts.png：多帧素材不叠加眨眼与嘴型，没有可验的合成帧。`);
  process.exit(1);
}
const sprite = decodePNG(path.join(DIR, 'pet.png'));
const atlas = decodePNG(atlasPath);
const F = JSON.parse(fs.readFileSync(path.join(DIR, 'character.json'), 'utf8'));

// 只看脸：取双眼与嘴的联合区域再放宽
const ALL = normalizeParts(F.parts);
const EYES = ALL.filter(p => p.role === 'eye');
if (!ALL.length) {
  console.error(`角色 ${CHAR} 没有任何五官部件（多帧素材本来就不做五官合成），没什么可验的。`);
  process.exit(1);
}
const faceX0 = Math.min(...ALL.map(p => p.x)) - 6;
const faceY0 = Math.min(...ALL.map(p => p.y)) - 6;
const faceX1 = Math.max(...ALL.map(p => p.x + p.w)) + 6;
const faceY1 = Math.max(...ALL.map(p => p.y + p.h)) + 6;
const FW = faceX1 - faceX0, FH = faceY1 - faceY0;

function blitFrom(img, dst, sx, sy, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const si = ((sy + y) * img.width + sx + x) * 4;
    if (img.data[si + 3] === 0) continue;
    setPixel(dst, dx + x, dy + y, img.data[si], img.data[si + 1], img.data[si + 2], 255);
  }
}

// 贴片第 row 行的不透明列区间；该行为空则向下找最近的非空行（眼皮压到底时用下眼线的宽度）
function rowSpanAtOrBelow(frame, w, h, row) {
  for (let y = Math.max(0, Math.min(row, h - 1)); y < h; y++) {
    let min = -1, max = -1;
    for (let x = 0; x < w; x++) {
      if (atlas.data[((frame.sy + y) * atlas.width + frame.sx + x) * 4 + 3] > 0) { if (min < 0) min = x; max = x; }
    }
    if (min >= 0) return [min, max];
  }
  return null;
}

// —— 与运行时一致的合成算法 ——
// blink: 1=完全睁开, 0=完全闭合。上眼皮下压式裁切（源与目标 1:1，无缩放）。
// mouthOpen: 1=原样, <1 收拢, >1 张大（纵向缩放，锚在嘴上沿）
function renderFace(blink, mouthOpen) {
  const canvas = createImage(FW, FH);
  blitFrom(sprite, canvas, faceX0, faceY0, FW, FH, 0, 0);

  for (const p of EYES) {
    const key = p.id;
    const dx = p.x - faceX0, dy = p.y - faceY0;
    if (blink >= 0.999) continue;
    // 1) 背景板擦掉整只眼
    blitFrom(atlas, canvas, p.cleanFrame.sx, p.cleanFrame.sy, p.w, p.h, dx, dy);
    // 2) 眼睛贴片只保留下部 blink 比例（源与目标 1:1 裁切，不缩放）。
    //    blink 不取到 0：留几像素正好露出原图的下眼线，闭眼才有"眼睑合拢"而非"眼睛消失"的观感。
    const keep = Math.max(0, Math.round(p.h * blink));
    if (keep > 0) {
      blitFrom(atlas, canvas, p.frame.sx, p.frame.sy + (p.h - keep), p.w, keep, dx, dy + (p.h - keep));
    }
    // 3) 眼睑线：只画在眼皮所在那一行原本有眼睛像素的水平区间内，避免横线甩到脸颊上
    // 只要眼睛有一点闭合就补这条眼睑线。
    // 眼睛顶部原本就有一条睫毛线，按 blink 裁掉上部时它一起被裁走了，
    // 这条线正是把它补回来。
    if (blink < 0.95) {
      const lidRow = p.h - keep;
      const span = rowSpanAtOrBelow(p.frame, p.w, p.h, lidRow);
      if (span) {
        for (let x = span[0]; x <= span[1]; x++) {
          setPixel(canvas, dx + x, dy + lidRow, ...F.outline, 255);
          if (blink < 0.3) setPixel(canvas, dx + x, dy + lidRow - 1, ...F.outline, 255);
        }
      }
    }
  }

  // 有眼无嘴是管线的正常产物（侧面像、机器人都是），守卫要和运行时一致
  const m = ALL.find(p => p.role === 'mouth') || null;
  if (m && Math.abs(mouthOpen - 1) > 0.001) {
    const mdx = m.x - faceX0, mdy = m.y - faceY0;
    blitFrom(atlas, canvas, m.cleanFrame.sx, m.cleanFrame.sy, m.w, m.h, mdx, mdy);
    const nh = Math.max(1, Math.round(m.h * mouthOpen));
    for (let y = 0; y < nh; y++) {
      const sy = m.frame.sy + Math.min(m.h - 1, Math.floor((y / nh) * m.h));
      for (let x = 0; x < m.w; x++) {
        const si = (sy * atlas.width + m.frame.sx + x) * 4;
        if (atlas.data[si + 3] === 0) continue;
        setPixel(canvas, mdx + x, mdy + y, atlas.data[si], atlas.data[si + 1], atlas.data[si + 2], 255);
      }
    }
  }
  return canvas;
}

// POPPET_BLINKS=1,0.85,0.64,0.49,0.42 可换成任意一串眨眼值——
// 验收"眯眼过程"这类连续变化时，固定的几档看不出中间发生了什么
const CUSTOM = process.env.POPPET_BLINKS
  ? process.env.POPPET_BLINKS.split(',').map(v => [`blink ${Number(v).toFixed(2)}`, Number(v), 1])
  : null;

const FRAMES = CUSTOM || [
  ['原图', null, null],
  ['擦除五官', 'erase', null],
  ['睁眼 1.0', 1, 1],
  ['眨 0.7', 0.7, 1],
  ['眨 0.4', 0.4, 1],
  ['眨 0.25', 0.25, 1],
  ['闭眼 0.15', 0.15, 1],
  ['闭眼+闭嘴', 0.15, 0.3],
  ['张嘴 1.8', 1, 1.8],
];

const COLS = 3;
const ROWS = Math.ceil(FRAMES.length / COLS);
const GAP = 8;
const CELL_W = FW * SCALE + GAP, CELL_H = FH * SCALE + GAP + 10;
const W = COLS * CELL_W + GAP;
const H = ROWS * CELL_H + GAP;
const out = createImage(W, H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const c = ((x >> 3) + (y >> 3)) % 2 ? 60 : 85;
  setPixel(out, x, y, c, c, c, 255);
}

FRAMES.forEach(([label, blink, mo], i) => {
  let canvas;
  if (blink === null) {
    canvas = createImage(FW, FH);
    blitFrom(sprite, canvas, faceX0, faceY0, FW, FH, 0, 0);
  } else if (blink === 'erase') {
    canvas = createImage(FW, FH);
    blitFrom(sprite, canvas, faceX0, faceY0, FW, FH, 0, 0);
    for (const p of ALL) {
      blitFrom(atlas, canvas, p.cleanFrame.sx, p.cleanFrame.sy, p.w, p.h, p.x - faceX0, p.y - faceY0);
    }
  } else {
    canvas = renderFace(blink, mo);
  }
  const ox = GAP + (i % COLS) * CELL_W;
  const oy = GAP + Math.floor(i / COLS) * CELL_H;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const si = (y * FW + x) * 4;
    if (canvas.data[si + 3] === 0) continue;
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
      setPixel(out, ox + x * SCALE + dx, oy + y * SCALE + dy, canvas.data[si], canvas.data[si + 1], canvas.data[si + 2], 255);
    }
  }
  // 底部序号条：i+1 段亮块，用来对上下面打印的帧顺序
  const barY = oy + FH * SCALE + 2;
  for (let k = 0; k <= i; k++) {
    for (let x = 0; x < 10; x++) for (let t = 0; t < 5; t++) {
      setPixel(out, ox + k * 13 + x, barY + t, 255, 220, 40, 255);
    }
  }
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
encodePNG(OUT, out);
console.log(`写出 ${OUT}  ${W}x${H}`);
console.log('帧顺序: ' + FRAMES.map(([l], i) => `${i}=${l}`).join('  '));

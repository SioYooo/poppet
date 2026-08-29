// 调试可视化：把精灵放大 + 叠坐标网格 + 画出检测到的部件框，写成 PNG 供肉眼核对坐标。
// 用法: node tools/debug-view.mjs [scale] [角色id] [--nogrid] [--out 文件]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG, createImage, setPixel } from './png.mjs';
import { normalizeParts } from '../src/shared/parts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = Number(process.argv[2]) || 4;
const NOGRID = process.argv.includes('--nogrid');
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : (process.env.POPPET_OUT || path.join(ROOT, '.artifacts', 'debug-view.png'));

const CHAR = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'default';
const DIR = path.join(ROOT, 'assets/characters', CHAR);
const sprite = decodePNG(path.join(DIR, 'pet.png'));
const feat = JSON.parse(fs.readFileSync(path.join(DIR, 'character.json'), 'utf8'));

const PAD = 40; // 左/上留白放坐标数字
const W = sprite.width * SCALE + PAD;
const H = sprite.height * SCALE + PAD;
const out = createImage(W, H);

// 棋盘底（能同时看出透明区域和浅色像素）
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const c = ((x >> 3) + (y >> 3)) % 2 ? 70 : 95;
    setPixel(out, x, y, c, c, c, 255);
  }
}

// 放大精灵（nearest）
for (let y = 0; y < sprite.height; y++) {
  for (let x = 0; x < sprite.width; x++) {
    const i = (y * sprite.width + x) * 4;
    const a = sprite.data[i + 3];
    if (a === 0) continue;
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        setPixel(out, PAD + x * SCALE + dx, PAD + y * SCALE + dy, sprite.data[i], sprite.data[i + 1], sprite.data[i + 2], 255);
      }
    }
  }
}

// 5x7 点阵数字，用于在网格线旁标坐标
const FONT = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
};
function drawNum(n, px, py, col) {
  const s = String(n);
  for (let ci = 0; ci < s.length; ci++) {
    const glyph = FONT[s[ci]];
    if (!glyph) continue;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (glyph[r][c] === '1') {
          setPixel(out, px + ci * 4 + c, py + r, col[0], col[1], col[2], 255);
          setPixel(out, px + ci * 4 + c, py + r + 1, col[0], col[1], col[2], 255);
        }
      }
    }
  }
}

if (!NOGRID) {
  const STEP = 10; // 精灵坐标每 10px 一条线
  for (let x = 0; x <= sprite.width; x += STEP) {
    const px = PAD + x * SCALE;
    const major = x % 50 === 0;
    for (let y = 0; y < H; y++) {
      if (!major && y % 3) continue;
      setPixel(out, px, y, major ? 255 : 0, major ? 40 : 200, major ? 40 : 255, 255);
    }
    drawNum(x, px + 2, 6, [255, 255, 0]);
  }
  for (let y = 0; y <= sprite.height; y += STEP) {
    const py = PAD + y * SCALE;
    const major = y % 50 === 0;
    for (let x = 0; x < W; x++) {
      if (!major && x % 3) continue;
      setPixel(out, x, py, major ? 255 : 0, major ? 40 : 200, major ? 40 : 255, 255);
    }
    drawNum(y, 4, py + 2, [255, 255, 0]);
  }
}

// 特征框
function box(r, col) {
  if (!r) return;
  const x0 = PAD + r.x * SCALE, y0 = PAD + r.y * SCALE;
  const x1 = x0 + r.w * SCALE, y1 = y0 + r.h * SCALE;
  for (let x = x0; x <= x1; x++) { setPixel(out, x, y0, ...col, 255); setPixel(out, x, y1, ...col, 255); }
  for (let y = y0; y <= y1; y++) { setPixel(out, x0, y, ...col, 255); setPixel(out, x1, y, ...col, 255); }
}
// 走统一的规整器：以前这里只认 v0 的 eyeL/eyeR，新格式素材一个框都画不出来，
// 而且是静默失败——图照出，就是没框。重复的兼容逻辑就是这么漂移的。
const EYE_COLORS = [[255, 0, 255], [0, 200, 255], [255, 200, 0]];
let eyeI = 0;
for (const p of normalizeParts(feat.parts)) {
  box(p, p.role === 'mouth' ? [0, 255, 0] : (EYE_COLORS[eyeI++ % EYE_COLORS.length]));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const bytes = encodePNG(OUT, out);
console.log(`写出 ${OUT}  ${W}x${H}  ${(bytes / 1024).toFixed(1)} KB  scale=${SCALE}`);
console.log('品红=左眼  青=右眼  绿=嘴');

// 生成一只可运行的 16 骨骼演示角色，打包成 .poppetpack。
//
// 用途是**验证运行时**，不是交付美术：部件是程序画出来的色块小人，
// 但骨架层级、枢轴、锚点、z 序、驱动器增益全部是真实数据，
// 走的也是真实的导入路径（buildPoppetpack -> 应用内导入 -> 严格校验）。
// 换上真正的美术之后，只需要替换 parts.png 和这里的尺寸表。
//
//   node tools/make-rig-demo.mjs [输出目录] [--preview]
//
// --preview 额外渲染一张姿势对照图：用**运行时同一套**解算器与变换算出关节角度，
// 再按最近邻旋转把部件贴出来。不启动 Electron 就能看出骨架算得对不对。
//
// 配色取自 character.json 里品牌角色的调色板，所以它看起来至少是同一个世界的东西。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createImage, setPixel, getPixel, encodePNG } from './png.mjs';
import { normalizeSkeleton, resolvePose, boneTransforms, drawOrder } from '../src/shared/skeleton.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildPoppetpack } = require(path.join(ROOT, 'src/main/pack.js'));

const ARGS = process.argv.slice(2);
const WANT_PREVIEW = ARGS.includes('--preview');
const OUT_DIR = path.resolve(ARGS.find(a => !a.startsWith('--')) || path.join(ROOT, 'dist'));

// —— 画布 ——
// 128 宽不是随手取的：招手时整条手臂会转到绑定姿势的包围盒之外，
// 画布必须留出那部分余量，否则举起来的手会被裁掉。这条约束对真实美术同样成立。
const W = 128, H = 128, FOOT_Y = 126;
const CX = 64, PELVIS_Y = 84;

// —— 配色（品牌调色板的子集）——
const OUTLINE = [1, 0, 0];
const SKIN = [231, 199, 174];
const HAIR = [254, 216, 123];
const SHIRT = [12, 43, 138];
const PANTS = [62, 43, 32];
const SHOE = [30, 22, 21];

// 同色系的明暗，用来给方块加一点体积感。写死三档比调 HSL 更可控，
// 像素风的阴影本来就是数得清的几档，不是连续渐变。
const shade = (c, k) => c.map(v => Math.max(0, Math.min(255, Math.round(v * k))));

// 关节隐藏重叠：部件在枢轴那一端多画几行**没有描边**的填充。
// 绑定姿势下这几行被父部件盖住看不见，一旦转动就顶上去补住接缝——
// 不画这几行，抬一次手肩膀那里就会露出一条底色缝。
// 这是真实美术同样要做的事，所以演示角色也照做。
const OVERLAP = 3;

// —— 骨骼表 ——
// pivot 是关节中心（部件自己的坐标），anchor 是"本骨枢轴落在父骨枢轴的哪个偏移上"。
// z 决定遮挡：右半身在身后（小 z），左半身在身前（大 z），躯干夹在中间。
// drivers 的负号就是左右反相——这就是"腿和手自然错开"的全部实现。
const BONES = [
  { id: 'pelvis', parent: null, w: 18, h: 10, px: 9, py: 5, ax: CX, ay: PELVIS_Y, z: 10,
    fill: PANTS, drivers: {} },

  // 右半身在身后
  { id: 'upperArmR', parent: 'torso', w: 8, h: 18, px: 4, py: 3, ax: -13, ay: -27, z: 4, overlap: OVERLAP,
    fill: SHIRT, drivers: { walkSwing: 0.5, dangle: 0.4 }, limit: [-150, 60] },
  { id: 'forearmR', parent: 'upperArmR', w: 7, h: 15, px: 3, py: 2, ax: 0, ay: 15, z: 4, overlap: OVERLAP,
    fill: SKIN, drivers: { walkSwing: 0.25, impact: -0.4 }, limit: [-20, 90] },
  { id: 'handR', parent: 'forearmR', w: 7, h: 7, px: 3, py: 1, ax: 0, ay: 13, z: 4, overlap: 2,
    fill: SKIN, drivers: {} },
  { id: 'thighR', parent: 'pelvis', w: 10, h: 20, px: 5, py: 2, ax: -5, ay: 5, z: 6, overlap: OVERLAP,
    fill: PANTS, drivers: { walkSwing: -1, dangle: 1 }, limit: [-70, 70] },
  { id: 'shinR', parent: 'thighR', w: 9, h: 18, px: 4, py: 2, ax: 0, ay: 18, z: 6, overlap: OVERLAP,
    fill: PANTS, drivers: { impact: 0.6, dangle: 0.5 }, limit: [-5, 90] },
  { id: 'footR', parent: 'shinR', w: 11, h: 6, px: 4, py: 2, ax: 0, ay: 16, z: 6, overlap: 2,
    fill: SHOE, drivers: {} },

  // 躯干与头
  { id: 'torso', parent: 'pelvis', w: 24, h: 32, px: 12, py: 32, ax: 0, ay: -5, z: 12,
    overlap: OVERLAP, overlapDir: 'bottom',
    fill: SHIRT, drivers: { breathe: 1 }, limit: [-15, 15] },
  { id: 'head', parent: 'torso', w: 22, h: 24, px: 11, py: 24, ax: 0, ay: -32, z: 14, overlap: OVERLAP,
    fill: SKIN, face: true, drivers: { breathe: -0.5 }, limit: [-20, 20] },
  { id: 'hair', parent: 'head', w: 24, h: 10, px: 12, py: 10, ax: 0, ay: -24, z: 15, overlap: 2,
    fill: HAIR, drivers: {} },

  // 左半身在身前
  { id: 'upperArmL', parent: 'torso', w: 8, h: 18, px: 4, py: 3, ax: 13, ay: -27, z: 20, overlap: OVERLAP,
    // 招手要把手臂举过水平线，而"举过水平"需要超过 90 度的旋转，
    // 所以这里用了最大增益 -2（1 × -2 × 70 = -140 度，量化后 -135 度）。
    fill: SHIRT, drivers: { walkSwing: -0.5, wave: -2, dangle: 0.4 }, limit: [-150, 60] },
  { id: 'forearmL', parent: 'upperArmL', w: 7, h: 15, px: 3, py: 2, ax: 0, ay: 15, z: 20, overlap: OVERLAP,
    fill: SKIN, drivers: { walkSwing: -0.25, wave: -0.5, impact: -0.4 }, limit: [-60, 90] },
  { id: 'handL', parent: 'forearmL', w: 7, h: 7, px: 3, py: 1, ax: 0, ay: 13, z: 20, overlap: 2,
    fill: SKIN, drivers: { wave: 0.4 }, limit: [-40, 40] },
  { id: 'thighL', parent: 'pelvis', w: 10, h: 20, px: 5, py: 2, ax: 5, ay: 5, z: 16, overlap: OVERLAP,
    fill: PANTS, drivers: { walkSwing: 1, dangle: 1 }, limit: [-70, 70] },
  { id: 'shinL', parent: 'thighL', w: 9, h: 18, px: 4, py: 2, ax: 0, ay: 18, z: 16, overlap: OVERLAP,
    fill: PANTS, drivers: { impact: 0.6, dangle: 0.5 }, limit: [-5, 90] },
  { id: 'footL', parent: 'shinL', w: 11, h: 6, px: 4, py: 2, ax: 0, ay: 16, z: 16, overlap: 2,
    fill: SHOE, drivers: {} },
];

// —— 图集排布：一条横向带，部件之间留 2px，避免采样蹭到邻居 ——
const PAD = 2;
let cursorX = PAD;
let atlasH = 0;
function alloc(w, h) {
  const frame = { sx: cursorX, sy: PAD, sw: w, sh: h };
  cursorX += w + PAD;
  atlasH = Math.max(atlasH, h);
  return frame;
}
for (const b of BONES) {
  // 重叠行加在枢轴那一端：肢体加在上端（枢轴跟着下移），躯干的枢轴在底部所以加在下端。
  if (b.overlap) {
    b.h += b.overlap;
    if (b.overlapDir !== 'bottom') b.py += b.overlap;
  }
  b.frame = alloc(b.w, b.h);
}
// 表情替换帧：同尺寸的另外两张头。尺寸必须一致，否则枢轴错位，眨一下眼头会跳一格。
const HEAD = BONES.find(b => b.id === 'head');
HEAD.exprFrames = { blink: alloc(HEAD.w, HEAD.h), talk: alloc(HEAD.w, HEAD.h) };
const ATLAS_W = cursorX;
const ATLAS_H = atlasH + PAD * 2;

// —— 画一个部件：实心 + 1px 描边 ——
// 关节处的"隐藏重叠"在这里体现为：每个肢体部件的顶端 2 行画满，
// 枢轴又落在那 2 行里，所以绕枢轴转动时接缝始终被父部件盖住，不会露出缺口。
function drawPart(img, bone, ox, oy, variant = 'base') {
  const { w, h, fill } = bone;
  const lit = shade(fill, 1.22);
  const dim = shade(fill, 0.70);
  const overlap = bone.overlap || 0;
  const capTop = overlap && bone.overlapDir !== 'bottom';
  const capBottom = overlap && bone.overlapDir === 'bottom';
  for (let y = 0; y < h; y++) {
    // 重叠行不画描边：它们本来就藏在父部件底下，
    // 画上描边反而会在转动时露出一条黑线。
    const inCap = (capTop && y < overlap) || (capBottom && y >= h - overlap);
    for (let x = 0; x < w; x++) {
      const sideEdge = x === 0 || x === w - 1;
      const endEdge = (y === 0 && !capTop) || (y === h - 1 && !capBottom);
      let c;
      if (inCap) c = sideEdge ? dim : fill;
      else if (sideEdge || endEdge) c = OUTLINE;
      else if (x === 1) c = lit;              // 受光的一侧
      else if (x === w - 2) c = dim;          // 背光的一侧
      else c = fill;
      setPixel(img, ox + x, oy + y, c[0], c[1], c[2], 255);
    }
  }
  if (!bone.face) return;

  // 脸：三张变体演示表情帧。眨眼是闭上的一条线，说话是张开的嘴。
  // 三张必须同尺寸——枢轴是按基础帧标的，尺寸一变眨一下眼整个头会跳一格。
  const top = overlap && bone.overlapDir !== 'bottom' ? overlap : 0;
  const px = (x, y, c) => setPixel(img, ox + x, oy + top + y, c[0], c[1], c[2], 255);
  const eyeOpen = (ex) => {
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) px(ex + x, 8 + y, OUTLINE);
    px(ex + 2, 8, shade(SKIN, 1.3));   // 一点高光，眼睛才不是死方块
  };
  const eyeShut = (ex) => { for (let x = 0; x < 4; x++) px(ex + x, 10, OUTLINE); };
  if (variant === 'blink') { eyeShut(5); eyeShut(13); } else { eyeOpen(5); eyeOpen(14); }

  if (variant === 'talk') {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
      px(8 + x, 15 + y, y === 0 || y === 3 || x === 0 || x === 5 ? OUTLINE : shade(SKIN, 0.55));
    }
  } else {
    for (let x = 0; x < 6; x++) px(8 + x, 16, OUTLINE);
  }
  // 腮红：一点点颜色让它不那么像机器人
  for (const cx2 of [3, 17]) for (let x = 0; x < 2; x++) px(cx2 + x, 13, [247, 139, 106]);
}

// —— 绑定姿势的世界位置（所有角度为 0，等价于 boneTransforms 的零姿势）——
const byId = new Map(BONES.map(b => [b.id, b]));
function worldPivot(bone) {
  if (bone.parent === null) return { x: bone.ax, y: bone.ay };
  const parent = worldPivot(byId.get(bone.parent));
  return { x: parent.x + bone.ax, y: parent.y + bone.ay };
}

// 最近邻旋转贴图，与渲染器的 imageSmoothingEnabled=false 同语义：
// 对目标像素做逆变换回源像素取样，不做任何插值。
// 平移吸附到整数像素，理由和渲染器里写的一样——半像素平移会把 1px 描边糊成虚线。
function blitRotated(dst, src, frame, pivot, cx, cy, degrees) {
  const rad = degrees * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const ox = Math.round(cx), oy = Math.round(cy);
  // 旋转后的包围盒：四角变换后取极值，逐目标像素反查。
  const corners = [[-pivot.x, -pivot.y], [frame.sw - pivot.x, -pivot.y],
    [-pivot.x, frame.sh - pivot.y], [frame.sw - pivot.x, frame.sh - pivot.y]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    const rx = x * cos - y * sin, ry = x * sin + y * cos;
    minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
  }
  for (let dy = Math.floor(minY); dy <= Math.ceil(maxY); dy++) {
    for (let dx = Math.floor(minX); dx <= Math.ceil(maxX); dx++) {
      const sx = Math.round(dx * cos + dy * sin) + pivot.x;
      const sy = Math.round(-dx * sin + dy * cos) + pivot.y;
      if (sx < 0 || sy < 0 || sx >= frame.sw || sy >= frame.sh) continue;
      const px = getPixel(src, frame.sx + sx, frame.sy + sy);
      if (!px || px[3] === 0) continue;
      const tx = ox + dx, ty = oy + dy;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      setPixel(dst, tx, ty, px[0], px[1], px[2], px[3]);
    }
  }
}

const PREVIEW_POSES = [
  ['静止', { }],
  ['走路·前', { walkSwing: 1, impact: 0 }],
  ['走路·后', { walkSwing: -1, impact: 0 }],
  ['落地', { impact: 1 }],
  ['被拎起', { dangle: 1 }],
  ['招手', { wave: 1 }],
];

function writePreview(meta, atlas, outFile) {
  const skeleton = normalizeSkeleton(meta.skeleton);
  if (!skeleton) throw new Error('演示骨架没通过运行时校验');
  const order = drawOrder(skeleton);
  const gap = 4;
  const sheet = createImage((W + gap) * PREVIEW_POSES.length + gap, H + gap * 2);
  PREVIEW_POSES.forEach(([, signals], i) => {
    const angles = resolvePose(skeleton, {
      walkSwing: 0, breathe: 0, dangle: 0, impact: 0, wave: 0, ...signals,
    });
    const nodes = boneTransforms(skeleton, angles);
    const offX = gap + i * (W + gap);
    for (const bone of order) {
      const node = nodes.get(bone.id);
      blitRotated(sheet, atlas, bone.frame, bone.pivot,
        offX + node.x, gap + node.y, node.angle);
    }
  });
  encodePNG(outFile, sheet);
  return PREVIEW_POSES.map(([name]) => name).join(' | ');
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-rig-'));

  // parts.png：骨架真正消费的图集
  const atlas = createImage(ATLAS_W, ATLAS_H);
  for (const b of BONES) drawPart(atlas, b, b.frame.sx, b.frame.sy);
  drawPart(atlas, HEAD, HEAD.exprFrames.blink.sx, HEAD.exprFrames.blink.sy, 'blink');
  drawPart(atlas, HEAD, HEAD.exprFrames.talk.sx, HEAD.exprFrames.talk.sy, 'talk');
  const atlasPath = path.join(tmp, 'parts.png');
  encodePNG(atlasPath, atlas);

  // pet.png：绑定姿势拍平图。骨架角色的运行时不看它，
  // 但管理器缩略图、首帧探针和任何读不懂 v3 的读取方都会看到它，
  // 所以它必须是一张说得通的静态立绘，而不是空白。
  const flat = createImage(W, H);
  const ordered = [...BONES].sort((a, b) => a.z - b.z);
  for (const b of ordered) {
    const at = worldPivot(b);
    drawPart(flat, b, at.x - b.px, at.y - b.py);
  }
  const petPath = path.join(tmp, 'pet.png');
  encodePNG(petPath, flat);

  // icon.png：正方形，取头部区域
  const ICON = 64;
  const icon = createImage(ICON, ICON);
  const head = byId.get('head');
  const hair = byId.get('hair');
  for (const b of [head, hair].sort((a, c) => a.z - c.z)) {
    const at = worldPivot(b);
    drawPart(icon, b, at.x - b.px - (CX - ICON / 2), at.y - b.py - 8);
  }
  const iconPath = path.join(tmp, 'icon.png');
  encodePNG(iconPath, icon);

  const meta = {
    schemaVersion: 3,
    sprite: { width: W, height: H },
    frames: null,
    atlas: { width: ATLAS_W, height: ATLAS_H },
    parts: [],
    suggestions: [],
    footY: FOOT_Y,
    outline: OUTLINE,
    palette: [OUTLINE, SKIN, HAIR, SHIRT, PANTS, SHOE,
      shade(SKIN, 1.22), shade(SKIN, 0.7), shade(SHIRT, 1.22), shade(SHIRT, 0.7),
      shade(PANTS, 1.22), shade(PANTS, 0.7), [247, 139, 106]],
    rig: { motion: 'walk', anchor: 'feet', flip: true, swayFrom: null },
    skeleton: {
      angleStep: 15,
      bones: BONES.map(b => ({
        id: b.id,
        parent: b.parent,
        pivot: { x: b.px, y: b.py },
        anchor: { x: b.ax, y: b.ay },
        z: b.z,
        frame: b.frame,
        drivers: b.drivers,
        limit: b.limit ?? null,
        expr: b.exprFrames ?? null,
      })),
    },
    source: {
      cropBBox: [0, 0, W - 1, H - 1],
      backgroundMode: 'alpha',
      originalSize: { width: W, height: H },
      extraction: {
        contractVersion: 1, extractor: 'local-edge-v1', status: 'ready', mode: 'alpha',
      },
      pixelize: {
        enabled: false, preset: 'original', targetHeight: null, paletteSize: null,
        methodVersion: 'local-box-median-cut-v1', width: W, height: H, colors: 6,
        sharedPalette: false,
      },
    },
    name: '骨架演示',
  };

  const bytes = buildPoppetpack({
    meta,
    files: {
      'pet.png': fs.readFileSync(petPath),
      'parts.png': fs.readFileSync(atlasPath),
      'icon.png': fs.readFileSync(iconPath),
    },
  });
  const out = path.join(OUT_DIR, 'rig-demo.poppetpack');
  fs.writeFileSync(out, bytes);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`骨骼数 ${BONES.length}  画布 ${W}x${H}  图集 ${ATLAS_W}x${ATLAS_H}`);
  console.log(`表情帧: 头部带 blink / talk 两张替换图（与基础帧同尺寸）`);
  console.log(`已写出 ${out}  (${bytes.length} 字节)`);
  console.log('在 Poppet 的角色管理里导入这个文件即可。');

  if (WANT_PREVIEW) {
    const previewFile = path.join(OUT_DIR, 'rig-demo-poses.png');
    const labels = writePreview(meta, atlas, previewFile);
    console.log(`姿势对照图: ${previewFile}`);
    console.log(`  ${labels}`);
  }
}

main();

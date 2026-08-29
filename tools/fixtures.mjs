// 测试素材生成器：造一批形态各异的像素角色，用来量管线的通用性边界。
//
// 这些图刻意不好看——它们要检验的是**形态假设**而不是画质：
// 侧面只有一只眼、悬浮角色没有脚、四足动物的脸在一端、机器人是方的、
// 史莱姆没有四肢……每一种都会踩中一条"直立人形全身像"的隐含假设。
//
// 真实素材才代表真实分布，这里只是把想得到的边界先固定成回归用例。

export function blank(w, h) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

export function rect(img, x, y, w, h, [r, g, b], a = 255) {
  for (let yy = Math.max(0, y | 0); yy < Math.min(img.height, (y + h) | 0); yy++) {
    for (let xx = Math.max(0, x | 0); xx < Math.min(img.width, (x + w) | 0); xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
    }
  }
}

export function ellipse(img, cx, cy, rx, ry, [r, g, b], a = 255) {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(img.height - 1, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(img.width - 1, Math.ceil(cx + rx)); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const i = (y * img.width + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
    }
  }
}

// 把透明背景压成不透明底色，用来测无 alpha 的输入
export function flatten(img, bg) {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    const a = out.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(out.data[i + c] * a + bg[c] * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

const SKIN = [235, 220, 200];
const INK = [20, 20, 30];
const LIP = [210, 60, 70];
const CLOTH = [40, 90, 200];
const HAIR = [90, 60, 30];

// —— 直立人形：基线，其它变体都跟它对照 ——
export function blockGuy({ withFace = true, skin = SKIN, ink = INK } = {}) {
  const img = blank(64, 96);
  rect(img, 20, 60, 24, 30, CLOTH);
  rect(img, 16, 8, 32, 48, skin);
  rect(img, 14, 4, 36, 8, HAIR);
  if (withFace) {
    rect(img, 22, 24, 7, 9, ink);
    rect(img, 36, 24, 7, 9, ink);
    rect(img, 29, 42, 8, 5, LIP);
  }
  return img;
}

// —— 侧面：只有一只眼，嘴贴在轮廓边上 ——
export function sideFace() {
  const img = blank(56, 92);
  rect(img, 18, 58, 22, 30, CLOTH);
  rect(img, 14, 8, 28, 46, SKIN);
  rect(img, 12, 4, 32, 8, HAIR);
  rect(img, 12, 12, 8, 34, HAIR);   // 后脑的头发
  rect(img, 30, 24, 7, 9, INK);     // 唯一的眼睛，偏向一侧
  rect(img, 36, 42, 6, 4, LIP);     // 嘴贴着轮廓
  return img;
}

// —— 独眼：一只居中的大眼 ——
export function cyclops() {
  const img = blank(60, 80);
  ellipse(img, 30, 34, 24, 30, [140, 200, 120]);
  ellipse(img, 30, 28, 10, 11, [250, 250, 245]);
  ellipse(img, 30, 28, 5, 6, INK);
  rect(img, 24, 52, 12, 4, INK);
  return img;
}

// —— 悬浮：圆身、没有脚，底部悬空 ——
export function floater() {
  const img = blank(64, 64);
  ellipse(img, 32, 30, 26, 24, [190, 170, 240]);
  rect(img, 22, 24, 6, 8, INK);
  rect(img, 36, 24, 6, 8, INK);
  rect(img, 28, 40, 8, 4, INK);
  // 下缘做成波浪状的裙边，暗示它是飘着的
  for (let i = 0; i < 5; i++) ellipse(img, 12 + i * 10, 52, 6, 5, [190, 170, 240]);
  return img;
}

// —— 四足：身子横着，脸在一端 ——
export function quadruped() {
  const img = blank(96, 56);
  rect(img, 20, 20, 56, 22, [200, 160, 90]);   // 躯干
  rect(img, 8, 12, 28, 26, [200, 160, 90]);    // 头
  rect(img, 12, 6, 8, 8, [200, 160, 90]);      // 耳朵
  rect(img, 26, 6, 8, 8, [200, 160, 90]);
  rect(img, 14, 20, 6, 7, INK);                // 双眼（在头的同一侧，间距小）
  rect(img, 26, 20, 6, 7, INK);
  rect(img, 19, 32, 6, 3, LIP);
  for (const x of [24, 40, 56, 68]) rect(img, x, 42, 7, 12, [180, 140, 70]); // 四条腿
  rect(img, 74, 14, 16, 8, [200, 160, 90]);    // 尾巴
  return img;
}

// —— 机器人：方头方眼，一条横嘴 ——
export function robot() {
  const img = blank(56, 88);
  rect(img, 14, 6, 28, 26, [170, 175, 185]);
  rect(img, 20, 32, 16, 6, [120, 125, 135]);   // 脖子
  rect(img, 10, 38, 36, 32, [140, 145, 160]);  // 躯干
  rect(img, 14, 70, 10, 16, [110, 115, 125]);  // 腿
  rect(img, 32, 70, 10, 16, [110, 115, 125]);
  rect(img, 19, 14, 7, 7, [80, 220, 255]);     // 发光的方眼
  rect(img, 31, 14, 7, 7, [80, 220, 255]);
  rect(img, 22, 25, 12, 3, [60, 60, 70]);      // 一条横嘴
  return img;
}

// —— 史莱姆：半圆，没有四肢 ——
export function slime() {
  const img = blank(64, 48);
  ellipse(img, 32, 40, 28, 22, [110, 210, 180]);
  rect(img, 0, 40, 64, 8, [0, 0, 0], 0);       // 削掉下半，做成半圆
  ellipse(img, 32, 40, 28, 22, [110, 210, 180]);
  for (let y = 42; y < 48; y++) rect(img, 6, y, 52, 1, [110, 210, 180]);
  rect(img, 22, 30, 5, 7, INK);
  rect(img, 37, 30, 5, 7, INK);
  rect(img, 28, 40, 8, 3, [40, 120, 100]);
  return img;
}

// —— 极小：32x32，部件只有几像素 ——
export function tiny() {
  const img = blank(32, 32);
  rect(img, 10, 18, 12, 12, CLOTH);
  rect(img, 9, 4, 14, 14, SKIN);
  rect(img, 12, 9, 3, 4, INK);
  rect(img, 18, 9, 3, 4, INK);
  rect(img, 14, 15, 4, 2, LIP);
  return img;
}

// —— 宽扁：横向构图 ——
export function wide() {
  const img = blank(120, 48);
  rect(img, 10, 14, 100, 28, [220, 120, 140]);
  rect(img, 30, 20, 8, 9, INK);
  rect(img, 80, 20, 8, 9, INK);
  rect(img, 52, 34, 14, 4, LIP);
  return img;
}

// —— 单色：全灰阶，色相判据在这里完全没有信息可用 ——
export function monochrome() {
  const img = blank(64, 96);
  rect(img, 20, 60, 24, 30, [90, 90, 90]);
  rect(img, 16, 8, 32, 48, [210, 210, 210]);
  rect(img, 14, 4, 36, 8, [60, 60, 60]);
  rect(img, 22, 24, 7, 9, [25, 25, 25]);
  rect(img, 36, 24, 7, 9, [25, 25, 25]);
  rect(img, 29, 42, 8, 5, [130, 130, 130]);
  return img;
}

// —— 深色角色 + 亮眼：与常规明暗关系相反 ——
export function darkChar() {
  return blockGuy({ skin: [55, 40, 60], ink: [250, 245, 220] });
}

// —— 无脸：纯物体 ——
export function faceless() {
  const img = blank(60, 60);
  rect(img, 10, 20, 40, 30, [180, 140, 90]);
  rect(img, 12, 8, 10, 14, [180, 140, 90]);
  rect(img, 38, 8, 10, 14, [180, 140, 90]);
  return img;
}

// 形态维度上的完整用例表。expectFace 是"应该检出至少一只眼睛"，
// null 表示两种结果都可接受（这类图本来就没有唯一正解）。
export const FIXTURES = [
  { name: '直立人形', make: () => blockGuy(), expectFace: true, kind: 'humanoid' },
  { name: '深肤浅眼', make: () => darkChar(), expectFace: true, kind: 'humanoid' },
  { name: '单色灰阶', make: () => monochrome(), expectFace: true, kind: 'humanoid' },
  { name: '极小 32px', make: () => tiny(), expectFace: null, kind: 'humanoid' },
  { name: '侧面单眼', make: () => sideFace(), expectFace: true, kind: 'side' },
  { name: '独眼', make: () => cyclops(), expectFace: true, kind: 'single-eye' },
  { name: '悬浮无脚', make: () => floater(), expectFace: true, kind: 'floating' },
  { name: '四足动物', make: () => quadruped(), expectFace: true, kind: 'quadruped' },
  { name: '机器人', make: () => robot(), expectFace: true, kind: 'humanoid' },
  { name: '史莱姆', make: () => slime(), expectFace: true, kind: 'blob' },
  { name: '宽扁构图', make: () => wide(), expectFace: true, kind: 'wide' },
  { name: '无脸物体', make: () => faceless(), expectFace: false, kind: 'object' },
];

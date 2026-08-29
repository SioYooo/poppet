// 形态巡检：把 fixtures 里每种形态过一遍管线，看检出情况与推断出的属性。
// 这不是通过/失败的测试，而是一张"现在到底能覆盖到哪"的地图。
//
// 用法: node tools/survey.mjs [--write 输出目录]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './png.mjs';
import { buildCharacter } from '../src/shared/pipeline.js';
import { normalizeParts } from '../src/shared/parts.js';
import { FIXTURES } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write')
  ? process.argv[process.argv.indexOf('--write') + 1] : null;
if (WRITE) fs.mkdirSync(WRITE, { recursive: true });

const rows = [];
for (const f of FIXTURES) {
  const src = f.make();
  let r = null, err = null;
  try { r = buildCharacter(src); } catch (e) { err = e.message; }
  const parts = normalizeParts(r?.meta?.parts);
  const eyeCount = parts.filter(x => x.role === 'eye').length;
  const hasEyes = eyeCount > 0;
  const hasMouth = parts.some(x => x.role === 'mouth');
  const sprite = r?.meta?.sprite;
  // 底部实心比例：脚踩地的角色底边有支撑，悬浮/圆身的收得很窄
  let bottomRatio = null, aspect = null;
  if (r) {
    const { width: W, height: H, data } = r.sprite;
    const rowFilled = (y) => { let n = 0; for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 0) n++; return n; };
    let maxW = 0;
    for (let y = 0; y < H; y++) maxW = Math.max(maxW, rowFilled(y));
    // 从"最后一个有内容的行"往上量，不能从画布底边量——裁剪时留了 margin，
    // 底下几行本来就是空的，从那里起算会把站立角色也算成 0%。
    let lastRow = H - 1;
    while (lastRow > 0 && rowFilled(lastRow) === 0) lastRow--;
    const band = Math.max(1, Math.round(H * 0.06));
    let bottom = 0;
    for (let y = lastRow; y > lastRow - band && y >= 0; y--) bottom = Math.max(bottom, rowFilled(y));
    bottomRatio = maxW ? bottom / maxW : 0;
    aspect = W / H;
  }
  rows.push({ ...f, hasEyes, eyeCount, hasMouth, err, sprite, bottomRatio, aspect, rig: r?.meta?.rig });

  if (WRITE && r) {
    const toBuf = (im) => ({ width: im.width, height: im.height, data: Buffer.from(im.data.buffer, im.data.byteOffset, im.data.length) });
    encodePNG(path.join(WRITE, f.name + '.png'), toBuf(r.sprite));
  }
}

const mark = (ok) => ok === null ? '·' : ok ? '✓' : '✗';
console.log('形态'.padEnd(10) + '类别'.padEnd(12) + '尺寸'.padEnd(10) + '眼 嘴  期望  翻转 移动    宽高比');
console.log('-'.repeat(80));
let surprises = 0;
for (const r of rows) {
  const asExpected = r.expectFace === null || r.expectFace === r.hasEyes;
  if (!asExpected) surprises++;
  console.log(
    r.name.padEnd(8) + r.kind.padEnd(12) +
    (r.sprite ? `${r.sprite.width}x${r.sprite.height}`.padEnd(10) : 'ERR'.padEnd(10)) +
    ` ${r.eyeCount}  ${r.hasMouth ? '有' : '无'}  ` +
    `${r.expectFace === null ? '不限' : r.expectFace ? '应有' : '应无'}` +
    `${asExpected ? '  ' : '←偏'} ` +
    `${r.rig ? (r.rig.flip ? '是  ' : '否  ') : '-   '}` +
    `${r.rig ? r.rig.motion.padEnd(8) : '-       '}` +
    `${r.aspect ? r.aspect.toFixed(2) : '-'}` +
    (r.err ? '  异常: ' + r.err : '')
  );
}
console.log('-'.repeat(80));
console.log(`${rows.length} 种形态，${surprises} 种与预期不符`);
if (WRITE) console.log('精灵已写出到 ' + WRITE);

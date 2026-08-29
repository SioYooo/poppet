// 用通用管线（src/shared/pipeline.js）把源图处理成内置角色，写进 assets/characters/<id>/。
// 这里跑的是和管理界面完全相同的一套代码，所以内置角色本身就是管线的一次回归验证。
//
// 用法: node tools/build-default-character.mjs [源图路径] [角色id] [显示名] [--grid 列x行]
//   --grid 6x1  把源图当作 sprite sheet 按网格切成多帧
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './png.mjs';
import { buildCharacter } from '../src/shared/pipeline.js';
import { normalizeParts } from '../src/shared/parts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] || path.join(ROOT, 'assets/source/original.png');
const id = process.argv[3] || 'default';
const name = process.argv[4] || '默认角色';

const decoded = decodePNG(src);
const single = {
  width: decoded.width,
  height: decoded.height,
  data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length),
};
console.log(`源图 ${single.width}x${single.height}  ${src}`);

// --grid 列x行：把源图当 sprite sheet 切成多帧
const gridArg = process.argv.includes('--grid') ? process.argv[process.argv.indexOf('--grid') + 1] : null;
let source = single;
if (gridArg) {
  const [cols, rows] = gridArg.split('x').map(Number);
  const fw = Math.floor(single.width / cols), fh = Math.floor(single.height / rows);
  const frames = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const out = new Uint8ClampedArray(fw * fh * 4);
    for (let y = 0; y < fh; y++) {
      const s0 = ((r * fh + y) * single.width + c * fw) * 4;
      out.set(single.data.subarray(s0, s0 + fw * 4), y * fw * 4);
    }
    frames.push({ width: fw, height: fh, data: out });
  }
  source = frames.filter(f => { for (let i = 3; i < f.data.length; i += 4) if (f.data[i] > 8) return true; return false; });
  console.log(`按 ${cols}x${rows} 切成 ${source.length} 帧，每帧 ${fw}x${fh}`);
}

const t0 = Date.now();
const result = buildCharacter(source);
console.log(`管线耗时 ${Date.now() - t0}ms`);
for (const s of result.report.steps) console.log('  · ' + s);
for (const w of result.report.warnings) console.log('  ⚠ ' + w);

const parts = normalizeParts(result.meta.parts);
const eyes = parts.filter(p => p.role === 'eye');
const mouth = parts.find(p => p.role === 'mouth');
if (eyes.length) {
  console.log('  眼睛 ' + eyes.map(e => `[${e.x},${e.y}]${e.w}x${e.h}`).join(' ') +
              (mouth ? `  嘴 [${mouth.x},${mouth.y}]${mouth.w}x${mouth.h}` : '  嘴 —'));
}
if (result.meta.frames) console.log(`  帧动画 ${result.meta.frames.count} 帧 @ ${result.meta.frames.fps}fps`);
console.log(`  描边色 rgb(${result.meta.outline})  脚底 y=${result.meta.footY}`);

const outDir = path.join(ROOT, 'assets/characters', id);
fs.mkdirSync(outDir, { recursive: true });
const toBuf = (img) => ({ width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) });

encodePNG(path.join(outDir, 'pet.png'), toBuf(result.sprite));
if (result.atlas) encodePNG(path.join(outDir, 'parts.png'), toBuf(result.atlas));
encodePNG(path.join(outDir, 'icon.png'), toBuf(result.icon));
fs.writeFileSync(
  path.join(outDir, 'character.json'),
  JSON.stringify({ ...result.meta, name, builtin: true }, null, 2),
);
console.log(`\n写出 ${path.relative(ROOT, outDir)}/  (pet.png, ${result.atlas ? 'parts.png, ' : ''}icon.png, character.json)`);

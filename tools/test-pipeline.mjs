// 管线鲁棒性测试：造几张形态各异的输入，确认去背、五官检测、降级路径都站得住。
// 这里检验的是"换一张图还灵不灵"，而不是某一张图好不好看。
//
// 用法: node tools/test-pipeline.mjs [--write 输出目录]
import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from './png.mjs';
import { buildCharacter } from '../src/shared/pipeline.js';
import { normalizeParts } from '../src/shared/parts.js';
import { makeCanonicalCharacter } from '../test/fixtures/canonical-character.mjs';

const WRITE = process.argv.includes('--write')
  ? process.argv[process.argv.indexOf('--write') + 1]
  : null;

const blank = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

function fill(img, x, y, w, h, [r, g, b], a = 255) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
    }
  }
}

function flatten(img, bg) {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    const a = out.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(out.data[i + c] * a + bg[c] * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

// 一只"猫"：五官不成对，用来验证检测不到时能安全降级
function makeNoFace() {
  const img = blank(60, 60);
  fill(img, 10, 20, 40, 30, [180, 140, 90]);
  fill(img, 12, 8, 10, 14, [180, 140, 90]);
  fill(img, 38, 8, 10, 14, [180, 140, 90]);
  return img;
}

const CASES = [
  ['生成夹具（自带 alpha）', () => makeCanonicalCharacter(), { expectFace: true, expectBg: 'alpha' }],
  ['生成夹具·白底', () => flatten(makeCanonicalCharacter(), [255, 255, 255]), { expectFace: true, expectBg: 'chroma' }],
  ['生成夹具·绿幕', () => flatten(makeCanonicalCharacter(), [0, 255, 0]), { expectFace: true, expectBg: 'chroma' }],
  ['生成夹具·深灰底', () => flatten(makeCanonicalCharacter(), [30, 30, 34]), { expectFace: true, expectBg: 'chroma' }],
  ['生成夹具·深肤色浅眼', () => makeCanonicalCharacter({ skin: [70, 45, 35], ink: [245, 240, 220] }), { expectFace: true, expectBg: 'alpha' }],
  ['无五官（猫）', () => makeNoFace(), { expectFace: false, expectBg: 'alpha' }],
  ['生成夹具·无脸', () => makeCanonicalCharacter({ withFace: false }), { expectFace: false, expectBg: 'alpha' }],
];

let pass = 0, fail = 0;
if (WRITE) fs.mkdirSync(WRITE, { recursive: true });

for (const [name, make, expect] of CASES) {
  let line = `${name.padEnd(22)}`;
  try {
    const src = make();
    const t0 = Date.now();
    const r = buildCharacter(src);
    const ms = Date.now() - t0;
    const parts = normalizeParts(r.meta.parts);
    const eyes = parts.filter(x => x.role === 'eye');
    const hasMouth = parts.some(x => x.role === 'mouth');
    const hasFace = eyes.length > 0;
    const bgMode = r.meta.source.backgroundMode;

    const okFace = hasFace === expect.expectFace;
    const okBg = bgMode === expect.expectBg;
    line += ` 去背=${bgMode.padEnd(6)} 精灵=${String(r.sprite.width).padStart(3)}x${r.sprite.height}`;
    line += ` 眼=${eyes.length} 嘴=${hasMouth ? '有' : '无'} ${String(ms).padStart(4)}ms`;
    if (hasFace) line += '  ' + eyes.map(e => `[${e.x},${e.y}]${e.w}x${e.h}`).join(' ');
    if (okFace && okBg) { pass++; console.log('  ✓ ' + line); }
    else {
      fail++;
      console.log('  ✗ ' + line);
      if (!okFace) console.log(`      期望${expect.expectFace ? '检出' : '检不出'}眼睛，实际相反`);
      if (!okBg) console.log(`      期望去背模式 ${expect.expectBg}，实际 ${bgMode}`);
    }
    if (WRITE) {
      const slug = name.replace(/[^\w一-龥]+/g, '_');
      const toBuf = (im) => ({ width: im.width, height: im.height, data: Buffer.from(im.data.buffer, im.data.byteOffset, im.data.length) });
      encodePNG(path.join(WRITE, slug + '.png'), toBuf(r.sprite));
      if (r.atlas) encodePNG(path.join(WRITE, slug + '-parts.png'), toBuf(r.atlas));
    }
  } catch (err) {
    fail++;
    console.log('  ✗ ' + line + ' 抛异常: ' + err.message);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败 / 共 ${CASES.length}`);
process.exit(fail ? 1 : 0);

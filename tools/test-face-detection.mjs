// Semantic face-detector acceptance runner.
//
// Synthetic fixtures are always code-generated. A real user image can be
// checked locally without copying it into the repository:
//   node tools/test-face-detection.mjs \
//     --real /absolute/image.png \
//     --eyes "x,y,w,h;x,y,w,h" \
//     --forbid "x,y,w,h;x,y,w,h"
// Coordinates are supplied at invocation time and remain outside tracked test
// data. The real image runs through the complete buildCharacter pipeline.

import path from 'node:path';
import { detectFace, buildCharacter } from '../src/shared/pipeline.js';
import { normalizeParts } from '../src/shared/parts.js';
import { decodePNG } from './png.mjs';
import { FACE_CASES } from '../test/face-detection/fixtures.mjs';
import { assertSemanticEyeBoxes } from '../test/face-detection/assertions.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function parseBoxes(value, label) {
  if (!value) return [];
  return value.split(';').filter(Boolean).map((entry) => {
    const numbers = entry.split(',').map(Number);
    if (numbers.length !== 4 || numbers.some(n => !Number.isFinite(n)) || numbers[2] <= 0 || numbers[3] <= 0) {
      throw new Error(`${label} 必须是 x,y,w,h;x,y,w,h`);
    }
    return { x: numbers[0], y: numbers[1], w: numbers[2], h: numbers[3] };
  });
}

function detectionBoxes(result) {
  return (result?.eyes || []).filter(Boolean).map(blob => ({
    x: blob.x0, y: blob.y0, w: blob.w, h: blob.h,
  }));
}

let passed = 0;
for (const makeFixture of FACE_CASES) {
  const fixture = makeFixture();
  assertSemanticEyeBoxes({
    name: fixture.name,
    expected: fixture.eyes,
    actual: detectionBoxes(detectFace(fixture.image)),
    forbidden: fixture.forbidden,
  });
  passed++;
}
console.log(`synthetic semantic face cases: ${passed}/${FACE_CASES.length} passed`);

const realPath = option('--real');
if (realPath) {
  const expectedOriginal = parseBoxes(option('--eyes'), '--eyes');
  if (!expectedOriginal.length) throw new Error('--real 必须同时提供真实眼睛的 --eyes 坐标');
  const forbiddenOriginal = parseBoxes(option('--forbid'), '--forbid');
  const result = buildCharacter(decodePNG(path.resolve(realPath)));
  const [cropX, cropY, cropX1, cropY1] = result.meta.source.cropBBox;
  const scaleX = result.meta.sprite.width / (cropX1 - cropX + 1);
  const scaleY = result.meta.sprite.height / (cropY1 - cropY + 1);
  const scale = box => ({
    x: (box.x - cropX) * scaleX,
    y: (box.y - cropY) * scaleY,
    w: box.w * scaleX,
    h: box.h * scaleY,
  });
  const actual = normalizeParts(result.meta.parts)
    .filter(part => part.role === 'eye')
    .map(part => part.src || { x: part.x, y: part.y, w: part.w, h: part.h });

  assertSemanticEyeBoxes({
    name: path.basename(realPath),
    expected: expectedOriginal.map(scale),
    actual,
    forbidden: forbiddenOriginal.map(scale),
    minIou: 0.20,
  });
  console.log(`real pipeline acceptance: ${path.basename(realPath)} ${actual.length}/${expectedOriginal.length} eyes matched`);
}

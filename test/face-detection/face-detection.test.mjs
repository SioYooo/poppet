import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacter, detectFace } from '../../src/shared/pipeline.js';
import { capabilityOf, normalizeParts } from '../../src/shared/parts.js';
import { blank, candidateExplosion, FACE_CASES, rect } from './fixtures.mjs';
import { assertSemanticEyeBoxes } from './assertions.mjs';

function toBox(blob) {
  return { x: blob.x0, y: blob.y0, w: blob.w, h: blob.h };
}

export function assertSemanticEyes(fixture, result) {
  const actual = (result?.eyes || []).filter(Boolean).map(toBox);
  assertSemanticEyeBoxes({
    name: fixture.name,
    expected: fixture.eyes,
    actual,
    forbidden: fixture.forbidden,
  });
}

for (const makeFixture of FACE_CASES) {
  const fixture = makeFixture();
  test(`detectFace: ${fixture.name}`, () => {
    assertSemanticEyes(fixture, detectFace(fixture.image));
  });

  test(`buildCharacter: ${fixture.name}`, () => {
    const result = buildCharacter(fixture.image);
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
      name: `pipeline ${fixture.name}`,
      expected: fixture.eyes.map(scale),
      actual,
      forbidden: (fixture.forbidden || []).map(scale),
    });
  });
}

test('candidate explosion obeys an injectable deterministic budget', () => {
  const { image, candidateCount } = candidateExplosion();
  assert.equal(candidateCount, 190, 'fixture must stay above the 128-candidate budget');
  assert.throws(
    () => detectFace(image, { maxCandidates: 128 }),
    error => error?.code === 'POPPET_FACE_CANDIDATE_LIMIT',
    'candidate overflow must fail closed with a stable resource-limit code',
  );
});

test('buildCharacter propagates the face-candidate budget and degrades safely', () => {
  const { image } = candidateExplosion();
  const result = buildCharacter(image, { maxCandidates: 128 });
  const eyes = normalizeParts(result.meta.parts).filter(part => part.role === 'eye');
  assert.deepEqual(eyes, []);
  assert.ok(result.report.warnings.some(message => /候选过多/.test(message) && /最多 128 个/.test(message)),
    `expected propagated 128-candidate warning, got ${JSON.stringify(result.report.warnings)}`);
});

test('manual mouth-only metadata remains a user mouth without enabling blink', () => {
  const image = blank(48, 64);
  rect(image, 4, 4, 40, 56, [232, 211, 190]);
  rect(image, 17, 36, 14, 6, [205, 58, 72]);
  const result = buildCharacter(image, {
    features: {
      eyes: [],
      mouth: { x: 17, y: 36, w: 14, h: 6, source: 'user' },
    },
  });
  const parts = normalizeParts(result.meta.parts);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].role, 'mouth');
  assert.equal(parts[0].source, 'user');
  assert.deepEqual(capabilityOf(result.meta), { blink: false, talk: true, skeletal: false, clips: [] });
});

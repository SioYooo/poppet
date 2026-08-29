import assert from 'node:assert/strict';

function center(box) {
  return { x: box.x + (box.w - 1) / 2, y: box.y + (box.h - 1) / 2 };
}

function contains(box, point) {
  return point.x >= box.x && point.x <= box.x + box.w - 1 &&
    point.y >= box.y && point.y <= box.y + box.h - 1;
}

function intersectionArea(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

export function boxIou(a, b) {
  const intersection = intersectionArea(a, b);
  return intersection / (a.w * a.h + b.w * b.h - intersection);
}

function isSemanticMatch(actual, expected, minIou) {
  const ratio = (actual.w * actual.h) / (expected.w * expected.h);
  return boxIou(actual, expected) >= minIou ||
    (ratio >= 0.40 && ratio <= 2.50 &&
      contains(actual, center(expected)) && contains(expected, center(actual)));
}

export function assertSemanticEyeBoxes({
  name,
  expected,
  actual,
  forbidden = [],
  minIou = 0.35,
}) {
  if (!expected.length) {
    assert.deepEqual(actual, [], `${name}: non-eye regions must not become an animatable eye`);
    return;
  }

  assert.equal(actual.length, expected.length,
    `${name}: expected ${expected.length} semantic eye(s), got ${JSON.stringify(actual)}`);

  const unused = new Set(actual.map((_, index) => index));
  for (const truth of expected) {
    const match = [...unused].find(index => isSemanticMatch(actual[index], truth, minIou));
    assert.notEqual(match, undefined,
      `${name}: no detection matched ground-truth eye ${JSON.stringify(truth)}; actual=${JSON.stringify(actual)}`);
    unused.delete(match);
  }

  // Forbidden boxes are spatial distractors outside the true eye (for example
  // inner ears). Nested lens/highlight mistakes are rejected by IoU/area above.
  for (const trap of forbidden) {
    const trapCenter = center(trap);
    assert.equal(actual.some(box => contains(box, trapCenter)), false,
      `${name}: a forbidden distractor centre was classified as an eye; actual=${JSON.stringify(actual)}`);
  }
}

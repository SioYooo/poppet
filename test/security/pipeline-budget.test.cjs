'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS } = require('../../src/main/security');

const frame = (width = 1, height = 1) => ({
  width, height, data: new Uint8ClampedArray(width * height * 4),
});

test('pipeline and main-process resource ceilings stay aligned', async () => {
  const { DEFAULTS } = await import('../../src/shared/pipeline.js');
  assert.equal(DEFAULTS.maxFrames, LIMITS.MAX_FRAMES);
  assert.equal(DEFAULTS.maxSourcePixels, LIMITS.MAX_FRAME_PIXELS);
  assert.equal(DEFAULTS.maxTotalSourcePixels, LIMITS.MAX_TOTAL_PIXELS);
  assert.equal(DEFAULTS.maxSourceDimension, LIMITS.MAX_DIMENSION);
  assert.equal(DEFAULTS.maxSheetWidth, LIMITS.MAX_SHEET_WIDTH);
  assert.equal(DEFAULTS.maxWorkingPixels, LIMITS.MAX_WORKING_PIXELS);
  assert.equal(DEFAULTS.maxFileBytes, LIMITS.MAX_FILE_BYTES);
  assert.equal(DEFAULTS.processingTimeoutMs, LIMITS.PROCESSING_TIMEOUT_MS);
  assert.equal(DEFAULTS.maxOpaqueRuns, LIMITS.MAX_OPAQUE_RUNS);
});

test('chroma background flood fill is bounded for single and shared-frame decisions', async () => {
  const { removeBackground } = await import('../../src/shared/pipeline.js');
  const make = () => {
    const image = frame(16, 16);
    image.data.fill(255);
    for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = 0; image.data[i + 1] = 0; image.data[i + 2] = 0;
    }
    return image;
  };
  const first = make();
  const decision = removeBackground(first);
  assert.equal(decision.mode, 'chroma');
  assert.ok(decision.removed > 0);
  const second = make();
  assert.equal(removeBackground(second, {}, decision).mode, 'chroma');
});

test('fragmentation introduced by background removal is checked before components', async () => {
  const { buildCharacter } = await import('../../src/shared/pipeline.js');
  const image = frame(128, 128);
  image.data.fill(255);
  for (let y = 2; y < 126; y += 2) for (let x = 2; x < 126; x += 2) {
    const i = (y * image.width + x) * 4;
    image.data[i] = 0; image.data[i + 1] = 0; image.data[i + 2] = 0;
  }
  assert.throws(() => buildCharacter(image, { maxOpaqueRuns: 128 }), /碎片化/);
});

test('buildCharacter rejects a virtual 16MP alpha checkerboard before allocation-heavy work', async () => {
  const { buildCharacter } = await import('../../src/shared/pipeline.js');
  const width = 4096, height = 4096;
  let reads = 0;
  const data = new Proxy({ length: width * height * 4 }, {
    get(target, property) {
      if (property === 'length') return target.length;
      const index = Number(property);
      if (!Number.isInteger(index) || index < 0) return target[property];
      reads++;
      if (index % 4 !== 3) return 0;
      const pixel = (index - 3) / 4;
      const x = pixel % width, y = Math.floor(pixel / width);
      return (x + y) % 2 ? 255 : 0;
    },
  });
  assert.throws(() => buildCharacter({ width, height, data }), /碎片化/);
  assert.ok(reads < 2_000_000, `expected early rejection, read ${reads} virtual bytes`);
});

test('real 8192x400 input is downscaled before quantize working-set allocation', async () => {
  const { buildCharacter, DEFAULTS } = await import('../../src/shared/pipeline.js');
  const image = frame(8192, 400);
  image.data.fill(255);
  // 四角不一致使它走满幅插画路径，内容框保持真实 8192x400，而不是被裁成小点。
  image.data[(image.width - 1) * 4] = 0;
  image.data[(image.width - 1) * 4 + 1] = 0;
  image.data[(image.width - 1) * 4 + 2] = 0;
  const result = buildCharacter(image, {
    features: { eyes: [{ x: 10, y: 10, w: 2, h: 2 }], mouth: null },
  });
  const workingPixels = result.sprite.width * result.sprite.height;
  assert.ok(workingPixels <= DEFAULTS.maxWorkingPixels,
    `${result.sprite.width}x${result.sprite.height} exceeds working budget`);
  assert.ok(result.report.steps.some(step => step.includes('工作像素预算')));
});

test('multi-frame scaling applies the working budget to the whole sprite sheet', async () => {
  const { buildCharacter } = await import('../../src/shared/pipeline.js');
  const make = () => {
    const image = frame(200, 200);
    for (let y = 10; y < 190; y++) for (let x = 10; x < 190; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = 80; image.data[i + 1] = 120; image.data[i + 2] = 160; image.data[i + 3] = 255;
    }
    return image;
  };
  const result = buildCharacter([make(), make()], {
    maxWorkingPixels: 10_000,
    features: { eyes: [{ x: 10, y: 10, w: 2, h: 2 }], mouth: null },
  });
  assert.equal(result.meta.frames.count, 2);
  assert.ok(result.sprite.width * result.sprite.height <= 10_000);
});

test('cancellation raised inside face detection aborts instead of becoming a warning', async () => {
  const { buildCharacter } = await import('../../src/shared/pipeline.js');
  const image = frame(32, 32);
  for (let y = 4; y < 28; y++) for (let x = 6; x < 26; x++) {
    const i = (y * image.width + x) * 4;
    image.data[i] = 80;
    image.data[i + 1] = 120;
    image.data[i + 2] = 180;
    image.data[i + 3] = 255;
  }

  assert.throws(
    () => buildCharacter(image, {
      shouldCancel: stage => stage === '五官区域生长',
    }),
    error => error?.code === 'POPPET_PROCESS_CANCELLED',
  );
});

test('buildCharacter rejects frame, aggregate, dimension, data and deadline violations before work', async () => {
  const { buildCharacter } = await import('../../src/shared/pipeline.js');
  assert.throws(() => buildCharacter(Array.from({ length: 65 }, () => frame())), /最多 64 帧/);
  assert.throws(() => buildCharacter([frame(3, 3), frame(3, 3)], { maxTotalSourcePixels: 10 }), /总像素/);
  assert.throws(() => buildCharacter({ width: 8193, height: 1, data: new Uint8ClampedArray(4) }), /边长/);
  assert.throws(() => buildCharacter({ width: 2, height: 2, data: new Uint8ClampedArray(4) }), /数据不完整/);
  assert.throws(() => buildCharacter(frame(2, 2), { deadline: Date.now() - 1 }), /超时/);
});

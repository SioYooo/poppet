import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  FIRST_FRAME_PROBE_MAX_PIXELS,
  Sprite,
  hasVisibleStagePixel,
} from '../../src/renderer/pet/sprite.js';

const petScript = fs.readFileSync(new URL('../../src/renderer/pet/pet.js', import.meta.url), 'utf8');

function mouthPart() {
  return {
    role: 'mouth', id: 'mouth', source: 'user',
    x: 2, y: 3, w: 2, h: 2,
    frame: { sx: 0, sy: 0, sw: 2, sh: 2 },
    cleanFrame: { sx: 2, sy: 0, sw: 2, sh: 2 },
  };
}

function eyePart() {
  return {
    role: 'eye', id: 'eye0', source: 'user',
    x: 1, y: 1, w: 2, h: 2,
    frame: { sx: 0, sy: 0, sw: 2, sh: 2 },
    cleanFrame: { sx: 2, sy: 0, sw: 2, sh: 2 },
  };
}

function composableSprite(parts) {
  const sprite = new Sprite({
    meta: { sprite: { width: 8, height: 8 }, parts, outline: [0, 0, 0] },
  });
  const draws = [];
  sprite.canvas = { width: 8, height: 8 };
  sprite.spriteImg = { kind: 'sprite' };
  sprite.atlasImg = { kind: 'atlas' };
  sprite.faceRect = { x: 1, y: 0, w: 4, h: 7 };
  sprite.rowSpans = { eye0: [[0, 1], [0, 1]] };
  sprite.ctx = {
    clearRect() {}, fillRect() {},
    drawImage(...args) { draws.push(args); },
    getImageData() { return { data: new Uint8ClampedArray(8 * 8 * 4) }; },
  };
  return { sprite, draws };
}

test('mouth-only characters keep expression composition enabled at runtime', () => {
  const sprite = new Sprite({
    meta: {
      sprite: { width: 8, height: 8 },
      parts: [mouthPart()],
      outline: [0, 0, 0],
    },
  });
  assert.deepEqual(sprite.capability, { blink: false, talk: true, skeletal: false, clips: [] });
  assert.equal(sprite.hasFace, true);

  const draws = [];
  sprite.canvas = { width: 8, height: 8 };
  sprite.spriteImg = { kind: 'sprite' };
  sprite.atlasImg = { kind: 'atlas' };
  sprite.faceRect = { x: 2, y: 3, w: 2, h: 4 };
  sprite.ctx = {
    clearRect() {},
    drawImage(...args) { draws.push(args); },
  };

  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    sprite.compose(1, 1.5);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

  assert.equal(draws.filter(args => args[0] === sprite.atlasImg).length, 2,
    'runtime must draw both the clean mouth patch and the resized mouth frame');
});

test('blink-only and full-face characters negotiate independent runtime capabilities', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const blinkOnly = composableSprite([eyePart()]);
    assert.deepEqual(blinkOnly.sprite.capability, { blink: true, talk: false, skeletal: false, clips: [] });
    assert.equal(blinkOnly.sprite.hasFace, true);
    blinkOnly.sprite.compose(0.6, 1.7);
    assert.equal(blinkOnly.draws.filter(args => args[0] === blinkOnly.sprite.atlasImg).length, 2,
      'blink-only runtime must draw the clean eye patch and blink frame');

    const full = composableSprite([eyePart(), mouthPart()]);
    assert.deepEqual(full.sprite.capability, { blink: true, talk: true, skeletal: false, clips: [] });
    full.sprite.compose(0.6, 1.5);
    assert.equal(full.draws.filter(args => args[0] === full.sprite.atlasImg).length, 4,
      'full runtime must compose eye and mouth independently in one frame');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('first-frame oracle reads the bounded final stage, not an opaque Sprite buffer', () => {
  let copiedStage = null;
  const probeContext = {
    clearRect() {},
    drawImage(stage) { copiedStage = stage; },
    getImageData() {
      return { data: new Uint8ClampedArray([0, 0, 0, copiedStage?.finalAlpha || 0]) };
    },
  };
  const probe = { width: 0, height: 0, getContext: () => probeContext };
  const stage = {
    width: 2048,
    height: 1024,
    finalAlpha: 0,
    spriteOffscreenAlpha: 255,
  };

  assert.equal(hasVisibleStagePixel(stage, probe), false,
    'an opaque offscreen Sprite must not acknowledge when final stage pixels are empty');
  assert.ok(probe.width * probe.height <= FIRST_FRAME_PROBE_MAX_PIXELS,
    'final-stage readback must stay within its fixed pixel budget');

  stage.finalAlpha = 255;
  assert.equal(hasVisibleStagePixel(stage, probe), true,
    'the same stage acknowledges only after an actual final pixel is visible');
});

test('render interval distribution is fixed-size, dev-only, and does not cap long frames', () => {
  assert.match(petScript,
    /const intervalDistribution = POPPET_DEV \? \{[\s\S]*?new Uint32Array\(INTERVAL_BUCKET_MAX_MS \+ 1\)/);
  assert.match(petScript, /const INTERVAL_BUCKET_MAX_MS = 250/);
  assert.match(petScript, /if \(intervalMs > frameMs \* 2\) intervalDistribution\.longFrameCount\+\+/,
    'long frames must use the strict greater-than-two-target-frames contract');
  assert.match(petScript, /else intervalDistribution\.overflowCount\+\+/,
    'intervals above the final 250ms bucket must remain explicit overflow');
  assert.match(petScript, /return null;[\s\S]*?const paceApi/,
    'a percentile in the open-ended overflow bucket must be unavailable, not clamped');
});

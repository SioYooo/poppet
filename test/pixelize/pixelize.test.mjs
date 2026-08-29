import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePixelizeOptions, pixelizeImage, pixelizeFrames } from '../../src/shared/pixelize.js';
import { buildCharacter } from '../../src/shared/pipeline.js';
import { makeCanonicalCharacter } from '../fixtures/canonical-character.mjs';
import {
  flatFrame,
  gradientSubject,
  tinySubject,
  wideSubject,
} from './fixtures.mjs';

const CLASSIC = Object.freeze({
  enabled: true,
  preset: 'classic',
  targetHeight: 64,
  paletteSize: 8,
  alphaThreshold: 160,
  cleanup: 'none',
});

function imageBytes(image) {
  return Array.from(image.data);
}

function opaqueColors(images) {
  const colors = new Set();
  for (const image of images) {
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] === 0) continue;
      colors.add(`${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`);
    }
  }
  return colors;
}

function assertHardAlpha(image) {
  for (let i = 3; i < image.data.length; i += 4) {
    assert.ok(image.data[i] === 0 || image.data[i] === 255,
      `alpha must be binary, received ${image.data[i]}`);
  }
}

function assertPixelizeMetadata(metadata, expected) {
  assert.ok(metadata && typeof metadata === 'object');
  assert.equal(metadata.enabled, expected.enabled);
  if (expected.enabled) {
    assert.equal(metadata.preset, expected.preset);
    assert.equal(metadata.targetHeight, expected.targetHeight);
    assert.equal(metadata.paletteSize, expected.paletteSize);
    assert.ok(typeof metadata.methodVersion === 'string' || Number.isSafeInteger(metadata.methodVersion));
    assert.ok(String(metadata.methodVersion).length > 0);
  }
}

test('pixelization is deterministic, truly low-resolution, palette-bounded and hard-alpha', () => {
  const source = gradientSubject();
  const original = imageBytes(source);
  const first = pixelizeImage(source, CLASSIC);
  const second = pixelizeImage(source, CLASSIC);

  assert.equal(first.image.height, 64);
  assert.equal(first.image.width, 48);
  assert.deepEqual(imageBytes(first.image), imageBytes(second.image));
  assert.deepEqual(first.palette, second.palette);
  assert.deepEqual(first.metadata, second.metadata);
  assert.ok(first.palette.length <= CLASSIC.paletteSize);
  assert.ok(opaqueColors([first.image]).size <= CLASSIC.paletteSize);
  assertHardAlpha(first.image);
  assert.equal(first.image.data[3], 0, 'transparent exterior must stay transparent');
  assert.deepEqual(imageBytes(source), original, 'pixelizeImage must not mutate its input');
  assert.notEqual(first.image.data, source.data);
  assertPixelizeMetadata(first.metadata, CLASSIC);
});

test('disabled pixelizer is an owned, byte-exact identity transform', () => {
  const source = gradientSubject(40, 52);
  const original = imageBytes(source);
  const result = pixelizeImage(source, {
    enabled: false,
    preset: 'tiny',
    targetHeight: 48,
    paletteSize: 8,
  });

  assert.equal(result.image.width, source.width);
  assert.equal(result.image.height, source.height);
  assert.deepEqual(imageBytes(result.image), original);
  assert.deepEqual(imageBytes(source), original);
  assert.notEqual(result.image, source);
  assert.notEqual(result.image.data, source.data);
  assertPixelizeMetadata(result.metadata, { enabled: false });
});

test('buildCharacter default and explicit pixelization-disabled paths stay byte-compatible', () => {
  const implicit = buildCharacter(makeCanonicalCharacter());
  const explicit = buildCharacter(makeCanonicalCharacter(), {
    pixelize: {
      enabled: false,
      preset: 'tiny',
      targetHeight: 48,
      paletteSize: 8,
    },
  });

  assert.equal(explicit.sprite.width, implicit.sprite.width);
  assert.equal(explicit.sprite.height, implicit.sprite.height);
  assert.deepEqual(imageBytes(explicit.sprite), imageBytes(implicit.sprite));
  assert.deepEqual(explicit.meta.sprite, implicit.meta.sprite);
  assert.deepEqual(explicit.meta.parts, implicit.meta.parts);
  assert.deepEqual(explicit.meta.palette, implicit.meta.palette);
});

test('enabled build pipeline persists reproducible additive pixelization metadata', () => {
  const result = buildCharacter(makeCanonicalCharacter(), {
    pixelize: {
      enabled: true,
      preset: 'tiny',
      targetHeight: 48,
      paletteSize: 8,
      alphaThreshold: 160,
      cleanup: 'none',
    },
  });

  assert.equal(result.meta.sprite.height, 48);
  assert.ok(result.meta.sprite.width > 0);
  assert.ok(result.meta.palette.length <= 8);
  assertHardAlpha(result.sprite);
  assertPixelizeMetadata(result.meta.source.pixelize, {
    enabled: true,
    preset: 'tiny',
    targetHeight: 48,
    paletteSize: 8,
  });
});

test('multiple frames use one bounded shared palette and remain deterministic', () => {
  const frames = [
    flatFrame([180, 30, 40]),
    flatFrame([30, 70, 190]),
    flatFrame([40, 170, 80]),
  ];
  const snapshots = frames.map(imageBytes);
  const options = { ...CLASSIC, targetHeight: 32, paletteSize: 2 };
  const first = pixelizeFrames(frames, options);
  const second = pixelizeFrames(frames, options);

  assert.equal(first.images.length, frames.length);
  assert.equal(first.palette.length, 2);
  assert.ok(opaqueColors(first.images).size <= 2,
    'the union across every frame, not each frame independently, must obey the palette bound');
  assert.deepEqual(first.images.map(imageBytes), second.images.map(imageBytes));
  assert.deepEqual(first.palette, second.palette);
  first.images.forEach((image) => {
    assert.equal(image.height, 32);
    assertHardAlpha(image);
  });
  frames.forEach((frame, index) => assert.deepEqual(imageBytes(frame), snapshots[index]));
});

test('very small, no-face and extreme-aspect inputs degrade safely', () => {
  const tiny = pixelizeImage(tinySubject(), CLASSIC).image;
  assert.ok(tiny.width >= 1 && tiny.height >= 1);
  assert.ok(tiny.width <= 3 && tiny.height <= 4, 'pixelization must not invent an upscale for tiny inputs');
  assertHardAlpha(tiny);

  const noFace = pixelizeImage(makeCanonicalCharacter({ withFace: false }), CLASSIC).image;
  assert.ok(noFace.width > 0 && noFace.height > 0);
  assertHardAlpha(noFace);

  const wide = pixelizeImage(wideSubject(), CLASSIC).image;
  assert.ok(wide.width > wide.height * 8, 'extreme aspect ratio must be preserved');
  assert.ok(wide.width > 0 && wide.height > 0);
  assertHardAlpha(wide);
});

test('pixelization rejects invalid options and bounded-work violations', () => {
  const source = gradientSubject();
  assert.equal(normalizePixelizeOptions({ enabled: true }).preset, 'classic',
    'enabled pixelization without a named preset must not silently turn itself off');
  assert.throws(() => normalizePixelizeOptions({ enabled: true, preset: 'original' }), /矛盾|original/i);
  assert.throws(() => normalizePixelizeOptions({ preset: 'detailed' }), /未知|preset/i);
  assert.throws(() => pixelizeImage(source, { ...CLASSIC, targetHeight: 0 }), /target|height|尺寸|高度/i);
  assert.throws(() => pixelizeImage(source, { ...CLASSIC, paletteSize: 0 }), /palette|调色板/i);
  assert.throws(() => pixelizeImage(source, { ...CLASSIC, maxWorkingPixels: 100 }),
    error => error?.code === 'POPPET_RESOURCE_LIMIT');

  const frames = [flatFrame([10, 20, 30]), flatFrame([40, 50, 60]), flatFrame([70, 80, 90])];
  assert.throws(() => pixelizeFrames(frames, { ...CLASSIC, maxFrames: 2 }),
    error => error?.code === 'POPPET_RESOURCE_LIMIT');
});

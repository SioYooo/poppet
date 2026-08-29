'use strict';

// 动画片段在导入边界必须 fail-closed。运行时（src/shared/parts.js）对非法条目是
// 静默丢弃，那是热路径上的正确选择；但越界区间会让渲染器去取一条不存在的帧，
// 所以它绝不能通过这道边界。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const security = require('../../src/main/security');

const metaWith = (frames) => ({
  schemaVersion: 2,
  sprite: { width: 16, height: 16 },
  frames,
  atlas: null,
  parts: [],
  suggestions: [],
  footY: 15,
  outline: [0, 0, 0],
  palette: [[0, 0, 0]],
  rig: { motion: 'walk', anchor: 'feet', flip: true, swayFrom: 0.5 },
  source: {
    cropBBox: [0, 0, 15, 15],
    backgroundMode: 'alpha',
    originalSize: { width: 16, height: 16 },
    extraction: { contractVersion: 1, extractor: 'local-edge-v1', status: 'ready', mode: 'alpha' },
    pixelize: {
      enabled: false, preset: 'original', targetHeight: null, paletteSize: null,
      methodVersion: 'local-box-median-cut-v1', width: 16, height: 16, colors: 1,
      // 管线对多帧素材统一调色板，校验器要求两者一致
      sharedPalette: !!(frames && frames.count > 1),
    },
  },
});

// 两道边界都要拦：strict 是导入/保存的完整校验，runtime 是加载已存角色时的校验。
const strict = (frames) => () => security.validateCharacterMeta(metaWith(frames));
const runtime = (frames) => () => security.validateRuntimeCharacterMeta(metaWith(frames));
const both = (frames) => [strict(frames), runtime(frames)];

test('合法片段通过运行时校验', () => {
  for (const good of [
    { count: 20, fps: 12, clips: { idle: [0, 3], walk: [4, 11], greet: [12, 19] } },
    { count: 4, fps: 10, clips: { idle: [0, 0] } },
    { count: 4, fps: 10 },
    { count: 4, fps: 10, clips: null },
  ]) for (const check of both(good)) assert.doesNotThrow(check);
});

test('越界与倒置的区间在两道边界都被拒绝', () => {
  for (const bad of [
    { count: 4, fps: 10, clips: { idle: [0, 4] } },
    { count: 4, fps: 10, clips: { idle: [-1, 2] } },
    { count: 8, fps: 10, clips: { walk: [5, 2] } },
    { count: 8, fps: 10, clips: { walk: [1.5, 3] } },
  ]) for (const check of both(bad)) assert.throws(check, /区间无效/);
});

test('未知片段名与畸形形状在两道边界都被拒绝', () => {
  for (const check of both({ count: 8, fps: 10, clips: { dance: [0, 1] } })) assert.throws(check, /未知片段/);
  for (const check of both({ count: 8, fps: 10, clips: {} })) assert.throws(check, /空表/);
  for (const check of both({ count: 8, fps: 10, clips: { idle: [0] } })) assert.throws(check, /\[start, end\]/);
  for (const check of both({ count: 8, fps: 10, clips: [[0, 1]] })) assert.throws(check, /metadata\.frames\.clips/);
  for (const check of both({ count: 8, fps: 10, clips: 'idle' })) assert.throws(check, /metadata\.frames\.clips/);
});

test('frames 仍然拒绝未登记的字段', () => {
  assert.throws(strict({ count: 8, fps: 10, loop: true }), /不允许的字段/);
});

test('单帧素材不接受片段：分段是多帧素材专属', () => {
  // 产品口径：卖的角色包用多帧动画驱动手脚，用户自己上传的单张像素图走不到这条路。
  for (const check of both({ count: 1, fps: 10, clips: { idle: [0, 0] } })) {
    assert.throws(check, /frames\.count 无效/);
  }
});

// 主进程是 CommonJS、shared/ 是 ESM，跨不过去，所以 CLIP_NAMES 在两处各存一份。
// 这条断言是防止它们漂移的唯一机制。
test('security 与 shared/parts 的片段词汇一致', async () => {
  const parts = await import(require('node:url').pathToFileURL(
    path.join(__dirname, '../../src/shared/parts.js')).href);
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/security.js'), 'utf8');
  const match = /const CLIP_NAMES = Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(match, 'security.js 必须以 Object.freeze 的字面量声明 CLIP_NAMES');
  const declared = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(declared, [...parts.CLIP_NAMES],
    'src/main/security.js 与 src/shared/parts.js 的 CLIP_NAMES 必须完全一致');
});

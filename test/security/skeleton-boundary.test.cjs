'use strict';

// 关节骨架在导入边界的 fail-closed 行为。
//
// 这里守的是一条不对称：src/shared/skeleton.js 遇到坏骨架静默返回 null（渲染热路径
// 上抛异常只会把一个已被拒绝的形状变成崩溃），所以**边界必须严于运行时**。
// 边界一旦漏过一份运行时读不懂的素材，它就会落盘，此后每次加载都退化成一张静态
// 立绘，而用户看到的只是"我的角色不动了"，没有任何解释。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const security = require('../../src/main/security');

const baseMeta = () => ({
  schemaVersion: 3,
  sprite: { width: 64, height: 96 },
  frames: null,
  atlas: { width: 128, height: 64 },
  parts: [],
  suggestions: [],
  footY: 95,
  outline: [0, 0, 0],
  palette: [[0, 0, 0]],
  rig: { motion: 'walk', anchor: 'feet', flip: true, swayFrom: 0.5 },
  source: {
    cropBBox: [0, 0, 63, 95],
    backgroundMode: 'alpha',
    originalSize: { width: 64, height: 96 },
    extraction: { contractVersion: 1, extractor: 'local-edge-v1', status: 'ready', mode: 'alpha' },
    pixelize: {
      enabled: false, preset: 'original', targetHeight: null, paletteSize: null,
      methodVersion: 'local-box-median-cut-v1', width: 64, height: 96, colors: 1,
      sharedPalette: false,
    },
  },
  skeleton: {
    angleStep: 15,
    bones: [
      { id: 'torso', parent: null, pivot: { x: 8, y: 20 }, anchor: { x: 32, y: 48 },
        z: 10, frame: { sx: 0, sy: 0, sw: 16, sh: 24 }, drivers: { breathe: 1 }, limit: null },
      { id: 'armL', parent: 'torso', pivot: { x: 2, y: 1 }, anchor: { x: 4, y: -8 },
        z: 20, frame: { sx: 20, sy: 0, sw: 6, sh: 14 },
        drivers: { walkSwing: 1, wave: 1 }, limit: [-90, 90] },
      { id: 'legL', parent: 'torso', pivot: { x: 3, y: 1 }, anchor: { x: -4, y: 20 },
        z: 5, frame: { sx: 30, sy: 0, sw: 7, sh: 20 },
        drivers: { walkSwing: -1, dangle: 1 }, limit: null },
    ],
  },
});

// 改一根骨头 / 一个顶层字段，其余保持合法
const mutate = (fn) => { const m = baseMeta(); fn(m); return m; };
const bone = (m, i) => m.skeleton.bones[i];

test('合法的 v3 骨架角色被接受', () => {
  const out = security.validateCharacterMeta(baseMeta());
  assert.equal(out.schemaVersion, 3);
  assert.equal(out.skeleton.bones.length, 3);
  assert.equal(out.skeleton.angleStep, 15);
});

test('版本号与 skeleton 互为充要条件', () => {
  assert.throws(() => security.validateCharacterMeta(mutate(m => { m.schemaVersion = 2; })),
    /schemaVersion 必须是 3/);
  assert.throws(() => security.validateCharacterMeta(mutate(m => { delete m.skeleton; })),
    /必须带 skeleton/);
  assert.throws(() => security.validateCharacterMeta(mutate(m => { m.schemaVersion = 4; })),
    /schemaVersion 必须是 2 或 3/);
});

test('骨架不能与多帧帧带同时存在', () => {
  // 两套动作会互相打架：程序化摆臂叠在已经画好的走路姿势上。
  // 运行时的 isSkeletal() 遇到这种素材会静默忽略骨架，作者永远不会知道，
  // 所以必须在边界当场拒绝。
  assert.throws(() => security.validateCharacterMeta(mutate(m => {
    m.frames = { count: 8, fps: 10, clips: { idle: [0, 3] } };
  })), /不能与多帧帧带同时存在/);
});

test('顶层形状 fail-closed', () => {
  const bad = [
    [m => { m.skeleton.angleStep = 0; }, /angleStep 无效/],
    [m => { m.skeleton.angleStep = 91; }, /angleStep 无效/],
    [m => { m.skeleton.angleStep = 7.5; }, /angleStep 无效/],
    [m => { m.skeleton.bones = []; }, /不能为空/],
    [m => { m.skeleton.bones = {}; }, /必须是数组/],
    [m => { m.skeleton.fps = 10; }, /不允许的字段/],
    [m => { m.atlas = null; }, /需要部件图集/],
  ];
  for (const [fn, re] of bad) {
    assert.throws(() => security.validateCharacterMeta(mutate(fn)), re);
  }
});

test('单根骨头的字段 fail-closed', () => {
  const bad = [
    [m => { bone(m, 1).id = '.bad'; }, /id 无效或重复/],
    [m => { bone(m, 1).id = 'torso'; }, /id 无效或重复/],
    [m => { bone(m, 1).parent = 'ghost'; }, /引用了不存在的父骨骼/],
    [m => { bone(m, 1).z = 1.5; }, /z 无效/],
    [m => { bone(m, 1).z = 99999; }, /z 无效/],
    [m => { bone(m, 1).pivot = { x: 0 }; }, /pivot 无效/],
    [m => { bone(m, 1).pivot = { x: 0, y: 0, z: 0 }; }, /不允许的字段/],
    [m => { bone(m, 1).pivot = { x: 999, y: 0 }; }, /pivot 必须落在部件画面内/],
    [m => { bone(m, 1).frame.sw = 0; }, /frame 超出图集范围/],
    [m => { bone(m, 1).frame.sx = 126; }, /frame 超出图集范围/],
    [m => { bone(m, 1).frame.sy = 60; }, /frame 超出图集范围/],
    [m => { bone(m, 1).nickname = 'x'; }, /不允许的字段/],
    [m => { bone(m, 1).drivers = { moonwalk: 1 }; }, /未知驱动器/],
    [m => { bone(m, 1).drivers = { wave: 9 }; }, /drivers\.wave 无效/],
    [m => { bone(m, 1).drivers = { wave: '1' }; }, /drivers\.wave 无效/],
    [m => { bone(m, 1).limit = [10, -10]; }, /limit 无效/],
    [m => { bone(m, 1).limit = [-999, 999]; }, /limit 无效/],
    [m => { bone(m, 1).limit = [0]; }, /limit 无效/],
  ];
  for (const [fn, re] of bad) {
    assert.throws(() => security.validateCharacterMeta(mutate(fn)), re);
  }
});

test('拓扑 fail-closed：单根、无环、深度有界', () => {
  assert.throws(() => security.validateCharacterMeta(mutate(m => { bone(m, 1).parent = null; })),
    /必须恰好有一个根骨骼/);
  assert.throws(() => security.validateCharacterMeta(mutate(m => { bone(m, 0).parent = 'armL'; })),
    /必须恰好有一个根骨骼/);

  // 环若漏进渲染器就是无限循环。这里必须拦死，不能指望绘制循环的上限兜底。
  const cyc = baseMeta();
  cyc.skeleton.bones = [
    { id: 'a', parent: 'c', pivot: { x: 0, y: 0 }, anchor: { x: 0, y: 0 }, z: 0,
      frame: { sx: 0, sy: 0, sw: 4, sh: 4 } },
    { id: 'b', parent: 'a', pivot: { x: 0, y: 0 }, anchor: { x: 0, y: 0 }, z: 1,
      frame: { sx: 0, sy: 0, sw: 4, sh: 4 } },
    { id: 'c', parent: 'b', pivot: { x: 0, y: 0 }, anchor: { x: 0, y: 0 }, z: 2,
      frame: { sx: 0, sy: 0, sw: 4, sh: 4 } },
  ];
  assert.throws(() => security.validateCharacterMeta(cyc), /必须恰好有一个根骨骼/);

  const deep = baseMeta();
  deep.skeleton.bones = Array.from({ length: 11 }, (_, i) => ({
    id: 'n' + i, parent: i === 0 ? null : 'n' + (i - 1),
    pivot: { x: 0, y: 0 }, anchor: { x: 0, y: 0 }, z: i,
    frame: { sx: 0, sy: 0, sw: 4, sh: 4 },
  }));
  assert.throws(() => security.validateCharacterMeta(deep), /层级过深或存在环/);

  const many = baseMeta();
  many.skeleton.bones = Array.from({ length: 65 }, (_, i) => ({
    id: 'n' + i, parent: i === 0 ? null : 'n0',
    pivot: { x: 0, y: 0 }, anchor: { x: 0, y: 0 }, z: i,
    frame: { sx: 0, sy: 0, sw: 4, sh: 4 },
  }));
  assert.throws(() => security.validateCharacterMeta(many), /数量超出允许范围/);
});

test('读盘的宽松路径同样拦住坏骨架', () => {
  // library.js 读磁盘走 validateRuntimeCharacterMeta，它没有顶层 assertExactKeys
  // （旧角色不能因为边界升级而全部失效），所以一个未知的 skeleton 字段本来会
  // 原样活到渲染器。这条断言守的就是那个缺口。
  assert.doesNotThrow(() => security.validateRuntimeCharacterMeta(baseMeta()));
  assert.throws(() => security.validateRuntimeCharacterMeta(mutate(m => {
    bone(m, 1).drivers = { moonwalk: 1 };
  })), /未知驱动器/);
  assert.throws(() => security.validateRuntimeCharacterMeta(mutate(m => {
    bone(m, 1).parent = 'ghost';
  })), /引用了不存在的父骨骼/);
  assert.throws(() => security.validateRuntimeCharacterMeta(mutate(m => {
    m.frames = { count: 4, fps: 10 };
  })), /不能与多帧帧带同时存在/);
});

// 主进程是 CommonJS、shared/ 是 ESM，跨不过去，所以驱动器词汇在两处各存一份。
// 这条断言是防止它们漂移的唯一机制——照 frame-clips.test.cjs 的先例。
test('security 与 shared/skeleton 的驱动器词汇一致', async () => {
  const skeleton = await import(pathToFileURL(
    path.join(__dirname, '../../src/shared/skeleton.js')).href);
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/security.js'), 'utf8');
  const match = /const DRIVER_NAMES = Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(match, 'security.js 必须以 Object.freeze 的字面量声明 DRIVER_NAMES');
  const declared = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(declared, [...skeleton.DRIVER_NAMES],
    'src/main/security.js 与 src/shared/skeleton.js 的 DRIVER_NAMES 必须完全一致');
});

test('表情替换帧 fail-closed', () => {
  const withExpr = (expr) => mutate(m => { bone(m, 0).expr = expr; });
  // 合法：与基础帧 16x24 同尺寸，且落在 128x64 的图集内
  assert.doesNotThrow(() => security.validateCharacterMeta(
    withExpr({ blink: { sx: 40, sy: 0, sw: 16, sh: 24 } })));
  assert.doesNotThrow(() => security.validateCharacterMeta(
    withExpr({ blink: { sx: 40, sy: 0, sw: 16, sh: 24 },
      talk: { sx: 60, sy: 0, sw: 16, sh: 24 } })));

  const bad = [
    ['未知表情键', { wink: { sx: 40, sy: 0, sw: 16, sh: 24 } }, /不允许的字段/],
    ['尺寸不一致', { blink: { sx: 40, sy: 0, sw: 15, sh: 24 } }, /必须与基础帧同尺寸/],
    ['超出图集', { blink: { sx: 120, sy: 0, sw: 16, sh: 24 } }, /超出图集范围/],
    ['缺字段', { blink: { sx: 40, sy: 0, sw: 16 } }, /expr\.blink 无效/],
    ['宽高为零', { blink: { sx: 40, sy: 0, sw: 0, sh: 24 } }, /expr\.blink 无效/],
    ['多字段', { blink: { sx: 40, sy: 0, sw: 16, sh: 24, k: 1 } }, /不允许的字段/],
  ];
  for (const [label, expr, re] of bad) {
    assert.throws(() => security.validateCharacterMeta(withExpr(expr)), re, label);
  }
});

test('security 与 shared/skeleton 的表情词汇一致', async () => {
  const skeleton = await import(pathToFileURL(
    path.join(__dirname, '../../src/shared/skeleton.js')).href);
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/security.js'), 'utf8');
  const match = /const EXPR_KEYS = Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(match, 'security.js 必须以 Object.freeze 的字面量声明 EXPR_KEYS');
  const declared = match[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(declared, [...skeleton.EXPR_KEYS],
    'src/main/security.js 与 src/shared/skeleton.js 的 EXPR_KEYS 必须完全一致');
});

test('security 与 shared/skeleton 的结构上限一致', async () => {
  // 边界比运行时宽，就会让一份运行时读不懂的素材落到磁盘上。
  const skeleton = await import(pathToFileURL(
    path.join(__dirname, '../../src/shared/skeleton.js')).href);
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/security.js'), 'utf8');
  const read = (name) => {
    const m = new RegExp(name + ':\\s*(\\d+)').exec(source);
    assert.ok(m, `security.js 必须声明 SKELETON_LIMITS.${name}`);
    return Number(m[1]);
  };
  assert.equal(read('MAX_BONES'), skeleton.MAX_BONES);
  assert.equal(read('MAX_DEPTH'), skeleton.MAX_DEPTH);
  assert.equal(read('MIN_ANGLE_STEP'), skeleton.MIN_ANGLE_STEP);
  assert.equal(read('MAX_ANGLE_STEP'), skeleton.MAX_ANGLE_STEP);
});

test('每个驱动器都有 brain 里的产出方', async () => {
  // 和 sprite-clips 里"片段名必须对应 brain 状态名"同一条规矩：
  // 没有产出方的驱动器就是一个永远为 0 的字段，作者会以为自己写错了骨架。
  const skeleton = await import(pathToFileURL(
    path.join(__dirname, '../../src/shared/skeleton.js')).href);
  const brain = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/pet/brain.js'), 'utf8');
  for (const name of skeleton.DRIVER_NAMES) {
    assert.ok(new RegExp('signals\\.' + name + '\\s*=').test(brain),
      `brain.js 必须给 signals.${name} 赋值，否则这个驱动器永远是 0`);
  }
});

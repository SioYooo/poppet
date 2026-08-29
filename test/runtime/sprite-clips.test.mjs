// 帧带分段的播放行为。Sprite 的构造与 tick/setClip 都不碰 canvas，所以可以直接在
// node 里驱动；这里断言的是"哪一帧被选中"，不是它被画成什么样。
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import { Sprite } from '../../src/renderer/pet/sprite.js';
import { CLIP_NAMES } from '../../src/shared/parts.js';

function make(frames) {
  return new Sprite({
    meta: {
      sprite: { width: 8, height: 8 },
      frames,
      parts: [],
      outline: [0, 0, 0],
    },
  });
}

const CLIPPED = { count: 20, fps: 10, clips: { idle: [0, 3], walk: [4, 11], greet: [12, 19] } };

// fps 10 -> 每 0.1s 一帧；推进 n 帧
function advance(sprite, n) {
  for (let i = 0; i < n; i += 1) sprite.tick(0.1);
}

test('未分段的多帧素材仍然整条循环', () => {
  const s = make({ count: 4, fps: 10 });
  assert.deepEqual(s.clipRange, [0, 3]);
  advance(s, 3);
  assert.equal(s.frameIndex, 3);
  advance(s, 1);
  assert.equal(s.frameIndex, 0, '整条帧带首尾相接');
});

test('单帧素材完全不进入帧逻辑', () => {
  const s = make(null);
  assert.equal(s.clipRange, null);
  s.setClip('walk');
  advance(s, 5);
  assert.equal(s.frameIndex, 0);
});

test('状态切段后从段首起播，并只在段内循环', () => {
  const s = make(CLIPPED);
  assert.deepEqual(s.clipRange, [0, 3], '构造时落在待机段');
  s.setClip('walk');
  assert.deepEqual(s.clipRange, [4, 11]);
  assert.equal(s.frameIndex, 4, '切段从段首起播');
  advance(s, 7);
  assert.equal(s.frameIndex, 11, '走到段尾');
  advance(s, 1);
  assert.equal(s.frameIndex, 4, '回到段首而不是越进下一段');
});

test('没有对应片段的状态回落到待机段', () => {
  const s = make(CLIPPED);
  s.setClip('hop');
  assert.deepEqual(s.clipRange, [0, 3]);
  s.setClip('greet');
  assert.deepEqual(s.clipRange, [12, 19]);
  assert.equal(s.frameIndex, 12);
});

test('同名状态重复设置不重置相位', () => {
  const s = make(CLIPPED);
  s.setClip('walk');
  advance(s, 3);
  assert.equal(s.frameIndex, 7);
  s.setClip('walk');
  assert.equal(s.frameIndex, 7, '每帧都会调用 setClip，重置相位会让动画永远停在段首');
});

test('回落到同一区间的两个状态之间切换也不重置相位', () => {
  const s = make(CLIPPED);
  s.setClip('hop');      // -> idle 段
  advance(s, 2);
  assert.equal(s.frameIndex, 2);
  s.setClip('shake');    // 同样回落到 idle 段
  assert.equal(s.frameIndex, 2, '区间没变就不该重新起播');
});

test('索引落在区间外时被拉回段首', () => {
  const s = make(CLIPPED);
  s.setClip('walk');
  s.frameIndex = 19;               // 模拟外部把索引改坏
  s.tick(0.1);
  assert.ok(s.frameIndex >= 4 && s.frameIndex <= 11, `越界索引必须回到段内，实际 ${s.frameIndex}`);
});

test('片段名与 brain 状态名一一对应', () => {
  const petSource = new URL('../../src/renderer/pet/pet.js', import.meta.url);
  const brainSource = new URL('../../src/renderer/pet/brain.js', import.meta.url);
  const brain = fs.readFileSync(brainSource, 'utf8');
  const pet = fs.readFileSync(petSource, 'utf8');
  assert.match(pet, /setClip\(brain\.state\)/, 'pet 必须直接用 brain 的状态名选段');
  for (const name of CLIP_NAMES) {
    assert.ok(
      brain.includes(`case '${name}'`) || brain.includes(`'${name}'`),
      `CLIP_NAMES 里的 ${name} 必须是 brain 真实存在的状态`,
    );
  }
});

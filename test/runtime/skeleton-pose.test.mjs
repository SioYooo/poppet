// 骨架角色的运行时契约：信号 -> 关节档位 -> 世界变换 -> 跳帧键。
//
// 这里守三件事：
//  1) 招手真的把手臂举过水平线（"举过水平"需要超过 90 度的旋转，很容易写成
//     手臂横着抽过身体前面，而那看起来像在扇人）；
//  2) 极端姿势不会把肢体甩出画布（作者必须给画布留余量，这条断言把它变成可测的）；
//  3) 量化后的档位串是离散的，render-policy 的跳帧对骨架角色同样成立。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeSkeleton, resolvePose, boneTransforms, poseKey, DRIVERS,
} from '../../src/shared/skeleton.js';
import { poseDrawKey } from '../../src/renderer/pet/render-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const W = 128, H = 128;
// 与 tools/make-rig-demo.mjs 的左臂链同构：肩在躯干右上，前臂与手依次向下接。
const armRig = normalizeSkeleton({
  angleStep: 15,
  bones: [
    { id: 'torso', parent: null, pivot: { x: 12, y: 32 }, anchor: { x: 64, y: 79 },
      z: 12, frame: { sx: 0, sy: 0, sw: 24, sh: 32 }, drivers: { breathe: 1 } },
    { id: 'upperArmL', parent: 'torso', pivot: { x: 4, y: 3 }, anchor: { x: 13, y: -27 },
      z: 20, frame: { sx: 30, sy: 0, sw: 8, sh: 18 },
      drivers: { wave: -2, walkSwing: -0.5 }, limit: [-150, 60] },
    { id: 'forearmL', parent: 'upperArmL', pivot: { x: 3, y: 2 }, anchor: { x: 0, y: 15 },
      z: 20, frame: { sx: 40, sy: 0, sw: 7, sh: 15 }, drivers: { wave: -0.5 } },
    { id: 'handL', parent: 'forearmL', pivot: { x: 3, y: 1 }, anchor: { x: 0, y: 13 },
      z: 20, frame: { sx: 50, sy: 0, sw: 7, sh: 7 }, drivers: { wave: 0.4 } },
  ],
});

const zero = { walkSwing: 0, breathe: 0, dangle: 0, impact: 0, wave: 0 };

test('静止时手臂垂在身侧', () => {
  const nodes = boneTransforms(armRig, resolvePose(armRig, zero));
  const shoulder = nodes.get('upperArmL');
  const hand = nodes.get('handL');
  assert.equal(shoulder.angle, 0);
  assert.equal(hand.x, shoulder.x, '不转动时整条手臂共用一条竖直线');
  assert.ok(hand.y > shoulder.y, '手在肩下方');
});

test('招手把手臂举过水平线', () => {
  const nodes = boneTransforms(armRig, resolvePose(armRig, { ...zero, wave: 1 }));
  const shoulder = nodes.get('upperArmL');
  const hand = nodes.get('handL');
  // 举过水平线需要 |角度| > 90 度：小于 90 度只是把手臂横着甩过身前。
  assert.ok(Math.abs(shoulder.angle) > 90,
    `肩角 ${shoulder.angle} 度不足以把手臂举过水平线`);
  assert.ok(hand.y < shoulder.y, '手必须落到肩膀上方');
  assert.ok(hand.x > shoulder.x, '手向外侧举起，而不是横过身体');
});

test('极端姿势仍留在画布内', () => {
  // 画布余量不是玄学：抬臂会画到绑定姿势包围盒之外，作者必须留出来。
  // 这条断言把那条美术约束变成可测的。
  for (const wave of [0, 0.5, 1]) {
    const nodes = boneTransforms(armRig, resolvePose(armRig, { ...zero, wave }));
    for (const [id, node] of nodes) {
      assert.ok(node.x >= 0 && node.x <= W, `${id} 在 wave=${wave} 时横向出界: ${node.x}`);
      assert.ok(node.y >= 0 && node.y <= H, `${id} 在 wave=${wave} 时纵向出界: ${node.y}`);
    }
  }
});

test('左右反相靠增益的符号，不靠运行时认解剖', () => {
  const mirrored = normalizeSkeleton({
    angleStep: 15,
    bones: [
      { id: 'root', parent: null, pivot: { x: 0, y: 0 }, anchor: { x: 64, y: 80 },
        z: 0, frame: { sx: 0, sy: 0, sw: 4, sh: 4 } },
      { id: 'legL', parent: 'root', pivot: { x: 0, y: 0 }, anchor: { x: 5, y: 0 },
        z: 1, frame: { sx: 0, sy: 0, sw: 4, sh: 4 }, drivers: { walkSwing: 1 } },
      { id: 'legR', parent: 'root', pivot: { x: 0, y: 0 }, anchor: { x: -5, y: 0 },
        z: 1, frame: { sx: 0, sy: 0, sw: 4, sh: 4 }, drivers: { walkSwing: -1 } },
    ],
  });
  const pose = resolvePose(mirrored, { ...zero, walkSwing: 1 });
  assert.equal(pose.get('legL'), -pose.get('legR'));
  assert.notEqual(pose.get('legL'), 0);
});

test('档位串离散：亚阈值抖动不产生新的绘制键', () => {
  const base = {
    charId: 'demo', canvasWidth: 400, canvasHeight: 400, drawScale: 1, facing: 1,
    pose: { scaleX: 1, scaleY: 1, rotate: 0, offsetX: 0, offsetY: 0, sway: 0 },
    spriteWidth: W, spriteHeight: H,
  };
  const keyFor = (signals) => poseDrawKey({
    ...base, frameKey: 'b' + poseKey(armRig, resolvePose(armRig, { ...zero, ...signals })),
  });
  assert.equal(keyFor({ wave: 1 }), keyFor({ wave: 0.99 }),
    '同一档位必须得到同一个键，否则跳帧机制对骨架角色失效');
  assert.notEqual(keyFor({ wave: 0 }), keyFor({ wave: 1 }),
    '肉眼可见的姿势变化必须换键');
});

test('每个驱动器都被演示角色用到（否则示例教不会作者怎么写）', () => {
  const source = readFileSync(path.join(ROOT, 'tools/make-rig-demo.mjs'), 'utf8');
  for (const name of Object.keys(DRIVERS)) {
    assert.ok(new RegExp(name + '\\s*:').test(source),
      `tools/make-rig-demo.mjs 应当演示 ${name} 驱动器`);
  }
});

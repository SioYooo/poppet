// 关节骨架的回归测试。
// 这里守的是「坏骨架必须整份被拒」——半份骨架的后果比没有骨架糟得多：
// 父引用悬空的手臂会连着空气飘，而角色照常加载、照常走动，不报任何错。
import {
  normalizeSkeleton, drawOrder, resolvePose, poseKey, boneTransforms,
  skeletonOf, isSkeletal, frameFor, exprKey, expressionsOf,
  DRIVERS, DRIVER_NAMES, EXPR_KEYS, MAX_BONES, MAX_DEPTH,
} from '../src/shared/skeleton.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log(`  ✗ ${name}\n      期望 ${w}\n      实际 ${g}`); }
}

const rect = (sx = 0, sy = 0) => ({ sx, sy, sw: 20, sh: 40 });
const bone = (id, parent, extra = {}) => ({
  id, parent, pivot: { x: 8, y: 4 }, anchor: { x: 12, y: -40 }, z: 0, frame: rect(), ...extra,
});

// 一具最小人形：躯干 -> 上臂 -> 前臂，外加一条反相的腿。
const humanoid = {
  angleStep: 15,
  bones: [
    { id: 'torso', parent: null, pivot: { x: 46, y: 120 }, anchor: { x: 95, y: 200 },
      z: 10, frame: rect(0, 0), drivers: { breathe: 1 } },
    { id: 'upperArmL', parent: 'torso', pivot: { x: 8, y: 4 }, anchor: { x: 12, y: -40 },
      z: 20, frame: rect(100, 0), drivers: { walkSwing: 1 } },
    { id: 'forearmL', parent: 'upperArmL', pivot: { x: 7, y: 3 }, anchor: { x: 2, y: 30 },
      z: 21, frame: rect(130, 0), drivers: { walkSwing: 0.5 }, limit: [-10, 10] },
    { id: 'thighL', parent: 'torso', pivot: { x: 9, y: 3 }, anchor: { x: -14, y: 60 },
      z: 5, frame: rect(160, 0), drivers: { walkSwing: -1 } },
  ],
};

console.log('\n— 整份接受 / 整份拒绝 —');
check('合法人形被接受', normalizeSkeleton(humanoid).bones.map(b => b.id),
  ['torso', 'upperArmL', 'forearmL', 'thighL']);
check('非对象一律 null', [normalizeSkeleton(null), normalizeSkeleton([]), normalizeSkeleton('x')],
  [null, null, null]);
check('缺 angleStep', normalizeSkeleton({ bones: humanoid.bones }), null);
check('angleStep 非整数', normalizeSkeleton({ ...humanoid, angleStep: 7.5 }), null);
check('angleStep 越界', [normalizeSkeleton({ ...humanoid, angleStep: 0 }),
  normalizeSkeleton({ ...humanoid, angleStep: 91 })], [null, null]);
check('空骨骼表', normalizeSkeleton({ angleStep: 15, bones: [] }), null);
check('骨骼数超上限', normalizeSkeleton({
  angleStep: 15,
  bones: Array.from({ length: MAX_BONES + 1 }, (_, i) => bone('b' + i, i ? 'b0' : null)),
}), null);

console.log('\n— 一根坏骨头拒掉整份，而不是丢掉那一根 —');
check('id 重复', normalizeSkeleton({ angleStep: 15,
  bones: [bone('a', null), bone('a', 'a')] }), null);
check('id 形状非法', normalizeSkeleton({ angleStep: 15,
  bones: [bone('.bad', null)] }), null);
check('父引用悬空', normalizeSkeleton({ angleStep: 15,
  bones: [bone('a', null), bone('b', 'ghost')] }), null);
check('缺 pivot', normalizeSkeleton({ angleStep: 15,
  bones: [{ ...bone('a', null), pivot: undefined }] }), null);
check('pivot 非整数', normalizeSkeleton({ angleStep: 15,
  bones: [{ ...bone('a', null), pivot: { x: 1.5, y: 0 } }] }), null);
check('缺 z', normalizeSkeleton({ angleStep: 15,
  bones: [{ ...bone('a', null), z: undefined }] }), null);
check('frame 宽高为零', normalizeSkeleton({ angleStep: 15,
  bones: [{ ...bone('a', null), frame: { sx: 0, sy: 0, sw: 0, sh: 4 } }] }), null);

console.log('\n— 拓扑 —');
check('零个根', normalizeSkeleton({ angleStep: 15,
  bones: [bone('a', 'b'), bone('b', 'a')] }), null);
check('两个根', normalizeSkeleton({ angleStep: 15,
  bones: [bone('a', null), bone('b', null)] }), null);
check('环（父链绕回自己）', normalizeSkeleton({ angleStep: 15,
  bones: [bone('root', null), bone('a', 'b'), bone('b', 'c'), bone('c', 'a')] }), null);
{
  // 一条恰好超深的链：root + MAX_DEPTH 节 = 最深一节的深度为 MAX_DEPTH+1
  const chain = [bone('n0', null)];
  for (let i = 1; i <= MAX_DEPTH + 1; i++) chain.push(bone('n' + i, 'n' + (i - 1)));
  check('层级超深', normalizeSkeleton({ angleStep: 15, bones: chain }), null);
  check('层级恰好到顶被接受',
    normalizeSkeleton({ angleStep: 15, bones: chain.slice(0, MAX_DEPTH + 1) }) !== null, true);
}

console.log('\n— 驱动器是封闭集 —');
const driversOf = (raw) => normalizeSkeleton({ angleStep: 15,
  bones: [{ ...bone('a', null), drivers: raw }] }).bones[0].drivers;
check('已登记的驱动器保留', driversOf({ walkSwing: 1, breathe: -0.5 }),
  { walkSwing: 1, breathe: -0.5 });
check('未知驱动器被丢掉', driversOf({ walkSwing: 1, moonwalk: 3 }), { walkSwing: 1 });
check('gain 为 0 视同未声明', driversOf({ walkSwing: 0 }), {});
check('gain 越界被丢掉', driversOf({ walkSwing: 5, breathe: -9 }), {});
check('drivers 缺席等于空表', driversOf(undefined), {});
check('驱动器表是封闭的五个', DRIVER_NAMES,
  ['walkSwing', 'breathe', 'dangle', 'impact', 'wave']);
check('表情键是封闭的两个', EXPR_KEYS, ['blink', 'talk']);

console.log('\n— 绘制顺序 —');
check('按 z 升序', drawOrder(normalizeSkeleton(humanoid)).map(b => b.id),
  ['thighL', 'torso', 'upperArmL', 'forearmL']);
check('z 相同保持声明顺序', drawOrder(normalizeSkeleton({ angleStep: 15,
  bones: [bone('r', null), bone('x', 'r'), bone('y', 'r')] })).map(b => b.id),
  ['r', 'x', 'y']);

console.log('\n— 姿势解算 —');
const sk = normalizeSkeleton(humanoid);
{
  // walkSwing 满摆：上臂 = 1 * 1 * 30 = 30 度 -> 15 度一档 = 2 档
  const p = resolvePose(sk, { walkSwing: 1 });
  check('上臂满摆两档', p.get('upperArmL'), 2);
  check('腿反相（gain 为负）', p.get('thighL'), -2);
  // 前臂 gain 0.5 -> 15 度，但限位 [-10, 10] 先夹成 10 度 -> 量化成 1 档
  check('前臂先限位再量化', p.get('forearmL'), 1);
  check('未声明该驱动器的骨头不动', p.get('torso'), 0);
}
check('缺席的信号按 0 处理', resolvePose(sk, {}).get('upperArmL'), 0);
check('非法信号被忽略', resolvePose(sk, { walkSwing: NaN }).get('upperArmL'), 0);
check('信号被夹进 [-1,1]', resolvePose(sk, { walkSwing: 99 }).get('upperArmL'), 2);
check('呼吸幅度小于一档时归零',
  resolvePose(sk, { breathe: 1 }).get('torso'), 0); // 4 度 < 15 度半档
check('没有骨架就空表', resolvePose(null, { walkSwing: 1 }).size, 0);

console.log('\n— 绘制身份键 —');
check('键是稳定的档位序列', poseKey(sk, resolvePose(sk, { walkSwing: 1 })), '0,2,1,-2');
check('微小抖动不产生新键',
  poseKey(sk, resolvePose(sk, { walkSwing: 0.99 })) === poseKey(sk, resolvePose(sk, { walkSwing: 1 })),
  true);
check('静止时键全零', poseKey(sk, resolvePose(sk, {})), '0,0,0,0');

console.log('\n— 父子变换 —');
{
  const rest = boneTransforms(sk, resolvePose(sk, {}));
  check('根骨头落在自己的 anchor 上',
    [rest.get('torso').x, rest.get('torso').y, rest.get('torso').angle], [95, 200, 0]);
  check('静止时子骨头 = 父枢轴 + anchor',
    [rest.get('upperArmL').x, rest.get('upperArmL').y], [107, 160]);

  // 让躯干转 90 度（3 档 × 15 度 = 45 度不够直观，直接构造一个 90 度骨架）
  const turned = normalizeSkeleton({ angleStep: 90,
    bones: [
      { id: 'torso', parent: null, pivot: { x: 0, y: 0 }, anchor: { x: 95, y: 200 },
        z: 0, frame: rect(), drivers: { walkSwing: 2 } },
      { id: 'arm', parent: 'torso', pivot: { x: 0, y: 0 }, anchor: { x: 12, y: -40 },
        z: 1, frame: rect() },
    ] });
  // walkSwing=1, gain=2 -> 60 度 -> 90 度一档四舍五入 = 1 档 = 90 度
  const pose = resolvePose(turned, { walkSwing: 1 });
  check('躯干转到一档', pose.get('torso'), 1);
  const t = boneTransforms(turned, pose);
  // anchor (12,-40) 绕 90 度 -> (0*12 - (-40)*1, 1*12 + 0*(-40)) = (40, 12)
  check('子骨头随父旋转搬家',
    [Math.round(t.get('arm').x), Math.round(t.get('arm').y)], [135, 212]);
  check('角度沿父链累加', t.get('arm').angle, 90);
}

console.log('\n— 表情替换帧 —');
{
  const withExpr = (expr) => normalizeSkeleton({ angleStep: 15,
    bones: [{ ...bone('a', null), frame: rect(), expr }] }).bones[0].expr;
  const base = { sx: 40, sy: 0, sw: 20, sh: 40 };            // 与 rect() 同尺寸
  check('同尺寸的替换帧被保留', withExpr({ blink: base }), { blink: base });
  check('未知表情键被丢掉',
    withExpr({ blink: base, wink: base }), { blink: base });
  // 尺寸不一致静默丢弃：留下的后果是"眨眼时头跳一格"，丢掉的后果只是"不会眨眼"
  check('尺寸不一致被丢掉',
    withExpr({ blink: { sx: 40, sy: 0, sw: 19, sh: 40 } }), null);
  check('没有 expr 就是 null', withExpr(undefined), null);

  const eyes = normalizeSkeleton({ angleStep: 15,
    bones: [{ ...bone('head', null), frame: rect(),
      expr: { blink: base, talk: { sx: 70, sy: 0, sw: 20, sh: 40 } } }] });
  const head = eyes.bones[0];
  check('睁眼时用基础帧', frameFor(head, 1, 1), head.frame);
  check('闭眼时换图', frameFor(head, 0.2, 1), base);
  check('张嘴时换图', frameFor(head, 1, 1.5).sx, 70);
  // 一根骨头同一时刻只用一张：闭眼优先于张嘴，否则说话时会睁着眼
  check('闭眼优先于张嘴', frameFor(head, 0.2, 1.5), base);
  // 归一器会重建帧对象，所以按值比而不是按身份比
  check('阈值两侧', [frameFor(head, 0.61, 1).sx, frameFor(head, 0.59, 1).sx],
    [head.frame.sx, base.sx]);
  check('没有替换帧的骨头永远用基础帧',
    frameFor(normalizeSkeleton({ angleStep: 15, bones: [bone('a', null)] }).bones[0], 0, 2)
      .sx, rect().sx);

  // 表情必须进绘制键：眨眼期间姿势没变，只看关节档位会把眨眼整个冻住
  check('眨眼换键', exprKey(eyes, 1, 1) !== exprKey(eyes, 0.2, 1), true);
  check('说话换键', exprKey(eyes, 1, 1) !== exprKey(eyes, 1, 1.5), true);
  check('同状态同键', exprKey(eyes, 1, 1), exprKey(eyes, 0.9, 1.1));
  check('没有表情的骨架键为空', exprKey(sk, 0, 2), '');

  check('能力来自声明', expressionsOf(eyes), { blink: true, talk: true });
  check('只声明闭眼就只有 blink',
    expressionsOf(normalizeSkeleton({ angleStep: 15,
      bones: [{ ...bone('a', null), frame: rect(), expr: { blink: base } }] })),
    { blink: true, talk: false });
  check('没有骨架就没有表情', expressionsOf(null), { blink: false, talk: false });
}

console.log('\n— meta 入口 —');
check('没有 skeleton 字段', skeletonOf({ sprite: { width: 1, height: 1 } }), null);
check('坏 skeleton 字段', skeletonOf({ skeleton: { angleStep: 0, bones: [] } }), null);
check('好 skeleton 字段', skeletonOf({ skeleton: humanoid }) !== null, true);
check('骨架角色', isSkeletal({ skeleton: humanoid }), true);
check('多帧帧带角色不是骨架角色',
  isSkeletal({ skeleton: humanoid, frames: { count: 8, fps: 10 } }), false);
check('单帧无骨架', isSkeletal({ frames: null }), false);
check('DRIVERS 的幅度表齐全',
  DRIVER_NAMES.every(n => Number.isFinite(DRIVERS[n]) && DRIVERS[n] > 0), true);

console.log(`\n${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail ? 1 : 0);

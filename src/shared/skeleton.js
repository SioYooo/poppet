// 关节骨架的唯一真相来源。
//
// 为什么它不住在 parts.js 里：`parts` 是**表情覆盖层**——每个部件都带 cleanFrame，
// 先把五官抹掉再贴回去，并且全部进 sprite.js 的 #computeFaceRect 决定每帧重画哪块。
// 骨骼部件是**身体本身**，没有 clean patch、不参与抹除、也不该进脸部矩形——
// 把躯干和四肢混进 parts 会让那个矩形膨胀成整只角色，
// 每帧增量重绘退化成全画布重绘，render-policy 量出来的跳帧收益直接归零。
// 两套语义分开存放，normalizeParts / capabilityOf 因此一行都不用改，
// v0/v1/v2 的兼容面完全不受这次扩展影响。
//
// 骨架不认解剖学。运行时不知道哪根骨头是"上臂"，只知道作者在它上面声明了哪些
// 驱动器（drivers）。左右腿反相是一个负号的事，尾巴、翅膀、耳朵这些非人形部件
// 也因此免费成立——不需要为每种生物扩一次枚举。

// 驱动器：把 brain 已经在算的运动信号接到关节角度上。
//
// 和 ROLES / CLIP_NAMES 同一条规矩：只登记运行时**真的实现了**的名字，
// 没有驱动方的名字不进表。值是「gain 为 1 时的最大摆幅（度）」，
// 作者用 gain 缩放，用负号反相。
//
// 这四个信号 brain.js 走路/呼吸/拖拽/落地时已经在算了，
// 骨架只是换一个消费方式——所以它们不需要作者画任何一帧。
export const DRIVERS = Object.freeze({
  walkSwing: 30,   // 步行相位驱动的前后摆（肩、髋）
  breathe: 4,      // 静息呼吸的微动
  dangle: 25,      // 离地/拖拽时的垂挂与惯性
  impact: 15,      // 落地冲击的屈伸
  wave: 70,        // 打招呼时的抬臂与摆动（brain 的 greet 状态）
});
export const DRIVER_NAMES = Object.freeze(Object.keys(DRIVERS));

// 表情帧：一根骨头可以为某个表情状态额外声明一张替换图。
//
// 骨架角色为什么不能复用 parts 那套覆盖层：那套的坐标写死在精灵坐标系里
// （part.x / part.y），而骨架一动，头就不在那个坐标上了。所以这里换的是
// **整块部件**——头部部件有睁眼和闭眼两张图，由 blink 选一张，而那块部件
// 本来就跟着骨架走，坐标问题自然消失。
//
// 替换帧必须和基础帧同尺寸：pivot 是按基础帧标的，尺寸一变枢轴就错位，
// 眨一下眼整个头会跳一格。这条在 src/main/security.js 里 fail-closed。
//
// 想让眼睛和嘴各自独立，就把它们拆成两根骨头（都挂在头下面）——
// 一根骨头同一时刻只用一张替换图，优先级 blink > talk。
export const EXPR_KEYS = Object.freeze(['blink', 'talk']);
// 阈值：像素风的眨眼本来就是两三帧的事，连续插值没有意义，切换即可。
export const BLINK_SWAP = 0.6;   // blink 低于此值用闭眼图
export const TALK_SWAP = 1.15;   // mouthOpen 高于此值用张嘴图

// 骨骼 id 的合法形状。和 parts / suggestions 的 id 用同一条正则，
// 免得三处各写一份、迟早漂移。
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const MAX_BONES = 64;
// 层级深度上限。遍历是迭代写的，这个上限防的不是栈溢出，
// 是「作者手写出一条 60 层的链」导致每帧的变换累乘变成隐形的性能悬崖。
export const MAX_DEPTH = 8;
// 角度量化步长的合法区间。1 度以下对像素艺术没有意义（最近邻采样根本分不出来），
// 90 度以上就不是动画了。
export const MIN_ANGLE_STEP = 1;
export const MAX_ANGLE_STEP = 90;
const MAX_ABS_ANGLE = 180;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function point(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { x, y } = raw;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { x, y };
}

function frameOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { sx, sy, sw, sh } = raw;
  if (!Number.isInteger(sx) || !Number.isInteger(sy)
      || !Number.isInteger(sw) || !Number.isInteger(sh)) return null;
  if (sx < 0 || sy < 0 || sw <= 0 || sh <= 0) return null;
  return { sx, sy, sw, sh };
}

// drivers 表 -> 只保留已登记的驱动器。未知名字静默丢弃：
// 这里在渲染热路径的上游，而 src/main/security.js 已经在导入边界 fail-closed 拦过，
// 运行时再抛只会把一个已被拒绝的形状变成崩溃。
function drivers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const name of DRIVER_NAMES) {
    const gain = raw[name];
    if (!isFiniteNumber(gain) || gain < -2 || gain > 2 || gain === 0) continue;
    out[name] = gain;
  }
  return out;
}

// 角度限位。缺省是「不限位」，写坏了也当不限位——
// 限位是给作者兜底的，不是安全边界，安全边界在 security.js。
function limit(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [lo, hi] = raw;
  if (!isFiniteNumber(lo) || !isFiniteNumber(hi) || lo > hi) return null;
  if (lo < -MAX_ABS_ANGLE || hi > MAX_ABS_ANGLE) return null;
  return [lo, hi];
}

// expr 表 -> 只保留已登记的表情键，且尺寸必须与基础帧一致。
// 尺寸不一致的静默丢弃：运行时丢掉的后果是"不会眨眼"，
// 而留下的后果是"眨眼时头跳一格"，前者明显更轻。
function exprFrames(raw, base) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let any = false;
  for (const key of EXPR_KEYS) {
    const frame = frameOf(raw[key]);
    if (!frame || frame.sw !== base.sw || frame.sh !== base.sh) continue;
    out[key] = frame;
    any = true;
  }
  return any ? out : null;
}

function bone(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const parent = raw.parent === null || raw.parent === undefined ? null : raw.parent;
  if (parent !== null && (typeof parent !== 'string' || !ID_RE.test(parent))) return null;
  const pivot = point(raw.pivot);
  const anchor = point(raw.anchor);
  const rect = frameOf(raw.frame);
  if (!pivot || !anchor || !rect) return null;
  if (!Number.isInteger(raw.z)) return null;
  return {
    id: raw.id,
    parent,
    pivot,
    anchor,
    z: raw.z,
    frame: rect,
    drivers: drivers(raw.drivers),
    limit: limit(raw.limit),
    expr: exprFrames(raw.expr, rect),
  };
}

// 任意输入 -> 合法骨架或 null。
//
// 整份拒绝而不是逐根丢弃：少一根骨头的骨架不是「退化的骨架」，
// 是一个**断掉的**骨架——父引用会悬空，手臂会连着空气。
// clips 可以逐条丢（丢一段就少播一段），骨架不行。
export function normalizeSkeleton(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const step = raw.angleStep;
  if (!Number.isInteger(step) || step < MIN_ANGLE_STEP || step > MAX_ANGLE_STEP) return null;
  if (!Array.isArray(raw.bones) || raw.bones.length < 1 || raw.bones.length > MAX_BONES) return null;

  const bones = [];
  const byId = new Map();
  for (const entry of raw.bones) {
    const b = bone(entry);
    if (!b || byId.has(b.id)) return null;
    byId.set(b.id, b);
    bones.push(b);
  }

  // 恰好一个根。允许多个根意味着允许多棵互不相干的树，
  // 而 z 序、anchor 原点、以及"整只角色"这个概念都要求单一原点。
  const roots = bones.filter(b => b.parent === null);
  if (roots.length !== 1) return null;

  // 父引用必须存在，且沿父链走不出环、不超深。
  // 环在渲染时表现为无限循环——必须在这里拦住，而不是靠渲染器的循环上限兜。
  for (const b of bones) {
    let depth = 0;
    let cursor = b;
    while (cursor.parent !== null) {
      const next = byId.get(cursor.parent);
      if (!next) return null;
      if (++depth > MAX_DEPTH) return null;
      cursor = next;
    }
  }

  return { angleStep: step, bones };
}

// 绘制顺序：z 升序（大的在前），z 相同按声明顺序稳定排列。
// 显式 z 而不是数组顺序，是因为遮挡关系会随姿势变——
// 手臂在身前还是身后，将来要能按姿势切换，而数组顺序切不动。
export function drawOrder(skeleton) {
  if (!skeleton) return [];
  return skeleton.bones
    .map((b, index) => ({ b, index }))
    .sort((a, c) => (a.b.z - c.b.z) || (a.index - c.index))
    .map(entry => entry.b);
}

function quantize(degrees, step) {
  // 量化到档位**整数**再乘回去。存档位而不是存角度，
  // 是为了让 render-policy 的 poseDrawKey 拿到一个短且稳定的键：
  // 浮点角度逐帧微抖会让每一帧的 key 都不同，跳帧机制会彻底失效。
  const clamped = Math.max(-MAX_ABS_ANGLE, Math.min(MAX_ABS_ANGLE, degrees));
  return Math.round(clamped / step);
}

// 运动信号 -> 每根骨头的档位索引。
//
// signals 是 brain 已经在算的那几个量（walkSwing 的相位、呼吸、垂挂、落地冲击），
// 取值约定在 [-1, 1]（impact 用 [0, 1]）。缺席的信号按 0 处理，
// 所以一个只声明了 breathe 的骨架在走路时不会突然乱动。
export function resolvePose(skeleton, signals) {
  const out = new Map();
  if (!skeleton) return out;
  const source = signals && typeof signals === 'object' ? signals : {};
  for (const b of skeleton.bones) {
    let degrees = 0;
    for (const name of DRIVER_NAMES) {
      const gain = b.drivers[name];
      if (gain === undefined) continue;
      const signal = source[name];
      if (!isFiniteNumber(signal)) continue;
      degrees += Math.max(-1, Math.min(1, signal)) * gain * DRIVERS[name];
    }
    if (b.limit) degrees = Math.max(b.limit[0], Math.min(b.limit[1], degrees));
    out.set(b.id, quantize(degrees, skeleton.angleStep));
  }
  return out;
}

// 这一帧该画这根骨头的哪张图。没有声明替换帧的骨头永远返回基础帧，
// 所以不带表情的骨架完全不受影响。
export function frameFor(bone, blink, mouthOpen) {
  const expr = bone.expr;
  if (!expr) return bone.frame;
  if (expr.blink && blink < BLINK_SWAP) return expr.blink;
  if (expr.talk && mouthOpen > TALK_SWAP) return expr.talk;
  return bone.frame;
}

// 表情选择的绘制身份键。必须进 render-policy 的键，否则跳帧会把一次眨眼冻住：
// 姿势没变、图换了，光看关节档位是看不出来的。
export function exprKey(skeleton, blink, mouthOpen) {
  if (!skeleton) return '';
  let key = '';
  for (const b of skeleton.bones) {
    if (!b.expr) continue;
    key += b.expr.blink && blink < BLINK_SWAP ? 'b'
      : b.expr.talk && mouthOpen > TALK_SWAP ? 't' : '-';
  }
  return key;
}

// 骨架声明了哪些表情能力。没有任何骨头声明替换帧就是"不会眨眼"，
// 和一张没有检测到眼睛的立绘同义。
export function expressionsOf(skeleton) {
  const out = { blink: false, talk: false };
  if (!skeleton) return out;
  for (const b of skeleton.bones) {
    if (!b.expr) continue;
    if (b.expr.blink) out.blink = true;
    if (b.expr.talk) out.talk = true;
  }
  return out;
}

// 档位表 -> 绘制身份键。给 render-policy 的 poseDrawKey 拼进去用。
// 顺序取自 skeleton.bones 的声明顺序（稳定），值是整数档位，
// 所以同一姿势永远得到同一个键，而微小抖动不会产生新键。
export function poseKey(skeleton, angles) {
  if (!skeleton || !angles) return '';
  return skeleton.bones.map(b => angles.get(b.id) ?? 0).join(',');
}

// 档位表 -> 每根骨头的世界变换。
//
// 返回的是绘制所需的最小量：部件在世界里的枢轴位置 + 累积角度。
// 渲染器据此 translate(px, py) -> rotate(rad) -> drawImage(-pivot.x, -pivot.y)。
//
// 角度沿父链累加，位置按「父的枢轴 + 旋转后的 anchor」推进——
// 这就是父子关节：转肩膀，小臂和手跟着走，因为它们的原点长在肩膀的坐标系里。
export function boneTransforms(skeleton, angles) {
  const out = new Map();
  if (!skeleton) return out;
  const step = skeleton.angleStep;
  const byId = new Map(skeleton.bones.map(b => [b.id, b]));

  const solve = (b) => {
    const cached = out.get(b.id);
    if (cached) return cached;
    const own = (angles.get(b.id) ?? 0) * step;
    if (b.parent === null) {
      // 根骨头的 anchor 就是它在精灵坐标系里的落点。
      const node = { x: b.anchor.x, y: b.anchor.y, angle: own };
      out.set(b.id, node);
      return node;
    }
    const parent = solve(byId.get(b.parent));
    const rad = parent.angle * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // anchor 是「本骨枢轴落在父骨的哪个像素上」，用父的**局部**坐标写，
    // 所以要先按父的累积角度旋转，再叠到父的世界枢轴上。
    const node = {
      x: parent.x + b.anchor.x * cos - b.anchor.y * sin,
      y: parent.y + b.anchor.x * sin + b.anchor.y * cos,
      angle: parent.angle + own,
    };
    out.set(b.id, node);
    return node;
  };

  // 迭代式地把每根都解出来。solve 内部递归到根，深度已由 MAX_DEPTH 限住。
  for (const b of skeleton.bones) solve(b);
  return out;
}

// meta -> 骨架，没有就 null。运行时用这个而不是直接读 meta.skeleton，
// 免得「有这个字段」和「这个字段是合法骨架」两件事在调用方混为一谈。
export function skeletonOf(meta) {
  return normalizeSkeleton(meta && meta.skeleton);
}

// 角色是不是骨架驱动的。骨架和多帧帧带互斥：
// 帧带角色的动作是作者画的，骨架角色的动作是算出来的，
// 同时启用会让两套动作互相打架（画好的走路姿势上再叠一次程序化摆臂）。
// 这里返回 false 而不是报错——security.js 会在导入边界拒掉同时声明两者的素材。
export function isSkeletal(meta) {
  if (!meta) return false;
  if (meta.frames && meta.frames.count > 1) return false;
  return skeletonOf(meta) !== null;
}

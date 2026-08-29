// 部件表的唯一真相来源。
//
// 为什么单独抽一个模块：同一份「eyeL/eyeR 兼容」逻辑此前散在 5 个地方各写一遍
// （sprite.js、manager.js、pipeline.js、verify-face.mjs、debug-view.mjs），
// 其中 debug-view.mjs 那份只认旧格式，对新素材静默画不出框——
// 重复的兼容逻辑迟早会漂移，这里把它收成一处。
//
// 历史上出现过三种形态，normalizeParts 一律吃进来吐出统一的 role 数组：
//   v0  { eyeL, eyeR, mouth }        最早的两个固定槽位
//   v1  { eyes: [...], mouth }       眼睛数组化之后（独眼/侧脸/三眼怪需要）
//   v2  [ { role, id, source, … } ]  现在：带 role 标签与来源标记
//
// 判别靠的是**结构形状**而不是 schemaVersion 字段——版本号是我们自己写进去的，
// 手改过的、别的工具产的、迁移到一半的文件都可能对不上，形状不会骗人。

import { isSkeletal, skeletonOf, expressionsOf } from './skeleton.js';

// 一个 role 能驱动哪种调制器。只登记**已经实现**的 role：
// 没有探测器也没有运行时调制器的 role（tail/ear/glow…）先不进表，
// 空占位的 schema 比没有 schema 更难删。
export const ROLES = {
  eye: { modulator: 'blink', multi: true, label: '眼睛' },
  mouth: { modulator: 'talk', multi: false, label: '嘴' },
};

export const SCHEMA_VERSION = 2;
// v3 = 关节骨架角色（src/shared/skeleton.js）。和 v2 是互斥的两类素材，
// 不是"v2 的升级版"：v2 角色永远停在 2，不需要也不会被迁移。
export const SKELETAL_SCHEMA_VERSION = 3;

// 动画片段：多帧素材把一条帧带按行为切成命名区间，走路播走路那几帧，招手播招手
// 那几帧，而不是整条帧带无差别循环。
//
// 和 ROLES 同一条规矩：只登记运行时**真的会去请求**的名字。没有驱动方的名字不
// 进表——空占位的 schema 比没有 schema 更难删。这四个名字与 brain 的状态名一一
// 对应，所以中间没有翻译表可以漂移。
//
// 回落链是 精确匹配 -> idle -> 整条帧带，因此作者只画一段 idle 也成立，其余状态
// 自动复用它；完全不写 clips 的老素材行为与从前完全一致。
export const CLIP_NAMES = Object.freeze(['idle', 'walk', 'drag', 'greet']);
export const CLIP_FALLBACK = 'idle';

// 任意输入 -> 合法片段表。未知名字、非整数、空区间、越界区间一律丢弃；一条都不
// 剩就返回 null。管线在重新切分后拿它裁剪作者的旧标注（帧数变了，旧区间不能默默
// 带过去），运行时拿它读 meta。
//
// 这里静默丢弃而不抛：既在渲染热路径上，`src/main/security.js` 也已经在导入边界
// fail-closed 拦过一遍，运行时再抛只会把一个已被拒绝的形状变成崩溃。
export function normalizeClips(raw, count) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(count) || count < 2) return null;
  const out = {};
  let any = false;
  for (const name of CLIP_NAMES) {
    const range = raw[name];
    if (!Array.isArray(range) || range.length !== 2) continue;
    const [start, end] = range;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end < start || end >= count) continue;
    out[name] = [start, end];
    any = true;
  }
  return any ? out : null;
}

// meta -> { name: [start, end] }
export function clipsOf(meta) {
  const frames = meta && meta.frames;
  if (!frames) return null;
  return normalizeClips(frames.clips, frames.count);
}

// 行为状态 -> 该播的帧区间。单帧素材返回 null（调用方据此完全跳过帧逻辑）。
export function clipRangeFor(meta, state) {
  const frames = meta && meta.frames;
  if (!frames || !(frames.count > 1)) return null;
  const full = [0, frames.count - 1];
  const clips = clipsOf(meta);
  if (!clips) return full;
  return clips[state] || clips[CLIP_FALLBACK] || full;
}

// source 只有两个合法值。'user' 表示这一框是人明确画过的，
// 重新处理时不能被自动检测结果覆盖；'auto' 才是可以随便重算的。
export const SOURCE_AUTO = 'auto';
export const SOURCE_USER = 'user';

function entry(role, raw, idFallback) {
  if (!raw) return null;
  // 只显式处理需要归一的四个字段，其余原样透传。
  // 不要在这里列白名单：白名单会把没登记过的字段静默吃掉——
  // 部件存进了 JSON、读出来却少了一半，而且不报任何错。
  const { role: _role, id: _id, name: _name, source: _source, ...rest } = raw;
  return {
    role,
    id: raw.id || raw.name || idFallback,
    source: raw.source === SOURCE_USER ? SOURCE_USER : SOURCE_AUTO,
    ...rest,
  };
}

// 任意历史格式 -> role 数组。null / 空 / 多帧素材的空表都返回 []，不抛异常。
export function normalizeParts(parts) {
  if (!parts) return [];

  // v2：已经是数组。仍然过一遍 entry()，把缺省字段补齐、非法 source 归一。
  if (Array.isArray(parts)) {
    return parts
      .map((p, i) => (p && p.role ? entry(p.role, p, p.role + i) : null))
      .filter(Boolean);
  }

  const out = [];
  // v1：eyes 数组
  if (Array.isArray(parts.eyes)) {
    parts.eyes.filter(Boolean).forEach((e, i) => {
      const p = entry('eye', e, 'eye' + i);
      if (p) out.push(p);
    });
  } else {
    // v0：eyeL / eyeR 两个固定槽位。
    // id 必须原样保留成 eyeL/eyeR——它是图集帧和 rowSpans 的查表键，
    // 改成 eye0/eye1 会让眼睑线查不到区间，闭眼从「两条黑线」退化成「眼睛直接缩没」。
    const l = entry('eye', parts.eyeL, 'eyeL');
    const r = entry('eye', parts.eyeR, 'eyeR');
    if (l) out.push(l);
    if (r) out.push(r);
  }
  const m = entry('mouth', parts.mouth, 'mouth');
  if (m) out.push(m);
  return out;
}

export function partsByRole(parts, role) {
  return normalizeParts(parts).filter(p => p.role === role);
}

export function eyesOf(parts) {
  return partsByRole(parts, 'eye');
}

// mouth 是单例 role，多于一个时取第一个（手动框选理论上不会产生第二个）
export function mouthOf(parts) {
  return partsByRole(parts, 'mouth')[0] || null;
}

// 角色能做哪些表情动作。这是「能力协商」的最小形态：
// 角色声明自己有什么，行为按它决定进不进池子，而不是到处散落 if (mouth)。
export function capabilityOf(meta) {
  const list = normalizeParts(meta && meta.parts);
  const multi = !!(meta && meta.frames && meta.frames.count > 1);
  // 骨架角色不走 parts 那套覆盖层——它的坐标写死在精灵坐标系里（part.x / part.y），
  // 而骨架一动头就不在那个坐标上了。骨架角色改为**整块部件替换**：头部部件带一张
  // 闭眼图，由 blink 选，而那块部件本来就跟着骨架走。所以能力来源不同，
  // 但对外仍然只是 blink / talk 两个布尔，行为层不需要知道差别。
  const skeletal = isSkeletal(meta);
  const expr = skeletal ? expressionsOf(skeletonOf(meta)) : null;
  return {
    // 多帧素材自带表情，再叠一层覆盖只会跟原帧对不上
    blink: multi ? false : skeletal ? expr.blink : list.some(p => p.role === 'eye'),
    talk: multi ? false : skeletal ? expr.talk : list.some(p => p.role === 'mouth'),
    skeletal,
    // 作者真正画了哪几段。空数组表示"多帧但未分段"（整条帧带循环）或单帧素材，
    // 行为层据此决定要不要按状态切段。
    clips: Object.keys(clipsOf(meta) || {}),
  };
}

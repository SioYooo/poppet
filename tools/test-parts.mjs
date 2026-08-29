// 部件表规整器的回归测试。
// 这里守的是「换个历史格式还认不认得出来」——认错的后果很隐蔽：
// 桌宠照常加载、照常走动，就是永远不眨眼，而且不报任何错。
import { normalizeParts, capabilityOf, clipsOf, clipRangeFor, normalizeClips, SOURCE_USER, SOURCE_AUTO } from '../src/shared/parts.js';

const box = (x, y) => ({ x, y, w: 4, h: 3 });
let pass = 0, fail = 0;

function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log(`  ✗ ${name}\n      期望 ${w}\n      实际 ${g}`); }
}
const sig = (list) => list.map(p => `${p.role}:${p.id}:${p.source}`);

// —— 三种历史格式 ——
check('v0 两槽位 eyeL/eyeR',
  sig(normalizeParts({ eyeL: box(1, 2), eyeR: box(9, 2), mouth: box(4, 8) })),
  ['eye:eyeL:auto', 'eye:eyeR:auto', 'mouth:mouth:auto']);

// id 必须原样保留：它是图集帧与 rowSpans 的查表键，
// 改成 eye0/eye1 会让眼睑线查不到区间，闭眼从"两条黑线"退化成"眼睛缩没"
check('v0 的 id 不被改写',
  normalizeParts({ eyeL: box(1, 2), eyeR: box(9, 2) }).map(p => p.id),
  ['eyeL', 'eyeR']);

check('v1 eyes 数组',
  sig(normalizeParts({ eyes: [{ name: 'eye0', ...box(1, 2) }, { name: 'eye1', ...box(9, 2) }], mouth: { name: 'mouth', ...box(4, 8) } })),
  ['eye:eye0:auto', 'eye:eye1:auto', 'mouth:mouth:auto']);

check('v1 数组里的 null 洞被丢掉',
  sig(normalizeParts({ eyes: [null, { name: 'eye1', ...box(9, 2) }], mouth: null })),
  ['eye:eye1:auto']);

check('v2 role 数组 + 来源',
  sig(normalizeParts([
    { role: 'eye', id: 'eye0', source: SOURCE_USER, ...box(1, 2) },
    { role: 'mouth', id: 'mouth', ...box(4, 8) },
  ])),
  ['eye:eye0:user', 'mouth:mouth:auto']);

check('非法 source 归一成 auto',
  normalizeParts([{ role: 'eye', id: 'e', source: '随便写的', ...box(1, 2) }]).map(p => p.source),
  [SOURCE_AUTO]);

// —— 边界：这些都不许抛异常 ——
check('null', normalizeParts(null), []);
check('undefined', normalizeParts(undefined), []);
check('空数组', normalizeParts([]), []);
check('多帧素材的空表', normalizeParts({ eyes: [], mouth: null }), []);
check('数组里的脏数据被丢掉', normalizeParts([null, {}, { role: 'eye', id: 'e', ...box(1, 1) }]).length, 1);

// —— 能力协商 ——
const full = [{ role: 'eye', id: 'e0', ...box(1, 2) }, { role: 'mouth', id: 'm', ...box(4, 8) }];
check('有眼有嘴', capabilityOf({ parts: full }), { blink: true, talk: true, skeletal: false, clips: [] });
check('有眼无嘴', capabilityOf({ parts: [full[0]] }), { blink: true, talk: false, skeletal: false, clips: [] });
check('无部件', capabilityOf({ parts: null }), { blink: false, talk: false, skeletal: false, clips: [] });
// 多帧素材帧里本来就有表情，再叠一层覆盖会跟原帧对不上
check('多帧素材不叠表情', capabilityOf({ parts: full, frames: { count: 6 } }), { blink: false, talk: false, skeletal: false, clips: [] });
check('单帧的 frames 不算多帧', capabilityOf({ parts: full, frames: { count: 1 } }), { blink: true, talk: true, skeletal: false, clips: [] });

// 骨架角色与多帧素材做同一笔交易：放弃程序化表情，换会动的肢体。
// 表情覆盖层的坐标写死在精灵坐标系里，头一旦随骨架移动，眼睑线就画到脸颊外面去了。
const boneMeta = {
  parts: full,
  skeleton: {
    angleStep: 15,
    bones: [{ id: 'torso', parent: null, pivot: { x: 2, y: 2 }, anchor: { x: 10, y: 20 },
              z: 0, frame: { sx: 0, sy: 0, sw: 8, sh: 12 }, drivers: { breathe: 1 } }],
  },
};
check('骨架角色不叠表情', capabilityOf(boneMeta), { blink: false, talk: false, skeletal: true, clips: [] });
check('坏骨架不算骨架角色',
  capabilityOf({ parts: full, skeleton: { angleStep: 0, bones: [] } }).skeletal, false);
check('骨架与多帧共存时骨架失效（边界会拒，运行时不猜）',
  capabilityOf({ ...boneMeta, frames: { count: 6 } }).skeletal, false);

// —— 动画片段 ——
const clipMeta = { parts: [], frames: { count: 20, fps: 12, clips: { idle: [0, 3], walk: [4, 11], greet: [12, 19] } } };
check('片段被规整出来', clipsOf(clipMeta), { idle: [0, 3], walk: [4, 11], greet: [12, 19] });
check('未知片段名被丢掉', clipsOf({ frames: { count: 4, clips: { idle: [0, 1], nope: [2, 3] } } }), { idle: [0, 1] });
check('越界区间被丢掉', clipsOf({ frames: { count: 4, clips: { idle: [0, 9] } } }), null);
check('倒置区间被丢掉', clipsOf({ frames: { count: 8, clips: { idle: [5, 2] } } }), null);
check('单帧没有片段', clipsOf({ frames: { count: 1, clips: { idle: [0, 0] } } }), null);
check('精确匹配', clipRangeFor(clipMeta, 'walk'), [4, 11]);
check('没有该段就回落待机', clipRangeFor(clipMeta, 'hop'), [0, 3]);
check('没有待机段就整条帧带', clipRangeFor({ frames: { count: 6, clips: { walk: [0, 2] } } }, 'hop'), [0, 5]);
check('未分段的多帧走整条帧带', clipRangeFor({ frames: { count: 6 } }, 'walk'), [0, 5]);
check('单帧素材没有区间', clipRangeFor({ frames: null }, 'walk'), null);
check('能力表列出已标注的段', capabilityOf(clipMeta).clips, ['idle', 'walk', 'greet']);
check('管线归一按最终帧数裁剪', normalizeClips({ idle: [0, 3], walk: [4, 11] }, 6), { idle: [0, 3] });

console.log(`\n${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail ? 1 : 0);

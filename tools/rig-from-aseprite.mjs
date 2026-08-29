// Aseprite 分层导出 -> Poppet 关节骨架（metadata.skeleton）。
//
// 分工是刻意的：Aseprite 给出**像素和矩形**，作者给出**拓扑**。
// 图层的父子关系、枢轴、锚点、层序、驱动器增益没有任何办法从一张图里推断出来
// （仓库已经为"从平面图自动认肢体"留过判决：命名不可靠、定位不完美），
// 所以这里不猜，只做合并与校验。
//
// 一、在 Aseprite 里把每个部件放进**同名图层**，然后导出：
//
//   aseprite -b --split-layers character.aseprite \
//            --sheet parts.png --data parts.json
//
//   注意 --split-layers 必须写在文件名**前面**（官方文档明确写了这条）。
//   另外：动画分段（frames.clips）需要额外的 --list-tags，单独的 --data 不会
//   输出 tags——但骨架角色不用帧带，所以这里用不到。
//
// 二、写一份 rig.json 描述拓扑（键就是图层名）：
//
//   {
//     "angleStep": 15,
//     "bones": {
//       "pelvis":  { "parent": null,    "pivot": [9,5],  "anchor": [64,84], "z": 10 },
//       "torso":   { "parent": "pelvis","pivot": [12,32],"anchor": [0,-5],  "z": 12,
//                    "drivers": { "breathe": 1 } },
//       "thighL":  { "parent": "pelvis","pivot": [5,2],  "anchor": [5,5],   "z": 16,
//                    "drivers": { "walkSwing": 1, "dangle": 1 }, "limit": [-70,70] }
//     }
//   }
//
// 三、合并：
//
//   node tools/rig-from-aseprite.mjs parts.json rig.json > skeleton.json
//
// 输出直接就是 character.json 里 "skeleton" 字段的值。

import fs from 'node:fs';
import { normalizeSkeleton, DRIVER_NAMES } from '../src/shared/skeleton.js';

function die(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    die(`读不出 ${label}（${file}）：${error.message}`);
  }
}

// Aseprite 的 --data 有两种形态：frames 是对象（json-hash）或数组（json-array）。
// 两种都要吃，因为导出时的 --format 是作者定的，不是我们定的。
function framesOf(data) {
  if (Array.isArray(data.frames)) {
    return data.frames.map(entry => [entry.filename || '', entry.frame]);
  }
  if (data.frames && typeof data.frames === 'object') {
    return Object.entries(data.frames).map(([name, entry]) => [name, entry.frame]);
  }
  die('Aseprite 数据里没有 frames；导出时要带 --data');
}

// --split-layers 的条目名形如 "character (torso) 0.ase"，图层名在括号里。
// 取最后一对括号：图层名本身可能带括号，文件名一般不带。
function layerNameOf(entry) {
  const match = /\(([^()]*)\)[^()]*$/.exec(entry);
  return match ? match[1].trim() : null;
}

function main() {
  const [sheetData, rigSpec] = process.argv.slice(2);
  if (!sheetData || !rigSpec) {
    die('用法: node tools/rig-from-aseprite.mjs <aseprite --data 的 json> <rig.json>');
  }

  const data = readJson(sheetData, 'Aseprite 数据');
  const rig = readJson(rigSpec, 'rig 描述');
  if (!rig || typeof rig !== 'object' || !rig.bones || typeof rig.bones !== 'object') {
    die('rig.json 需要一个 bones 对象');
  }

  // 图层名 -> 图集矩形。同名图层多帧时取第一帧：骨架角色是单帧素材，
  // 出现多帧说明作者把帧带和骨架混用了，这里直接说清楚而不是静默取一个。
  const rects = new Map();
  const seen = new Map();
  for (const [entry, frame] of framesOf(data)) {
    const layer = layerNameOf(entry);
    if (!layer || !frame) continue;
    seen.set(layer, (seen.get(layer) || 0) + 1);
    if (!rects.has(layer)) {
      rects.set(layer, { sx: frame.x, sy: frame.y, sw: frame.w, sh: frame.h });
    }
  }
  if (!rects.size) {
    die('没有从条目名里解析出图层名；导出时要带 --split-layers（且它必须写在文件名前面）');
  }
  for (const [layer, count] of seen) {
    if (count > 1) {
      process.stderr.write(
        `警告: 图层 ${layer} 有 ${count} 帧，骨架角色是单帧素材，只取第 1 帧\n`);
    }
  }

  const bones = [];
  for (const [id, spec] of Object.entries(rig.bones)) {
    const frame = rects.get(id);
    if (!frame) {
      die(`rig.json 里的骨骼 "${id}" 在图集里找不到同名图层；`
        + `现有图层: ${[...rects.keys()].join(', ')}`);
    }
    const pivot = spec.pivot || [0, 0];
    const anchor = spec.anchor || [0, 0];
    for (const name of Object.keys(spec.drivers || {})) {
      if (!DRIVER_NAMES.includes(name)) {
        die(`骨骼 "${id}" 声明了未知驱动器 "${name}"；可用: ${DRIVER_NAMES.join(', ')}`);
      }
    }
    bones.push({
      id,
      parent: spec.parent ?? null,
      pivot: { x: pivot[0] | 0, y: pivot[1] | 0 },
      anchor: { x: anchor[0] | 0, y: anchor[1] | 0 },
      z: spec.z | 0,
      frame,
      drivers: spec.drivers || {},
      limit: spec.limit ?? null,
    });
  }

  // 图集里有、但 rig.json 没提的图层：多半是作者漏了一根骨头，
  // 而漏掉的后果是那块美术永远画不出来且没有任何报错。宁可吵一句。
  for (const layer of rects.keys()) {
    if (!rig.bones[layer]) process.stderr.write(`警告: 图层 ${layer} 没有对应的骨骼，将不会被绘制\n`);
  }

  const skeleton = { angleStep: rig.angleStep ?? 15, bones };
  // 用运行时那份归一器自检一遍。它拒绝的东西导入边界一定也会拒，
  // 让作者在这里就知道，而不是在应用里看到一句"角色不动了"。
  if (!normalizeSkeleton(skeleton)) {
    die('生成的骨架没通过校验：检查恰好一个根骨骼（parent 为 null）、'
      + '父引用是否存在、有没有成环、层级是否超过 8 层、angleStep 是否在 1..90。');
  }
  process.stdout.write(JSON.stringify(skeleton, null, 2) + '\n');
}

main();

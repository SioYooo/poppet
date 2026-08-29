// 通用素材管线：任意一张角色立绘 -> 桌宠可用的精灵 + 眼/嘴部件 + 元数据。
//
// 全流程不含任何针对某张图的硬编码颜色。五官靠的是一个与色相无关的观察：
// **眼睛和嘴，是"脸"这块均匀色区域上的洞。** 先用局部色差把图切成区域，
// 再找哪个区域的洞里有一对左右对称的，那对就是眼睛，它所在的区域就是脸。
//
// 检测失败不是错误：拿不到五官就只生成精灵，桌宠照样能呼吸、走动、被拖拽，
// 只是不会眨眼。用户也可以在管理界面手动框选来覆盖检测结果。

import {
  createImage, colorDistance, dilate, erode, fillHoles,
  labelBlobs, keepLargestOpaqueComponent, growRegions, regionHoles,
  downsampleTo, quantize, nearestPaletteColor, NEIGHBORS4,
} from './imageops.js';
import { SCHEMA_VERSION, SOURCE_AUTO, SOURCE_USER, normalizeParts, normalizeClips } from './parts.js';
import { detectProtrusions, nominate } from './protrusion.js';
import { extractLocalSubject } from './extraction/local-extractor.js';
import { extractSubject } from './extraction/subject-extractor.js';
import { normalizePixelizeOptions, pixelizeFrames } from './pixelize.js';

export const DEFAULTS = {
  targetHeight: 400,   // 运行时精灵高度（px）
  paletteSize: 48,
  alphaThreshold: 160, // 低于此值算背景，顺带削掉外发光那种半透明残留
  bgTolerance: 42,     // 无 alpha 时的去背色差容差
  margin: 4,
  iconSize: 44,
  maxSourcePixels: 4096 * 4096,
  maxTotalSourcePixels: 4096 * 4096,
  maxSourceDimension: 8192,
  maxSheetWidth: 32768,
  // quantize/growRegions 会为工作像素建立 JS 结构；这里远小于源图预算是刻意的。
  maxWorkingPixels: 256 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  processingTimeoutMs: 15_000,
  maxOpaqueRuns: 256 * 1024,
  frameFps: 10,        // 多帧素材的播放速度
  maxFrames: 64,
};

function resourceError(message, code = 'POPPET_RESOURCE_LIMIT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertProcessingActive(options, stage) {
  if (typeof options.shouldCancel === 'function' && options.shouldCancel(stage)) {
    throw resourceError(`处理已取消（${stage}）`, 'POPPET_PROCESS_CANCELLED');
  }
  if (Number.isFinite(options.deadline) && Date.now() > options.deadline) {
    throw resourceError(`图片处理超时（${stage}）`, 'POPPET_PROCESS_TIMEOUT');
  }
}

function isProcessingStop(error) {
  return error?.code === 'POPPET_PROCESS_CANCELLED' || error?.code === 'POPPET_PROCESS_TIMEOUT';
}

// 每个不透明连通域至少包含一条横向 run。先在线性扫描里限制 run 数，能在进入
// 需要 stack/cells 的连通域算法之前，低内存拒绝 alpha 棋盘格这类碎片炸弹。
function assertOpaqueRunBudget(img, options) {
  const maxRuns = options.maxOpaqueRuns;
  const threshold = options.alphaThreshold;
  let runs = 0;
  for (let y = 0; y < img.height; y++) {
    let opaque = false;
    const row = y * img.width;
    for (let x = 0; x < img.width; x++) {
      const next = img.data[(row + x) * 4 + 3] >= threshold;
      if (next && !opaque && ++runs > maxRuns) {
        throw resourceError(`图片透明轮廓过于碎片化（横向片段超过 ${maxRuns}）`);
      }
      opaque = next;
    }
    if ((y & 63) === 63) assertProcessingActive(options, '透明轮廓预检');
  }
  return runs;
}

// ============================================================
// 1) 去背
// ============================================================

// 已经有透明通道就只做二值化；整张不透明才从四边做容差 flood fill。
// 从边缘扩散而不是全局配色，角色身上同色的部分才不会被一起挖掉。
//
// shared：多帧素材要把第一帧的决策原样套到其余帧上。
// 逐帧独立决策的话，各帧可能一个走 alpha、一个走 chroma、各自算出不同容差，
// 甚至有的帧四角不一致被判成"满幅插画"整块不去背——播放起来背景就在闪。
export function removeBackground(img, opts = {}, shared = null) {
  return extractLocalSubject(img, { ...DEFAULTS, ...opts }, shared).decision;
}

// ============================================================
// 2) 裁剪
// ============================================================

// 一组帧的内容并集包围盒。任何一帧伸出去的部分都得留在框内，
// 否则那一帧播到时会被切掉一块。
export function unionContentBBox(imgs, margin) {
  const { width: w, height: h } = imgs[0];
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const img of imgs) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (img.data[(y * w + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('图片全透明，没有可用内容');
  return [
    Math.max(0, x0 - margin), Math.max(0, y0 - margin),
    Math.min(w - 1, x1 + margin), Math.min(h - 1, y1 + margin),
  ];
}

export function cropToBBox(img, [x0, y0, x1, y1]) {
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = createImage(cw, ch);
  for (let y = 0; y < ch; y++) {
    const src = ((y + y0) * img.width + x0) * 4;
    out.data.set(img.data.subarray(src, src + cw * 4), y * cw * 4);
  }
  return out;
}

// 帧横向拼成一条。量化要在整条上做，各帧单独量化会让同一块颜色在帧间跳变。
export function packFramesRow(frames) {
  const fw = frames[0].width, fh = frames[0].height;
  const sheet = createImage(fw * frames.length, fh);
  frames.forEach((f, i) => {
    for (let y = 0; y < fh; y++) {
      const src = y * fw * 4;
      sheet.data.set(f.data.subarray(src, src + fw * 4), (y * sheet.width + i * fw) * 4);
    }
  });
  return sheet;
}

export function extractFrame(sheet, fw, fh, index) {
  const out = createImage(fw, fh);
  for (let y = 0; y < fh; y++) {
    const src = (y * sheet.width + index * fw) * 4;
    out.data.set(sheet.data.subarray(src, src + fw * 4), y * fw * 4);
  }
  return out;
}

export function cropToContent(img, margin) {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error('图片全透明，没有可用内容');
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin); y1 = Math.min(h - 1, y1 + margin);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = createImage(cw, ch);
  for (let y = 0; y < ch; y++) {
    const src = ((y + y0) * w + x0) * 4;
    out.data.set(data.subarray(src, src + cw * 4), y * cw * 4);
  }
  return { img: out, bbox: [x0, y0, x1, y1] };
}

// ============================================================
// 3) 五官定位（与颜色无关）
// ============================================================

export function detectFace(img, options = {}) {
  const { width: W, height: H } = img;
  const area = W * H;
  const maxCandidates = Number.isSafeInteger(options.maxCandidates) && options.maxCandidates > 0
    ? Math.min(512, options.maxCandidates) : 96;
  const maxPairEvaluations = Number.isSafeInteger(options.maxPairEvaluations) && options.maxPairEvaluations > 0
    ? Math.min(8192, options.maxPairEvaluations) : 2048;
  const { label, regions } = growRegions(img, 26, 115, Math.max(16, area * 0.0004));
  assertProcessingActive(options, '五官区域生长');
  if (regions.length < 3) return null;

  const byId = new Map(regions.map(r => [r.id, r]));

  // 五官候选：够小、够方、够实心，且长在上半身。
  // 眼睛在像素画里几乎总是一块与肤色截然不同的紧凑墨迹，区域生长会把它单独切出来。
  // 面积上限放到 10%：独眼角色就那么一只大眼，按 5% 卡会把它整个排除。
  // 人形角色的眼睛通常只占 1~3%，放宽不会把它们带偏。
  const candidates = regions.filter(r =>
    r.size >= area * 0.0008 && r.size <= area * 0.10 &&
    r.y0 < H * 0.55 &&
    r.w / r.h > 0.45 && r.w / r.h < 3.0 &&
    r.size / (r.w * r.h) > 0.38 &&
    r.w < W * 0.45
  );
  if (candidates.length > maxCandidates) {
    throw resourceError(`五官候选过多（${candidates.length}），最多 ${maxCandidates} 个`,
      'POPPET_FACE_CANDIDATE_LIMIT');
  }
  // 不能要求这里已有候选：极宽眼可能只会在后面的脸内局部切分中出现。

  // 每个候选的"宿主"：把它包起来的那个更大的区域。
  // 双眼必然共享同一个宿主（脸，或者脸所在的那一大片），头发上的零碎色块则不会。
  for (const [index, c] of candidates.entries()) {
    c.hostId = hostRegionOf(c, label, W, H, byId);
    if ((index & 31) === 31) assertProcessingActive(options, '五官宿主分析');
  }

  // 不在这里武断删除套娃。眼白里的瞳孔确实是内层，但有色镜片里的真眼也是内层；
  // 只按面积比删内层会把后者恰好删掉。下面以"左右两边都存在包含关系"和尺寸先验
  // 做成对的层级裁决，既保住镜片下的真眼，也不会把一对小高光当眼睛。

  // "共享宿主"对简单像素画很有效，但真实立绘里深色描边经常把一只眼睛一路连到
  // 头发、衣服和鞋，宿主就退化成整个人物。耳朵反而是两个干净小色块，于是旧算法会
  // 因为它们面积更大而选中耳朵。这里先找上半部的紧凑脸面，再在脸面自己的颜色坐标系
  // 中重新切眼睛；色相不参与判断，深肤浅眼和灰阶素材仍走同一条路径。
  const surfaces = faceSurfaceRegions(regions, W, H, area)
    .sort((a, b) => scoreFaceQuality(b, W, H) - scoreFaceQuality(a, W, H))
    .slice(0, 12);
  const pairs = [];
  const soloPools = [];
  const pairBudget = { evaluations: 0, max: maxPairEvaluations, options };
  const holeCache = new Map();
  const holesFor = host => {
    if (!holeCache.has(host.id)) holeCache.set(host.id, regionHoles(host, W, H));
    return holeCache.get(host.id);
  };

  for (const [surfaceIndex, host] of surfaces.entries()) {
    const local = localEyeCandidates(img, host, label);
    if (local.length > maxCandidates) {
      throw resourceError(`脸内五官候选过多（${local.length}），最多 ${maxCandidates} 个`,
        'POPPET_FACE_CANDIDATE_LIMIT');
    }
    // 全图区域生长得到的候选也要继承当前脸面的颜色上下文。某些浅色不透明镜片
    // 与肤色的距离不足以进入 local mask，却仍会作为完整实心区域出现在 candidates；
    // 若保留成无上下文的 shared 候选，同一几何的镜片风险会被 fallback 洗掉。
    // 这里克隆而不改写原对象，因为同一候选可能落入多个嵌套脸面。
    const inside = candidates.filter(c => candidateInsideSurface(c, host)).map(c => ({
      ...c,
      detectionSource: 'face-region',
      faceMean: local.faceMean,
      contrastThreshold: local.threshold || 42,
    }));
    const pool = limitEyePool(dedupeEyeCandidates([...local, ...inside]), host);
    if (!pool.length) continue;
    const holes = holesFor(host);
    soloPools.push({ host, pool, localThreshold: local.threshold || 42, holes });
    scorePairs(pool, host, img, area, local.threshold || 42, 'face-surface', pairs, holes, pairBudget);
    if ((surfaceIndex & 3) === 3) assertProcessingActive(options, '脸面候选分析');
  }

  // 兼容形态很宽或脸与身体同色、因而没有独立脸面的旧素材。这个回退只使用原来的
  // 共享宿主关系；巨型全身宿主会在 faceQuality 中被降权，不能再靠面积压过脸内真眼。
  const byHost = new Map();
  for (const c of candidates) {
    if (c.hostId == null) continue;
    if (!byHost.has(c.hostId)) byHost.set(c.hostId, []);
    byHost.get(c.hostId).push(c);
  }
  for (const [hostId, hostPool] of byHost) {
    const host = byId.get(hostId);
    if (!host) continue;
    const pool = limitEyePool(hostPool, host);
    const holes = holesFor(host);
    scorePairs(pool, host, img, area, 42, 'shared-host', pairs, holes, pairBudget);
    soloPools.push({ host, pool, localThreshold: 42, holes });
  }

  const ranked = rankDistinctPairs(pairs);
  const eligible = ranked.filter(p => p.lensRisk < 0.68);
  if (eligible.length) {
    const best = eligible[0];
    const rejectedAbove = ranked.find(p => p.lensRisk >= 0.68 && p.score >= best.score - 0.03);
    // 如果高分镜片/镜框候选包着一对更小的真眼，选内层真眼是有依据的；否则这是
    // "两只眼"和"一副眼镜"无法区分的输入，自动动画必须 fail-safe，而不是碰运气。
    if (!rejectedAbove || pairContainsPair(rejectedAbove, best)) {
      const rival = eligible.find((p, i) => i > 0 && !samePairGeometry(best, p));
      let confidence = best.score;
      if (rival && rival.score > best.score - 0.09) confidence *= 0.72;
      if (confidence >= 0.56) {
        return {
          eyes: [best.eyeL, best.eyeR], mouth: best.mouth, face: best.host,
          score: best.score, confidence: Number(confidence.toFixed(3)),
          ambiguous: Boolean(rival && rival.score > best.score - 0.09),
        };
      }
    }
  }

  // 有一对近似对称候选却因为镜片/桥接证据被拒绝时，不能再把其中一片降级成"独眼"。
  // 只有真的配不成对，才进入独眼/侧脸回退。
  if (ranked.some(p => p.lensRisk >= 0.68 && p.score >= 0.52)) return null;

  const solos = [];
  for (const { host, pool, localThreshold, holes } of soloPools) {
    for (const eye of pool) {
      // 一个大小/形状近似且横向分开的候选即使垂直错位，也说明这里存在未解决的双眼
      // 歧义。不能在 pair 门槛拒绝后悄悄把其中一只包装成高置信独眼。
      if (pool.some(other => other !== eye && plausibleUnpairedCompanion(eye, other, host))) continue;
      const mouth = pickMouth([eye], host, W, H, area, holes);
      const score = scoreSolo(eye, host, W, H, Boolean(mouth));
      if (score < 0.58) continue;
      solos.push({ eye, host, mouth, score, localThreshold });
    }
  }
  // 独眼没有"左右两副外框都包着内眼"这种眼镜证据。此时可见眼白包着瞳孔，
  // 动画语义应取整个外眼；只抠瞳孔会让眨眼像黑点上下跳。外层必须近似眼形且不是
  // 空心细框才提升，嘴/横桥和极薄单片框不会借此翻身。
  for (const outer of solos) for (const inner of solos) {
    if (outer === inner || outer.host.id !== inner.host.id || !rectContains(outer.eye, inner.eye)) continue;
    const fill = outer.eye.size / Math.max(1, outer.eye.w * outer.eye.h);
    const aspect = outer.eye.w / outer.eye.h;
    if (fill < 0.42 || aspect < 0.48 || aspect > 1.45 || outer.score < inner.score - 0.22) continue;
    outer.score = clamp01(outer.score + 0.045);
    inner.score = clamp01(inner.score - 0.18);
  }
  solos.sort((a, b) => b.score - a.score);
  const bestSolo = solos[0];
  if (!bestSolo) return null;
  const rivalSolo = solos.find((s, i) => i > 0 && blobIoU(s.eye, bestSolo.eye) < 0.55);
  let soloConfidence = bestSolo.score;
  if (rivalSolo && rivalSolo.score > bestSolo.score - 0.08) soloConfidence *= 0.7;
  if (soloConfidence < 0.58) return null;
  return {
    eyes: [bestSolo.eye], mouth: bestSolo.mouth, face: bestSolo.host, score: bestSolo.score,
    confidence: Number(soloConfidence.toFixed(3)), single: true,
    ambiguous: Boolean(rivalSolo && rivalSolo.score > bestSolo.score - 0.08),
  };
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

// 独立脸面通常占全图 1.2% 以上、位于上半部，而且不会从头一直贯穿到脚。
// 横向角色放宽到 90% 高，避免四足/横幅形态被直立人形先验排除。
function faceSurfaceRegions(regions, W, H, area) {
  // 只排除几乎从顶贯穿到底的"整个人物"宿主。裁剪后的圆形/史莱姆角色本来就会
  // 占到约九成高度；旧的 0.78 会把它的真实外脸删掉，反让内层眼白冒充脸面。
  const maxHeight = H * 0.92;
  const possible = regions.filter(r => {
    const fill = r.size / (r.w * r.h);
    const aspect = r.w / r.h;
    return r.size >= Math.max(20, area * 0.012) && r.size <= area * 0.72 &&
      r.y0 < H * 0.58 && r.h <= maxHeight &&
      aspect > 0.28 && aspect < 4.8 && fill > 0.18;
  });
  // 镜框/墨镜自身也可能是一个够大的紧凑区域，但它被真正脸面完整包含。让这种内层
  // 区域再次充当"脸色"会把鼻梁或镜片缝隙反向识别成眼睛，因此只保留外层脸面。
  return possible.filter(r => !possible.some(outer => outer !== r &&
    outer.size > r.size * 1.8 &&
    r.cx > outer.x0 && r.cx < outer.x1 && r.cy > outer.y0 && r.cy < outer.y1 &&
    r.w < outer.w * 0.82 && r.h < outer.h * 0.82));
}

function candidateInsideSurface(c, host) {
  const nx = (c.cx - host.x0) / Math.max(1, host.w);
  const ny = (c.cy - host.y0) / Math.max(1, host.h);
  return nx > 0.025 && nx < 0.975 && ny > 0.12 && ny < 0.73 &&
    c.w < host.w * 0.49 && c.h < host.h * 0.45;
}

// 在脸面代表色之外做局部连通域。裁在脸面的内侧是刻意的：若眼睛的黑描边与头发
// 相连，整图连通域会吞到衣服；局部窗口会在脸缘的狭窄连接处把它切开。
function localEyeCandidates(img, host, label) {
  const { width: W, height: H, data } = img;
  const mean = [0, 0, 0];
  for (const c of host.cells) {
    const i = c * 4;
    mean[0] += data[i]; mean[1] += data[i + 1]; mean[2] += data[i + 2];
  }
  for (let k = 0; k < 3; k++) mean[k] /= host.size;

  // 用脸面内部自己的色差尾部决定阈值。阈值只决定"离脸色够不够远"，没有肤色、
  // 眼色或某张素材的 RGB 常量；p90 后再留 28 的安全带，能排除脸部渐变、腮红尾部
  // 和浅色镜片，同时让高对比的瞳孔/描边留下来。
  const deviationHistogram = new Uint32Array(256);
  for (const c of host.cells) {
    const i = c * 4;
    const d = Math.min(255, Math.floor(colorDistance(
      data[i], data[i + 1], data[i + 2], mean[0], mean[1], mean[2])));
    deviationHistogram[d]++;
  }
  const percentileTarget = Math.max(1, Math.ceil(host.size * 0.90));
  let accumulated = 0, p90 = 0;
  for (; p90 < deviationHistogram.length; p90++) {
    accumulated += deviationHistogram[p90];
    if (accumulated >= percentileTarget) break;
  }
  const threshold = Math.max(38, Math.min(78, p90 + 28));

  const insetX = Math.max(1, Math.round(host.w * 0.04));
  const x0 = Math.max(0, host.x0 + insetX);
  const x1 = Math.min(W - 1, host.x1 - insetX);
  const y0 = Math.max(0, Math.round(host.y0 + host.h * 0.12));
  const y1 = Math.min(H - 1, Math.round(host.y0 + host.h * 0.73));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < 3 || h < 3) {
    const empty = [];
    empty.threshold = threshold;
    empty.faceMean = mean;
    return empty;
  }
  const mask = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const gi = y * W + x, i = gi * 4;
    if (data[i + 3] === 0 || label[gi] === host.id) continue;
    if (colorDistance(data[i], data[i + 1], data[i + 2], mean[0], mean[1], mean[2]) >= threshold) {
      mask[(y - y0) * w + x - x0] = 1;
    }
  }

  const minSize = Math.max(4, Math.floor(host.w * host.h * 0.0015));
  const maxSize = host.w * host.h * 0.16;
  const blobs = labelBlobs(mask, w, h, minSize).map(b => ({
    ...b,
    x0: b.x0 + x0, x1: b.x1 + x0, y0: b.y0 + y0, y1: b.y1 + y0,
    cx: b.cx + x0, cy: b.cy + y0,
    cells: b.cells.map(c => (((c / w) | 0) + y0) * W + (c % w) + x0),
    detectionSource: 'face-contrast', faceMean: mean, contrastThreshold: threshold,
  })).filter(b => {
    const fill = b.size / (b.w * b.h);
    const aspect = b.w / b.h;
    return b.size <= maxSize && fill > 0.28 && aspect > 0.32 && aspect < 3.0 &&
      b.w < host.w * 0.49 && b.h < host.h * 0.45;
  });
  blobs.threshold = threshold;
  blobs.faceMean = mean;
  return blobs;
}

function dedupeEyeCandidates(candidates) {
  const out = [];
  for (const c of candidates.sort((a, b) => (a.detectionSource ? -1 : 1) - (b.detectionSource ? -1 : 1))) {
    if (out.some(o => blobIoU(o, c) > 0.72)) continue;
    out.push(c);
  }
  return out;
}

// 两两评分天然是 O(n²)。候选很多时先用不涉及洞分析的廉价几何先验截到固定规模，
// 并在左/中/右三栏各保留名额，避免侧脸或位于身体一端的四足脸被居中候选挤掉。
function limitEyePool(pool, host, limit = 24) {
  if (pool.length <= limit) return pool;
  const ranked = pool.map(eye => {
    const areaRatio = eye.size / Math.max(1, host.w * host.h);
    const size = Math.exp(-0.5 * (Math.log(Math.max(0.0001, areaRatio) / 0.035) / 1.05) ** 2);
    const yNorm = (eye.cy - host.y0) / Math.max(1, host.h);
    const vertical = clamp01(1 - Math.abs(yNorm - 0.40) / 0.38);
    const fill = clamp01((eye.size / (eye.w * eye.h) - 0.25) / 0.60);
    return { eye, score: size * 0.48 + vertical * 0.34 + fill * 0.13 +
      (eye.detectionSource === 'face-contrast' ? 0.05 : 0) };
  }).sort((a, b) => b.score - a.score);
  const thirds = [[], [], []];
  for (const item of ranked) {
    const nx = (item.eye.cx - host.x0) / Math.max(1, host.w);
    thirds[nx < 0.40 ? 0 : nx > 0.60 ? 2 : 1].push(item.eye);
  }
  const out = [];
  for (const group of thirds) out.push(...group.slice(0, 8));
  return out.slice(0, limit);
}

function blobIoU(a, b) {
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  if (x1 < x0 || y1 < y0) return 0;
  const intersection = (x1 - x0 + 1) * (y1 - y0 + 1);
  return intersection / (a.w * a.h + b.w * b.h - intersection);
}

function scorePairs(pool, host, img, area, threshold, source, out, holes, budget) {
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    if (++budget.evaluations > budget.max) {
      throw resourceError(`五官候选组合过多（超过 ${budget.max} 组）`, 'POPPET_FACE_PAIR_LIMIT');
    }
    if ((budget.evaluations & 63) === 0) assertProcessingActive(budget.options, '五官候选配对');
    const [a, b] = pool[i].cx <= pool[j].cx ? [pool[i], pool[j]] : [pool[j], pool[i]];
    // 两个小块若同时落在同一个更大的可见眼内，是高光/瞳孔结构，不是两只眼。
    if (pool.some(container => container !== a && container !== b &&
      rectContains(container, a) && rectContains(container, b))) continue;
    const dy = Math.abs(a.cy - b.cy), maxH = Math.max(a.h, b.h);
    const ratio = a.size / b.size;
    if (ratio < 0.28 || ratio > 3.6) continue;
    const sizeBalance = Math.min(a.size, b.size) / Math.max(a.size, b.size);
    const aspectA = a.w / a.h, aspectB = b.w / b.h;
    const aspectBalance = Math.min(aspectA, aspectB) / Math.max(aspectA, aspectB);
    // 普通双眼要求较齐平；若两块大小和形状都高度一致，允许一个眼高以内的倾斜。
    // profile 内耳与真眼虽然 dy 接近，但 size/aspect 不匹配，仍不会组成双眼。
    const matchedTilt = sizeBalance >= 0.75 && aspectBalance >= 0.75 && dy <= maxH;
    if (dy > maxH * 0.70 && !matchedTilt) continue;
    const gap = b.cx - a.cx;
    if (gap < Math.max(a.w, b.w) * 0.55 || gap > host.w * 0.88) continue;
    const leftPos = (a.cx - host.x0) / Math.max(1, host.w);
    const rightPos = (b.cx - host.x0) / Math.max(1, host.w);
    // 两个候选分别贴着脸面的最左/最右缘且跨越大半张脸，是内耳而不是眼睛的强证据。
    // 这条与嘴是否存在无关，无嘴角色不会再因缺少 mouth bonus 而退回双耳。
    if (leftPos < 0.13 && rightPos > 0.87 && gap > host.w * 0.65) continue;
    const mid = (a.cx + b.cx) / 2;
    const offCenter = Math.abs(mid - (host.x0 + host.x1) / 2) / Math.max(1, host.w);
    if (offCenter > 0.55) continue; // 四足的脸可以在身体一端，不能用人形的 0.32 硬卡

    const avgAreaRatio = Math.sqrt(a.size * b.size) / Math.max(1, host.w * host.h);
    const sizeScore = Math.exp(-0.5 * (Math.log(Math.max(0.0001, avgAreaRatio) / 0.035) / 1.0) ** 2);
    const alignScore = clamp01(1 - dy / Math.max(1, maxH * 1.25));
    const similarityScore = Math.exp(-Math.abs(Math.log(ratio)) * 0.65);
    const centerScore = clamp01(1 - offCenter / 0.55);
    const yNorm = (((a.cy + b.cy) / 2) - host.y0) / Math.max(1, host.h);
    const verticalScore = clamp01(1 - Math.abs(yNorm - 0.40) / 0.34);
    const spacing = gap / Math.max(1, host.w);
    const spacingScore = clamp01(1 - Math.abs(spacing - 0.40) / 0.38);
    const faceQuality = scoreFaceQuality(host, img.width, img.height);
    const mouth = pickMouth([a, b], host, img.width, img.height, area, holes);
    const mouthScore = mouth ? 1 : 0.52;
    const lensRisk = scoreLensRisk(a, b, host, img, threshold);

    // 面积只占一项且在约 3.5% 处达峰：更大不再自动更好。这样耳朵和镜片不能
    // 单凭像素多获胜，极小高光也会因非单调尺寸先验被压下去。
    let baseScore = alignScore * 0.18 + similarityScore * 0.14 + sizeScore * 0.16 +
      centerScore * 0.10 + verticalScore * 0.12 + spacingScore * 0.10 +
      faceQuality * 0.10 + mouthScore * 0.10;
    if (source === 'face-surface') baseScore += 0.035;
    baseScore = clamp01(baseScore);
    const score = clamp01(baseScore - lensRisk * 0.34);
    out.push({ score, baseScore, eyeL: a, eyeR: b, host, mouth, lensRisk, source });
  }
}

function plausibleUnpairedCompanion(a, b, host) {
  const maxH = Math.max(a.h, b.h);
  const sizeBalance = Math.min(a.size, b.size) / Math.max(a.size, b.size);
  const aspectA = a.w / a.h, aspectB = b.w / b.h;
  const aspectBalance = Math.min(aspectA, aspectB) / Math.max(aspectA, aspectB);
  const gap = Math.abs(a.cx - b.cx);
  return sizeBalance >= 0.75 && aspectBalance >= 0.72 &&
    gap >= Math.max(a.w, b.w) * 0.55 && gap <= host.w * 0.88 &&
    Math.abs(a.cy - b.cy) <= maxH * 1.8;
}

function scoreFaceQuality(host, W, H) {
  const heightRatio = host.h / H;
  const fill = host.size / Math.max(1, host.w * host.h);
  const upper = clamp01(1 - Math.max(0, host.y0 / H - 0.30) / 0.35);
  const compact = heightRatio <= 0.78 ? 1 : clamp01(1 - (heightRatio - 0.78) / 0.22);
  return clamp01(upper * 0.35 + compact * 0.45 + clamp01(fill / 0.45) * 0.20);
}

function scoreLensRisk(a, b, host, img, threshold) {
  const spanRatio = (b.x1 - a.x0 + 1) / Math.max(1, host.w);
  const widePair = a.w / a.h > 1.25 && b.w / b.h > 1.25 && spanRatio > 0.56;
  const bridge = contrastBridgeRatio(a, b, img, threshold);
  // 两侧区域都被同一个、且不是当前脸面的外层区域包围，是镜框/护目镜的结构证据。
  // 普通眼白直接长在脸面上，hostId 会等于 host.id；不依赖镜片明暗或具体颜色。
  const sharedEyewearHost = a.hostId != null && a.hostId === b.hostId && a.hostId !== host.id;
  const boxArea = Math.max(1, host.w * host.h);
  const largeUniform = [a, b].every(e =>
    e.size / boxArea > 0.052 && e.size / (e.w * e.h) > 0.78 &&
    e.h / img.height > 0.105 && featureColorCount(e, img, threshold) <= 2);
  // 宽眼是合法画风；aspect/span 单独只能算很弱的先验。只有桥接、异常大的均匀
  // 实心镜片，或后续检测到双侧包含层级时，才足以拒绝自动眨眼。
  return Math.max(widePair ? 0.12 : 0, sharedEyewearHost ? 0.78 : 0,
    bridge > 0.42 ? 0.92 : bridge * 0.8,
    largeUniform ? 0.80 : 0);
}

function contrastBridgeRatio(a, b, img, threshold) {
  const x0 = Math.ceil(a.x1 + 1), x1 = Math.floor(b.x0 - 1);
  if (x1 < x0) return 1;
  const mean = a.faceMean || b.faceMean;
  if (!mean) return 0;
  const y = Math.round((a.cy + b.cy) / 2);
  let hits = 0, seen = 0;
  for (let yy = Math.max(0, y - 1); yy <= Math.min(img.height - 1, y + 1); yy++) {
    for (let x = x0; x <= x1; x++) {
      const i = (yy * img.width + x) * 4;
      if (img.data[i + 3] === 0) continue;
      seen++;
      if (colorDistance(img.data[i], img.data[i + 1], img.data[i + 2], mean[0], mean[1], mean[2]) >= threshold) hits++;
    }
  }
  return seen ? hits / seen : 0;
}

function featureColorCount(blob, img, threshold) {
  const mean = blob.faceMean;
  if (!mean) return 4; // 旧共享宿主候选没有局部脸色证据，不能据此武断判成墨镜
  const colors = new Set();
  for (let y = blob.y0; y <= blob.y1 && colors.size <= 3; y++) for (let x = blob.x0; x <= blob.x1; x++) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] === 0) continue;
    if (colorDistance(img.data[i], img.data[i + 1], img.data[i + 2], mean[0], mean[1], mean[2]) < threshold) continue;
    // 量化后仍用 4bit/channel 合桶，抗锯齿产生的一两个近邻色不会伪造"可见瞳孔"。
    colors.add(((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4));
  }
  return colors.size;
}

function rankDistinctPairs(pairs) {
  // 若外框里还有一对几何合理的内层眼睛，外框必须降权；这是厚框/有色镜片场景
  // 最直接的层级证据。只有外层已经有镜框/镜片证据才下钻；否则普通眼白包瞳孔时
  // 仍应保留完整语义眼。只在左右两边都包含时生效，单个高光也不会触发。
  for (const outer of pairs) {
    if (outer.lensRisk < 0.68) continue;
    // 用未扣 lensRisk 的几何/位置基础分比较。若用最终 score，恰恰会让镜片间像素
    // 造成的 bridge 误罚阻止真眼下钻，细框场景会反选整个镜片区域。
    const nested = pairs.filter(inner => inner !== outer && credibleNestedPair(outer, inner) &&
      inner.baseScore > outer.baseScore - 0.25);
    if (!nested.length) continue;
    outer.baseScore = clamp01(outer.baseScore - 0.18);
    outer.lensRisk = Math.max(outer.lensRisk, 0.72);
    outer.score = clamp01(outer.baseScore - outer.lensRisk * 0.34);
    // 镜片之间的色块可能横穿真眼 pair 的中线，让 bridge 启发式误伤内眼。
    // 双侧均被同一已确认眼镜外层包含时，这一层级证据比局部 bridge 更可靠。
    for (const inner of nested) {
      inner.lensRisk = Math.min(inner.lensRisk, 0.22);
      inner.score = clamp01(inner.baseScore - inner.lensRisk * 0.34);
    }
  }

  // 同一几何会同时从脸内对比和旧 shared-host 路径进入。旧实现先按 score 排序再去重，
  // 于是 shared-host 的 risk=0 副本会洗掉本地已确认的墨镜风险。这里先分组：保留更有
  // 局部脸色证据的几何，同时传播整组最大风险，再统一重算最终分数。
  const distinct = [];
  for (const pair of pairs) {
    const existing = distinct.find(item => samePairGeometry(item, pair));
    if (!existing) {
      distinct.push({ ...pair });
      continue;
    }
    const preferPair = pair.source === 'face-surface' && existing.source !== 'face-surface';
    const geometry = preferPair ? pair : existing;
    const mergedRisk = Math.max(existing.lensRisk, pair.lensRisk);
    const mergedBase = Math.max(existing.baseScore, pair.baseScore);
    Object.assign(existing, geometry, {
      lensRisk: mergedRisk,
      baseScore: mergedBase,
      score: clamp01(mergedBase - mergedRisk * 0.34),
      source: existing.source === pair.source ? existing.source : 'merged',
    });
  }
  return distinct.sort((a, b) => b.score - a.score);
}

function rectContains(outer, inner) {
  const slack = Math.max(1, Math.round(Math.min(outer.w, outer.h) * 0.08));
  return inner.cx >= outer.x0 - slack && inner.cx <= outer.x1 + slack &&
    inner.cy >= outer.y0 - slack && inner.cy <= outer.y1 + slack &&
    inner.w * inner.h < outer.w * outer.h * 0.82;
}

function pairContainsPair(outer, inner) {
  return rectContains(outer.eyeL, inner.eyeL) && rectContains(outer.eyeR, inner.eyeR);
}

function credibleNestedPair(outer, inner) {
  if (!pairContainsPair(outer, inner)) return false;
  // 高光虽也被眼框包含，但面积远小于语义眼；镜片下的可见真眼在两侧都会占据
  // 外框至少约 14%。双侧同时满足才是可用于下钻的眼镜层级证据。
  return inner.eyeL.w * inner.eyeL.h >= outer.eyeL.w * outer.eyeL.h * 0.14 &&
    inner.eyeR.w * inner.eyeR.h >= outer.eyeR.w * outer.eyeR.h * 0.14;
}

function samePairGeometry(a, b) {
  return blobIoU(a.eyeL, b.eyeL) > 0.58 && blobIoU(a.eyeR, b.eyeR) > 0.58;
}

function scoreSolo(eye, host, W, H, hasMouth) {
  const areaRatio = eye.size / Math.max(1, host.w * host.h);
  if (areaRatio < 0.004 || areaRatio > 0.16) return 0;
  // 单只语义眼可以很大（独眼），但不会是一条横跨脸部的桥或嘴。没有第二只眼提供
  // 层级证据时，对宽条形候选必须保守拒绝。
  if (eye.w / eye.h > 1.24) return 0;
  const yNorm = (eye.cy - host.y0) / Math.max(1, host.h);
  if (yNorm < 0.13 || yNorm > 0.70) return 0;
  // 单眼应位于脸面像素质心上方或附近；只有嘴的素材通常恰好在质心下方。
  // 这比用绝对 y 更适合侧脸、圆形独眼和不同头身比。
  if (eye.cy > host.cy + host.h * 0.035) return 0;
  const size = Math.exp(-0.5 * (Math.log(areaRatio / 0.045) / 1.05) ** 2);
  const vertical = clamp01(1 - Math.abs(yNorm - 0.39) / 0.35);
  const fill = clamp01((eye.size / (eye.w * eye.h) - 0.25) / 0.55);
  const quality = scoreFaceQuality(host, W, H);
  const nx = (eye.cx - host.x0) / Math.max(1, host.w);
  const edge = clamp01(Math.min(nx, 1 - nx) / 0.22);
  return clamp01(size * 0.32 + vertical * 0.24 + fill * 0.13 + quality * 0.18 +
    edge * 0.10 + (hasMouth ? 0.07 : 0) +
    (eye.detectionSource === 'face-contrast' ? 0.02 : 0));
}

// 嘴：取宿主区域的"洞"，位置要在眼睛下方、横向落在眼睛张成的范围里。
// 用洞而不是候选区域——嘴唇常有深浅两层，区域生长会把它切成两块，作为洞才完整。
function pickMouth(eyes, host, W, H, area, precomputedHoles = null) {
  if (!host || !eyes.length) return null;
  const eyeBottom = Math.max(...eyes.map(e => e.y1));
  const eyeH = Math.max(...eyes.map(e => e.h));
  const left = Math.min(...eyes.map(e => e.cx));
  const right = Math.max(...eyes.map(e => e.cx));
  // 只有一只眼时没有"两眼之间"可言，就以这只眼为中心放宽到脸宽的一半
  const span = eyes.length > 1 ? right - left : host.w * 0.5;
  const lo = eyes.length > 1 ? left + span * 0.1 : left - span;
  const hi = eyes.length > 1 ? right - span * 0.1 : right + span;
  const eyeSize = eyes.reduce((s, e) => s + e.size, 0);

  return (precomputedHoles || regionHoles(host, W, H))
    .filter(hole =>
      hole.size >= Math.max(12, area * 0.0003) && hole.size < eyeSize * 0.8 &&
      hole.cy > eyeBottom - eyeH * 0.25 &&
      (eyes.length > 1 || hole.cy > eyeBottom + eyeH * 0.35) &&
      hole.cy < eyeBottom + span * 1.2 &&
      hole.cx > lo && hole.cx < hi &&
      hole.w / hole.h > 0.3 && hole.w / hole.h < 4 &&
      !eyes.some(e => hole.cx >= e.x0 && hole.cx <= e.x1 && hole.cy >= e.y0 && hole.cy <= e.y1)
    )
    .sort((p, q) => q.size - p.size)[0] || null;
}

// 候选区域外围一圈上出现最多的其它区域，即把它包住的那块
function hostRegionOf(region, label, W, H, byId) {
  const counts = new Map();
  for (const c of region.cells) {
    const cx = c % W, cy = (c / W) | 0;
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const id = label[ny * W + nx];
      if (id === -1 || id === region.id) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  let bestId = null, bestN = 0;
  for (const [id, n] of counts) {
    const host = byId.get(id);
    if (!host) continue;
    // 实心脸面的像素数通常比五官多；但细镜框是一圈像素很少、包围盒却完整包住
    // 镜片窗口的环。只看 size 会漏掉这种真实几何宿主，并把窗口误当语义眼。
    const encloses = host.x0 <= region.x0 && host.x1 >= region.x1 &&
      host.y0 <= region.y0 && host.y1 >= region.y1 &&
      region.w * region.h < host.w * host.h * 0.82;
    if (host.size <= region.size && !encloses) continue;
    if (n > bestN) { bestN = n; bestId = id; }
  }
  return bestId;
}

// ============================================================
// 4) 部件遮罩 / 抠图 / 背景板
// ============================================================

// 闭运算（膨胀→填洞→腐蚀）把眼眶的细缝封上，让眼白这种"开口朝外的空腔"也算进遮罩。
//
// 最后还要外扩 grow 圈：下采样会在墨迹与肤色之间留下一圈中间色，它既不属于眼睛
// 也不属于脸，遮罩若严格贴着团块边界，擦除后就会剩一圈黑色虚线轮廓。
export function solidMask(blob, imgW, pad = 3, closeRadius = 2, grow = 1) {
  const x0 = blob.x0 - pad, y0 = blob.y0 - pad;
  const mw = blob.w + pad * 2, mh = blob.h + pad * 2;
  let mask = new Uint8Array(mw * mh);
  for (const c of blob.cells) {
    const mx = (c % imgW) - x0, my = ((c / imgW) | 0) - y0;
    if (mx >= 0 && my >= 0 && mx < mw && my < mh) mask[my * mw + mx] = 1;
  }
  const raw = mask.slice();
  for (let i = 0; i < closeRadius; i++) mask = dilate(mask, mw, mh);
  const holes = fillHoles(mask, mw, mh);
  for (let i = 0; i < closeRadius; i++) mask = erode(mask, mw, mh);
  for (let i = 0; i < mask.length; i++) if (raw[i]) mask[i] = 1; // 腐蚀削掉的细枝补回来
  for (let i = 0; i < grow; i++) mask = dilate(mask, mw, mh);
  fillHoles(mask, mw, mh);
  return { mask, x: x0, y: y0, w: mw, h: mh, holes };
}

export function extractPart(img, m) {
  const out = createImage(m.w, m.h);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (!m.mask[y * m.w + x]) continue;
    const gx = m.x + x, gy = m.y + y;
    if (gx < 0 || gy < 0 || gx >= img.width || gy >= img.height) continue;
    const si = (gy * img.width + gx) * 4, di = (y * m.w + x) * 4;
    out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1];
    out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
  }
  return out;
}

// 遮罩外 1..ring 圈里出现最多的颜色 —— "这块被五官盖住的地方，本来是什么底色"。
function dominantRingColor(img, m, ring = 3) {
  const pad = ring + 1;
  const sw = m.w + pad * 2, sh = m.h + pad * 2;
  let cur = new Uint8Array(sw * sh);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (m.mask[y * m.w + x]) cur[(y + pad) * sw + (x + pad)] = 1;
  }
  const counts = new Map();
  for (let r = 0; r < ring; r++) {
    const next = dilate(cur, sw, sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      if (!next[i] || cur[i]) continue;
      const gx = m.x - pad + x, gy = m.y - pad + y;
      if (gx < 0 || gy < 0 || gx >= img.width || gy >= img.height) continue;
      const gi = (gy * img.width + gx) * 4;
      if (img.data[gi + 3] === 0) continue;
      const key = (img.data[gi] << 16) | (img.data[gi + 1] << 8) | img.data[gi + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    cur = next;
  }
  if (!counts.size) return null;
  let bestKey = 0, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k; }
  return [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255];
}

// 背景板：把遮罩区域整块平涂成环带主导色。
//
// 试过 Laplacian 调和插值和多方向扫描线插值，都不行——前者远离边界处褪成灰白，
// 后者留下十字网格纹。根因是脸颊本就近乎单色，插值出的零点几度差异会被调色板
// 量化放大成可见色块。像素画是平涂的，平涂才是对的答案。
export function inpaintPatch(img, m, palette) {
  const ring = dominantRingColor(img, m);
  const base = ring ? nearestPaletteColor(ring, palette) : [255, 255, 255];
  const out = createImage(m.w, m.h);
  let filled = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const di = (y * m.w + x) * 4;
    const gx = m.x + x, gy = m.y + y;
    const inside = gx >= 0 && gy >= 0 && gx < img.width && gy < img.height;
    const si = inside ? (gy * img.width + gx) * 4 : -1;
    if (!m.mask[y * m.w + x]) {
      if (!inside) continue;
      out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
      continue;
    }
    // 遮罩是膨胀出来的，可能越过角色剪影。原本透明的地方必须保持透明，
    // 否则背景板会把不透明底色画到轮廓外，眨眼时角色旁边闪出一块实色方块。
    if (si < 0 || img.data[si + 3] === 0) { out.data[di + 3] = 0; continue; }
    out.data[di] = base[0]; out.data[di + 1] = base[1]; out.data[di + 2] = base[2]; out.data[di + 3] = 255;
    filled++;
  }
  return { img: out, filled, base };
}

// ============================================================
// 5) 图集打包
// ============================================================

export function packAtlas(entries, gap = 2) {
  if (!entries.length) return { atlas: createImage(1, 1), frames: {} };
  const totalW = entries.reduce((s, e) => s + e.img.width + gap, gap);
  const maxH = Math.max(...entries.map(e => e.img.height)) + gap * 2;
  const atlas = createImage(totalW, maxH);
  let cx = gap;
  const frames = {};
  for (const e of entries) {
    for (let y = 0; y < e.img.height; y++) {
      const src = y * e.img.width * 4;
      atlas.data.set(e.img.data.subarray(src, src + e.img.width * 4), ((y + gap) * totalW + cx) * 4);
    }
    frames[e.name] = { sx: cx, sy: gap, sw: e.img.width, sh: e.img.height };
    cx += e.img.width + gap;
  }
  return { atlas, frames };
}

// ============================================================
// 6) 主流程
// ============================================================

// source: { width, height, data } RGBA，或者一组同尺寸的帧（GIF / sprite sheet 拆出来的）。
// 多帧时所有帧必须共用同一个裁剪框和同一份调色板，否则播放起来会逐帧抖动、还会变色。
// options.features: { eyes: [矩形...], mouth: 矩形 } 精灵坐标系，用于覆盖自动检测
export function buildCharacter(source, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const report = { steps: [], warnings: [] };
  const inputs = Array.isArray(source) ? source : [source];
  if (!inputs.length) throw new Error('没有可用的帧');
  const maxFrames = Math.min(DEFAULTS.maxFrames,
    Number.isSafeInteger(opt.maxFrames) && opt.maxFrames > 0 ? opt.maxFrames : DEFAULTS.maxFrames);
  const maxFramePixels = Math.min(DEFAULTS.maxSourcePixels,
    Number.isSafeInteger(opt.maxSourcePixels) && opt.maxSourcePixels > 0 ? opt.maxSourcePixels : DEFAULTS.maxSourcePixels);
  const maxTotalPixels = Math.min(DEFAULTS.maxTotalSourcePixels,
    Number.isSafeInteger(opt.maxTotalSourcePixels) && opt.maxTotalSourcePixels > 0
      ? opt.maxTotalSourcePixels : DEFAULTS.maxTotalSourcePixels);
  const maxDimension = Math.min(DEFAULTS.maxSourceDimension,
    Number.isSafeInteger(opt.maxSourceDimension) && opt.maxSourceDimension > 0
      ? opt.maxSourceDimension : DEFAULTS.maxSourceDimension);
  const maxOpaqueRuns = Math.min(DEFAULTS.maxOpaqueRuns,
    Number.isSafeInteger(opt.maxOpaqueRuns) && opt.maxOpaqueRuns > 0
      ? opt.maxOpaqueRuns : DEFAULTS.maxOpaqueRuns);
  const maxWorkingPixels = Math.min(DEFAULTS.maxWorkingPixels,
    Number.isSafeInteger(opt.maxWorkingPixels) && opt.maxWorkingPixels > 0
      ? opt.maxWorkingPixels : DEFAULTS.maxWorkingPixels);
  opt.maxOpaqueRuns = maxOpaqueRuns;
  opt.maxWorkingPixels = maxWorkingPixels;
  if (inputs.length > maxFrames) throw resourceError(`帧数太多（${inputs.length}），最多 ${maxFrames} 帧`);
  const multi = inputs.length > 1;

  const first = inputs[0];
  let totalPixels = 0;
  for (const [index, frame] of inputs.entries()) {
    if (!frame || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
        || frame.width < 1 || frame.height < 1) throw resourceError(`第 ${index + 1} 帧尺寸无效`);
    if (frame.width > maxDimension || frame.height > maxDimension) {
      throw resourceError(`第 ${index + 1} 帧边长太大（${frame.width}x${frame.height}）`);
    }
    const pixels = frame.width * frame.height;
    if (!Number.isSafeInteger(pixels) || pixels > maxFramePixels) {
      throw resourceError(`第 ${index + 1} 帧太大（${frame.width}x${frame.height}），请先缩小`);
    }
    if (!frame.data || typeof frame.data.length !== 'number' || frame.data.length < pixels * 4) {
      throw resourceError(`第 ${index + 1} 帧像素数据不完整`);
    }
    totalPixels += pixels;
    if (totalPixels > maxTotalPixels) {
      throw resourceError(`所有帧总像素太多（${totalPixels}），最多 ${maxTotalPixels}`);
    }
  }
  if (multi && inputs.some(f => f.width !== first.width || f.height !== first.height)) {
    throw new Error('多帧素材的每一帧尺寸必须一致');
  }
  assertProcessingActive(opt, '开始');
  if (!multi) assertOpaqueRunBudget(first, opt);

  // 逐帧主体提取。默认实现仍是原来的本地 alpha/chroma 算法；现在通过明确契约
  // 隔离，后续高级模型只能作为可选 adapter 接入，不能偷偷改变默认输出。
  // extractSubject owns its output and validates that ownership at the adapter
  // boundary, so cloning here as well would retain a second full source copy.
  assertProcessingActive(opt, '主体提取');
  const extraction = extractSubject(inputs[0], opt);
  const works = [extraction.image];
  const bg = extraction.decision;
  let removedTotal = bg.removed;
  for (let i = 1; i < inputs.length; i++) {
    assertProcessingActive(opt, `去背 ${i + 1}/${inputs.length}`);
    const frameExtraction = extractSubject(inputs[i], opt, bg);
    works.push(frameExtraction.image);
    removedTotal += frameExtraction.decision.removed;
  }
  report.steps.push(`去背：${bg.mode}${bg.reason ? '（' + bg.reason + '）' : ''}，清除 ${removedTotal} 像素`
    + (multi ? `（${works.length} 帧共用同一套判定）` : ''));
  report.warnings.push(...extraction.warnings);

  // 单帧才做"只留最大连通域"：多帧动画里手脚可能瞬间与身体分离，
  // 逐帧清理会把它们抹掉，反而闪烁。
  if (!multi) {
    // 去背本身会改变 alpha 拓扑；原图全不透明并不代表去背后不会形成海量孤岛。
    assertOpaqueRunBudget(works[0], { ...opt, alphaThreshold: 1 });
    const comp = keepLargestOpaqueComponent(works[0]);
    if (comp.removed) report.steps.push(`保留主体连通域，清除杂散 ${comp.removed} 像素`);
  }

  // 并集包围盒：任何一帧伸出去的部分都要留在框内，否则那一帧会被切掉
  const bbox = unionContentBBox(works, opt.margin);
  const cropped = works.map(w => cropToBBox(w, bbox));
  assertProcessingActive(opt, '裁剪');
  report.steps.push(`裁剪到 ${cropped[0].width}x${cropped[0].height}` + (multi ? '（所有帧共用一个框）' : ''));

  const pixelize = normalizePixelizeOptions(opt.pixelize);
  let scaled;
  let palette;
  let pixelizeMeta;
  if (pixelize.enabled) {
    const output = pixelizeFrames(cropped, pixelize, { maxWorkingPixels });
    scaled = output.frames;
    palette = output.palette;
    pixelizeMeta = output.metadata;
    report.steps.push(`本地像素化：${pixelize.preset}，${scaled[0].width}x${scaled[0].height}，${palette.length} 色`);
  } else {
    // 保留旧路径逐句不变：关闭像素化时，现有用户的输出字节与行为不能漂移。
    const requestedTargetHeight = Number.isSafeInteger(opt.targetHeight) && opt.targetHeight > 0
      ? Math.min(opt.targetHeight, DEFAULTS.targetHeight) : DEFAULTS.targetHeight;
    let targetH = Math.min(requestedTargetHeight, cropped[0].height);
    let targetW = Math.max(1, Math.round(cropped[0].width * (targetH / cropped[0].height)));
    const desiredWorkingPixels = targetW * targetH * inputs.length;
    if (desiredWorkingPixels > maxWorkingPixels) {
      const factor = Math.sqrt(maxWorkingPixels / desiredWorkingPixels);
      targetW = Math.max(1, Math.floor(targetW * factor));
      targetH = Math.max(1, Math.floor(targetH * factor));
      report.steps.push(`工作像素预算：等比缩小到 ${targetW}x${targetH}`);
    }
    const workingPixels = targetW * targetH * inputs.length;
    if (!Number.isSafeInteger(workingPixels) || workingPixels > maxWorkingPixels) {
      throw resourceError(`处理工作集过大（${workingPixels}），最多 ${maxWorkingPixels} 像素`);
    }
    scaled = cropped.map(c =>
      (targetH === c.height && targetW === c.width) ? c : downsampleTo(c, targetW, targetH));
    const sheetForPalette = multi ? packFramesRow(scaled) : scaled[0];
    if (sheetForPalette.width * sheetForPalette.height > maxWorkingPixels) {
      throw resourceError(`量化工作集过大（${sheetForPalette.width * sheetForPalette.height}），最多 ${maxWorkingPixels} 像素`);
    }
    palette = quantize(sheetForPalette, opt.paletteSize);
    // The old path quantizes this exact object; reuse it below instead of packing twice.
    scaled = multi
      ? Array.from({ length: scaled.length }, (_, index) => extractFrame(sheetForPalette, scaled[0].width, scaled[0].height, index))
      : [sheetForPalette];
    pixelizeMeta = {
      ...pixelize,
      width: scaled[0].width,
      height: scaled[0].height,
      colors: palette.length,
      sharedPalette: multi,
    };
  }
  if (multi && scaled[0].width * scaled.length > DEFAULTS.maxSheetWidth) {
    throw resourceError(`动画精灵表过宽（${scaled[0].width * scaled.length}px），请减少帧数或缩小图片`);
  }
  assertProcessingActive(opt, '缩放');
  report.steps.push(`缩放到 ${scaled[0].width}x${scaled[0].height}`);

  // 调色板必须全帧统一：各帧单独量化会让同一块颜色在帧间跳变
  const sheet = multi ? packFramesRow(scaled) : scaled[0];
  assertProcessingActive(opt, '调色板量化');
  report.steps.push(`调色板量化到 ${palette.length} 色` + (multi ? '（全帧统一）' : ''));

  // 五官检测只在第一帧上做。多帧素材自带表情，叠加覆盖层反而会错位，
  // 所以那种情况下检测结果只用来生成头像，运行时不做眨眼。
  const sprite = multi ? extractFrame(sheet, scaled[0].width, scaled[0].height, 0) : sheet;

  // —— 五官 ——
  let detected = null;
  if (opt.features) {
    detected = rectsToBlobs(opt.features, sprite);
    report.steps.push('使用手动框选的五官位置');
  } else {
    try {
      // 把 deadline/cancel 与候选预算贯穿到检测器；否则前半段有资源闸门，最后的
      // 五官组合仍可能在同一次导入里无界运行。
      detected = detectFace(sprite, opt);
    } catch (err) {
      // Candidate/heuristic failures may degrade to a sprite-only character,
      // but an explicit cancellation or hard deadline must abort the import.
      if (isProcessingStop(err)) throw err;
      report.warnings.push('五官检测出错：' + err.message);
    }
    if (detected) {
      const n = (detected.eyes || []).filter(Boolean).length;
      // 这是启发式排序分，不是经数据集校准的概率；UI 不应把 65% 解读成
      // “有 65% 可能正确”。称为检测评分能保留诊断价值而不制造概率承诺。
      const confidence = Number.isFinite(detected.confidence)
        ? `（检测评分 ${Math.round(detected.confidence * 100)}/100）` : '';
      report.steps.push(`检测到 ${n} 只眼睛${detected.mouth ? '与嘴' : '（未找到嘴）'}${confidence}`);
      if (detected.ambiguous) {
        report.warnings.push('自动五官存在相近候选，请务必用眨眼预览检查；若镜框、镜片或腮红跟着移动，请手动重框真正的眼睛。');
      }
      // 多帧素材不叠加五官覆盖，这些提示反而误导
      if (!detected.mouth && !multi) report.warnings.push('没找到嘴，桌宠会眨眼但不会做嘴型。');
    } else if (!multi) {
      report.warnings.push('没能自动识别五官，桌宠仍会呼吸、走动和被拖拽，只是不会眨眼。可在下方手动框选。');
    }
  }
  assertProcessingActive(opt, '五官检测');

  // 部件存成带 role 标签的数组，而不是 { eyeL, eyeR, mouth } 这样的固定槽位：
  // 独眼、侧面像（只看得到一只）、三眼怪都是真实存在的角色，写死槽位就把它们排除了；
  // 而 role 标签让「加一类新部件」不必再改这里的结构。
  const parts = [];
  const atlasEntries = [];
  const pushPart = (role, id, blob) => {
    const m = solidMask(blob, sprite.width);
    atlasEntries.push({ name: id, img: extractPart(sprite, m) });
    atlasEntries.push({ name: id + 'Clean', img: inpaintPatch(sprite, m, palette).img });
    // x/y/w/h 是加过 pad 的遮罩窗口（运行时按它贴图）；src 是没加 pad 的原始范围。
    // 手动校准要回灌的是 src——拿加过 pad 的窗口再走一遍 solidMask 会二次加 pad，
    // 每重处理一次，没被重画的部件就凭空外扩一圈。
    parts.push({
      role, id,
      source: blob.source === SOURCE_USER ? SOURCE_USER : SOURCE_AUTO,
      x: m.x, y: m.y, w: m.w, h: m.h,
      src: { x: blob.x0, y: blob.y0, w: blob.w, h: blob.h },
    });
  };
  if (detected && !multi) {
    (detected.eyes || []).filter(Boolean).forEach((blob, i) => pushPart('eye', 'eye' + i, blob));
    if (detected.mouth) pushPart('mouth', 'mouth', detected.mouth);
  }
  // —— 附肢候选 ——
  // 只产生 suggestions，**永远不写 parts**：真实素材上命名不可靠（老鼠的尾巴会被判成"腿"）、
  // 定位也不完美（天使的翅膀会框到袍角），见 README「闸门结果」。必须由人确认后才成为部件。
  // suggestions 是 meta 的独立字段，normalizeParts 看不见它，运行时零影响。
  const suggestions = [];
  if (!multi) {
    try {
      const t0 = Date.now();
      const pr = detectProtrusions(sprite);
      const hits = pr.prots
        .map(b => ({ b, label: nominate(b) }))
        .filter(x => x.label);
      // 不静默截断：超出的条数写进 report，否则"只列了 6 条"会被读成"只有 6 条"
      const MAX_SUGGEST = 6;
      hits.slice(0, MAX_SUGGEST).forEach((x, i) => {
        const [x0, y0, x1, y1] = x.b.box;
        suggestions.push({
          role: 'appendage', id: 'app' + i, sublabel: x.label,
          x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1,
          areaRatio: Number(x.b.areaRatio.toFixed(4)),
        });
      });
      if (hits.length > MAX_SUGGEST) {
        report.warnings.push(`检出 ${hits.length} 个可动部件候选，只列出面积最大的 ${MAX_SUGGEST} 个。`);
      }
      if (suggestions.length) {
        report.steps.push(`找到 ${suggestions.length} 个可动部件候选（尾巴/耳朵/翅膀这类），需要你确认`);
      }
      if (Date.now() - t0 > 500) report.steps.push(`可动部件检测耗时 ${Date.now() - t0}ms`);
    } catch (err) {
      report.warnings.push('可动部件检测出错：' + err.message);
    }
  }

  // 片段按**最终**帧数重新裁剪：改了行列数就会改变帧数，把作者的旧区间原样带过去
  // 会写出一个指向不存在帧的 meta，而它要到运行时才炸。
  const clips = multi ? normalizeClips(opt.clips, scaled.length) : null;
  const { atlas, frames } = packAtlas(atlasEntries);
  assertProcessingActive(opt, '部件图集');
  for (const p of parts) {
    p.frame = frames[p.id];
    p.cleanFrame = frames[p.id + 'Clean'];
  }

  // —— 杂项元数据 ——
  let footY = sprite.height - 1;
  for (let y = sprite.height - 1; y >= 0; y--) {
    let any = false;
    for (let x = 0; x < sprite.width; x++) if (sprite.data[(y * sprite.width + x) * 4 + 3] > 0) { any = true; break; }
    if (any) { footY = y; break; }
  }
  const outline = darkestCommonColor(sprite) || [0, 0, 0];
  const icon = makeIcon(sprite, detected, opt.iconSize);
  if (multi) {
    report.steps.push(`多帧动画：${scaled.length} 帧，逐帧播放`);
    report.warnings.push('多帧素材自带表情，不再叠加眨眼与嘴型——它们会和原有帧对不上。');
  }

  return {
    sprite: multi ? sheet : sprite,
    atlas: atlasEntries.length ? atlas : null,
    icon,
    meta: {
      schemaVersion: SCHEMA_VERSION,
      sprite: { width: scaled[0].width, height: scaled[0].height },
      frames: multi ? { count: scaled.length, fps: opt.frameFps, ...(clips ? { clips } : {}) } : null,
      atlas: atlasEntries.length ? { width: atlas.width, height: atlas.height } : null,
      parts,
      suggestions,
      footY,
      outline,
      palette,
      rig: inferRig(sprite, detected),
      source: {
        cropBBox: bbox,
        backgroundMode: bg.mode,
        originalSize: { width: first.width, height: first.height },
        extraction: {
          contractVersion: 1,
          extractor: extraction.diagnostics.extractor,
          status: extraction.status,
          mode: extraction.mode,
        },
        pixelize: pixelizeMeta,
      },
    },
    report,
  };
}

// 手动框选的矩形 -> 与检测结果同构的 blob（cells 铺满整个矩形）
function rectsToBlobs(features, sprite) {
  const conv = (r) => {
    if (!r) return null;
    const x0 = Math.max(0, Math.round(r.x));
    const y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(sprite.width - 1, Math.round(r.x + r.w - 1));
    const y1 = Math.min(sprite.height - 1, Math.round(r.y + r.h - 1));
    if (x1 < x0 || y1 < y0) return null;
    const cells = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push(y * sprite.width + x);
    // 来源逐条透传：只有人真的画过的那一框才是 'user'。
    // 重新处理时整张 features 都会走这里，若在这里一律标 'user'，
    // 记下来的来源就是假的——迁移、"只重算自动部件"这些都会建立在假数据上。
    const source = r.source === SOURCE_USER ? SOURCE_USER : SOURCE_AUTO;
    return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, size: cells.length, cells, source,
             cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  // 兼容两种写法：eyes 数组，或旧的 eyeL/eyeR 两个槽位
  const rects = features.eyes || [features.eyeL, features.eyeR];
  const eyes = rects.map(conv).filter(Boolean);
  const mouth = conv(features.mouth);
  // 允许只手工框嘴。旧逻辑在 eyes 全被裁掉/清空时直接返回 null，把一个有效嘴框
  // 也一起丢掉；mouth-only 角色不该被强制伪造眼睛才能保存嘴型。
  if (!eyes.length && !mouth) return null;
  return { eyes, mouth, face: null, score: 0, confidence: 1 };
}

// 角色的"骨架属性"：动画该怎么对待这张图。
//
// 只推断一条有真实依据的（侧面像禁止翻转），其余给默认值让用户在界面上改。
// 试过用"底部实心比"去猜站立还是悬浮，巡检数据直接否掉了这个想法——
// 悬浮角色的波浪裙边照样能到 96%，跟站立角色分不开。猜不准的就别猜。
function inferRig(sprite, detected) {
  const rig = {
    anchor: 'feet',    // feet = 脚踩地（压扁、落地都以地面为基准）｜center = 悬浮
    flip: true,        // 走路时是否水平翻转朝向
    motion: 'walk',    // walk = 地面行走｜float = 悬浮飘动｜idle = 只待在原地
    swayFrom: 0.5,     // 下摆开始摆动的高度比例，null = 整体不摆
  };

  const { width: W, height: H, data } = sprite;
  let x0 = W, x1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  const span = Math.max(1, x1 - x0);

  const eyes = detected?.eyes?.filter(Boolean) || [];
  if (eyes.length) {
    // 正面像的双眼中点落在身体中线附近；侧面像的眼睛明显偏向一侧。
    // 对侧面像做水平翻转，走起来就是脸朝后倒退走。
    // 只有一只眼的（独眼、侧脸）本来就无从判断朝向，一律按侧面处理更保险。
    const mid = eyes.reduce((sum, e) => sum + e.cx, 0) / eyes.length;
    const off = Math.abs(mid - (x0 + x1) / 2) / span;
    if (eyes.length < 2 || off > 0.18) rig.flip = false;
  }

  // 横向构图（四足、横幅角色）没有裙摆可甩，摆动只会让整只动物歪来歪去
  if (W / H > 1.5) rig.swayFrom = null;

  return rig;
}

// 出现最多的深色，通常就是像素画的描边色；闭眼的眼睑线用它来画
function darkestCommonColor(img) {
  const counts = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    if (Math.max(r, g, b) >= 60) continue;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) return null;
  let bestKey = 0, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k; }
  return [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255];
}

// 托盘/列表用的方形头像：有脸就框脸，没脸就取顶部一段
function makeIcon(sprite, detected, size) {
  let cx, cy, side;
  const eyes = detected?.eyes?.filter(Boolean) || [];
  if (eyes.length) {
    const x0 = Math.min(...eyes.map(e => e.x0));
    const x1 = Math.max(...eyes.map(e => e.x1));
    const y0 = Math.min(...eyes.map(e => e.y0));
    const y1 = detected.mouth ? detected.mouth.y1 : Math.max(...eyes.map(e => e.y1));
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
    side = Math.max(x1 - x0, y1 - y0) * 2.0;
  } else {
    cx = sprite.width / 2;
    side = Math.min(sprite.width, sprite.height * 0.4);
    cy = side / 2;
  }
  side = Math.max(8, Math.round(side));
  const x0 = Math.round(cx - side / 2), y0 = Math.round(cy - side / 2);
  const crop = createImage(side, side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const gx = x0 + x, gy = y0 + y;
    if (gx < 0 || gy < 0 || gx >= sprite.width || gy >= sprite.height) continue;
    const si = (gy * sprite.width + gx) * 4, di = (y * side + x) * 4;
    crop.data[di] = sprite.data[si]; crop.data[di + 1] = sprite.data[si + 1];
    crop.data[di + 2] = sprite.data[si + 2]; crop.data[di + 3] = sprite.data[si + 3];
  }
  return side === size ? crop : downsampleTo(crop, size, size);
}

'use strict';
// 主进程的信任边界：路径、IPC 来源与 renderer 载荷都在这里做纯函数校验。
// 本模块不依赖 Electron，方便用普通 Node 运行负向测试。

const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { probePngDimensions } = require('./image-probe');

const LIMITS = Object.freeze({
  MAX_FILE_BYTES: 20 * 1024 * 1024,
  MAX_DIMENSION: 8192,
  MAX_FRAME_PIXELS: 4096 * 4096,
  MAX_TOTAL_PIXELS: 4096 * 4096,
  MAX_FRAMES: 64,
  MAX_SHEET_WIDTH: 32768,
  MAX_WORKING_PIXELS: 256 * 1024,
  MAX_GENERATED_FILE_BYTES: 20 * 1024 * 1024,
  MAX_IMPORT_BYTES: 48 * 1024 * 1024,
  MAX_METADATA_BYTES: 2 * 1024 * 1024,
  MAX_SETTINGS_BYTES: 256 * 1024,
  MAX_ICON_DIMENSION: 512,
  MAX_OPAQUE_RUNS: 256 * 1024,
  PROCESSING_TIMEOUT_MS: 15_000,
});

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/;
const GENERATED_FILES = new Set(['pet.png', 'parts.png', 'icon.png']);
const META_KEYS = new Set([
  'schemaVersion', 'sprite', 'frames', 'atlas', 'parts', 'suggestions',
  'footY', 'outline', 'palette', 'rig', 'source', 'name', 'builtin',
  'importedAt', 'author', 'license', 'copyright', 'provenance', 'skeleton',
]);
// 改名、动作设置，以及骨架编辑。骨架进这张表是因为 updateCharacterMeta 的写入
// 路径已经把合并结果交给 validateRuntimeCharacterMeta 校验（那里跑完整的
// assertSkeleton，拿得到 sprite 与 atlas 尺寸），所以这里只需要挡住形状与体积，
// 不必、也不该在拿不到图集尺寸的地方重做一遍越界判断。
const UPDATE_META_KEYS = new Set(['name', 'rig', 'skeleton']);
const IPC_SETTINGS_KEYS = new Set(['scale', 'wander', 'clickThrough', 'fps']);
const SOURCE_KEYS = new Set([
  'cropBBox', 'backgroundMode', 'originalSize', 'extraction', 'pixelize',
]);
const EXTRACTION_KEYS = new Set(['contractVersion', 'extractor', 'status', 'mode']);
const PIXELIZE_KEYS = new Set([
  'enabled', 'preset', 'targetHeight', 'paletteSize', 'methodVersion',
  'width', 'height', 'colors', 'sharedPalette',
]);
const BACKGROUND_MODES = new Set(['alpha', 'chroma', 'none']);
const PIXELIZE_PRESETS = new Set(['original', 'soft', 'classic', 'chunky', 'tiny']);
const V2_PART_KEYS = new Set([
  'role', 'id', 'source', 'x', 'y', 'w', 'h', 'src', 'frame', 'cleanFrame',
  'sublabel', 'areaRatio',
]);
const SUGGESTION_KEYS = new Set([
  'role', 'id', 'sublabel', 'x', 'y', 'w', 'h', 'areaRatio',
]);
const APPENDAGE_LABELS = new Set(['tail', 'ear/ahoge', 'leg', 'wing/fin']);

function fail(message) {
  const error = new Error(message);
  error.code = 'POPPET_INVALID_INPUT';
  throw error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) fail(`${label} 必须是普通对象`);
  return value;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} 包含不允许的字段: ${key}`);
  }
}

// src/shared/parts.js 的 CLIP_NAMES 在这里重复一份：主进程是 CommonJS，shared/ 是
// ESM，跨不过去。和 part.role 的处理方式一致。防漂移靠 test/security 里的一致性
// 断言，而不是靠记得同时改两处。
const CLIP_NAMES = Object.freeze(['idle', 'walk', 'drag', 'greet']);

// src/shared/skeleton.js 的 DRIVER_NAMES 同样在这里重复一份，理由与 CLIP_NAMES 相同。
// 一致性同样靠 test/security/skeleton-boundary.test.cjs 的断言，不靠记性。
const DRIVER_NAMES = Object.freeze(['walkSwing', 'breathe', 'dangle', 'impact', 'wave']);
// 同理复制 src/shared/skeleton.js 的 EXPR_KEYS。
const EXPR_KEYS = Object.freeze(['blink', 'talk']);

// 骨架的结构上限。与 src/shared/skeleton.js 的同名常量必须一致——
// 运行时那份是"静默丢弃"的归一器，这份是"整份拒绝"的信任边界，
// 边界比运行时宽会让一份运行时读不懂的素材进到磁盘上。
const SKELETON_LIMITS = Object.freeze({
  MAX_BONES: 64,
  MAX_DEPTH: 8,
  MIN_ANGLE_STEP: 1,
  MAX_ANGLE_STEP: 90,
  MAX_ABS_ANGLE: 180,
  MAX_GAIN: 2,
});
const SKELETAL_SCHEMA_VERSION = 3;

// 片段区间必须落在帧数之内且非空。越界的区间会让渲染器去取一条不存在的帧，
// 所以这里 fail-closed，而不是像运行时那样静默丢弃。
function assertFrameClips(frames, label) {
  if (frames.clips === undefined || frames.clips === null) return;
  assertPlainRecord(frames.clips, label);
  const names = Object.keys(frames.clips);
  if (!names.length) fail(`${label} 不能是空表`);
  if (names.length > CLIP_NAMES.length) fail(`${label} 片段数量超出允许范围`);
  for (const name of names) {
    if (!CLIP_NAMES.includes(name)) fail(`${label} 包含未知片段: ${name}`);
    const range = frames.clips[name];
    if (!Array.isArray(range) || range.length !== 2) fail(`${label}.${name} 必须是 [start, end]`);
    const [start, end] = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end >= frames.count) {
      fail(`${label}.${name} 区间无效`);
    }
  }
}

// 关节骨架：整份 fail-closed。
//
// 为什么这里比运行时严：src/shared/skeleton.js 在渲染热路径上，遇到坏数据静默返回
// null（角色退化成一张静态立绘，不崩）。这里是导入边界，坏数据一旦落盘就会在每次
// 加载时重新走一遍那条退化路径，而用户看到的是"我的角色不动了"且没有任何解释。
// 边界的职责是当场说清楚哪里不对。
function assertSkeleton(skeleton, sprite, atlas, label) {
  assertPlainRecord(skeleton, label);
  assertExactKeys(skeleton, new Set(['angleStep', 'bones']), label);

  const step = skeleton.angleStep;
  if (!Number.isSafeInteger(step)
      || step < SKELETON_LIMITS.MIN_ANGLE_STEP
      || step > SKELETON_LIMITS.MAX_ANGLE_STEP) {
    fail(`${label}.angleStep 无效`);
  }
  if (!Array.isArray(skeleton.bones)) fail(`${label}.bones 必须是数组`);
  if (skeleton.bones.length < 1) fail(`${label}.bones 不能为空`);
  if (skeleton.bones.length > SKELETON_LIMITS.MAX_BONES) fail(`${label}.bones 数量超出允许范围`);
  if (!atlas) fail(`${label} 需要部件图集`);

  const byId = new Map();
  for (const [index, bone] of skeleton.bones.entries()) {
    const at = `${label}.bones[${index}]`;
    assertPlainRecord(bone, at);
    assertExactKeys(bone,
      new Set(['id', 'parent', 'pivot', 'anchor', 'z', 'frame', 'drivers', 'limit', 'expr']), at);

    if (typeof bone.id !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bone.id)
        || byId.has(bone.id)) fail(`${at}.id 无效或重复`);
    if (bone.parent !== null
        && (typeof bone.parent !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bone.parent))) {
      fail(`${at}.parent 无效`);
    }
    for (const key of ['pivot', 'anchor']) {
      const point = bone[key];
      assertPlainRecord(point, `${at}.${key}`);
      assertExactKeys(point, new Set(['x', 'y']), `${at}.${key}`);
      if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)
          || Math.abs(point.x) > LIMITS.MAX_DIMENSION
          || Math.abs(point.y) > LIMITS.MAX_DIMENSION) fail(`${at}.${key} 无效`);
    }
    if (!Number.isSafeInteger(bone.z) || Math.abs(bone.z) > 1024) fail(`${at}.z 无效`);

    const frame = bone.frame;
    assertPlainRecord(frame, `${at}.frame`);
    assertExactKeys(frame, new Set(['sx', 'sy', 'sw', 'sh']), `${at}.frame`);
    if (!Number.isSafeInteger(frame.sx) || !Number.isSafeInteger(frame.sy)
        || !Number.isSafeInteger(frame.sw) || !Number.isSafeInteger(frame.sh)
        || frame.sx < 0 || frame.sy < 0 || frame.sw <= 0 || frame.sh <= 0
        || frame.sx + frame.sw > atlas.width
        || frame.sy + frame.sh > atlas.height) {
      fail(`${at}.frame 超出图集范围`);
    }
    // 枢轴必须落在部件自己的画面里。落在外面不是"非法"，是"作者标错了"——
    // 但后果是那一段肢体绕着画面外的一个点甩，观感上是断肢，所以在这里拦住。
    if (bone.pivot.x < 0 || bone.pivot.y < 0
        || bone.pivot.x > frame.sw || bone.pivot.y > frame.sh) {
      fail(`${at}.pivot 必须落在部件画面内`);
    }

    if (bone.drivers !== undefined && bone.drivers !== null) {
      assertPlainRecord(bone.drivers, `${at}.drivers`);
      for (const name of Object.keys(bone.drivers)) {
        if (!DRIVER_NAMES.includes(name)) fail(`${at}.drivers 包含未知驱动器: ${name}`);
        const gain = bone.drivers[name];
        if (typeof gain !== 'number' || !Number.isFinite(gain)
            || Math.abs(gain) > SKELETON_LIMITS.MAX_GAIN) fail(`${at}.drivers.${name} 无效`);
      }
    }
    if (bone.expr !== undefined && bone.expr !== null) {
      assertPlainRecord(bone.expr, `${at}.expr`);
      assertExactKeys(bone.expr, new Set(EXPR_KEYS), `${at}.expr`);
      for (const key of EXPR_KEYS) {
        const alt = bone.expr[key];
        if (alt === undefined) continue;
        assertPlainRecord(alt, `${at}.expr.${key}`);
        assertExactKeys(alt, new Set(['sx', 'sy', 'sw', 'sh']), `${at}.expr.${key}`);
        // 形状错误和越界要分开报：缺一个 sh 被说成"超出图集范围"，
        // 会把作者引去改坐标，而真正的问题是字段没写。
        if (!Number.isSafeInteger(alt.sx) || !Number.isSafeInteger(alt.sy)
            || !Number.isSafeInteger(alt.sw) || !Number.isSafeInteger(alt.sh)
            || alt.sx < 0 || alt.sy < 0 || alt.sw <= 0 || alt.sh <= 0) {
          fail(`${at}.expr.${key} 无效`);
        }
        if (alt.sx + alt.sw > atlas.width || alt.sy + alt.sh > atlas.height) {
          fail(`${at}.expr.${key} 超出图集范围`);
        }
        // 替换帧必须与基础帧同尺寸：pivot 是按基础帧标的，尺寸一变枢轴就错位，
        // 眨一下眼整个头会跳一格。运行时那份静默丢弃（后果只是"不会眨眼"），
        // 边界这份必须说清楚，否则作者永远不知道自己标错了。
        if (alt.sw !== frame.sw || alt.sh !== frame.sh) {
          fail(`${at}.expr.${key} 必须与基础帧同尺寸（${frame.sw}x${frame.sh}）`);
        }
      }
    }
    if (bone.limit !== undefined && bone.limit !== null) {
      if (!Array.isArray(bone.limit) || bone.limit.length !== 2) fail(`${at}.limit 无效`);
      const [lo, hi] = bone.limit;
      if (typeof lo !== 'number' || typeof hi !== 'number'
          || !Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi
          || lo < -SKELETON_LIMITS.MAX_ABS_ANGLE
          || hi > SKELETON_LIMITS.MAX_ABS_ANGLE) fail(`${at}.limit 无效`);
    }
    byId.set(bone.id, bone);
  }

  // 恰好一个根：z 序、anchor 原点和"整只角色"这个概念都要求单一原点。
  const roots = skeleton.bones.filter(b => b.parent === null);
  if (roots.length !== 1) fail(`${label} 必须恰好有一个根骨骼`);

  // 父引用存在、无环、不超深。环若漏进渲染器就是无限循环，必须在这里拦死。
  for (const bone of skeleton.bones) {
    let depth = 0;
    let cursor = bone;
    while (cursor.parent !== null) {
      const next = byId.get(cursor.parent);
      if (!next) fail(`${label} 的 ${cursor.id} 引用了不存在的父骨骼`);
      if (++depth > SKELETON_LIMITS.MAX_DEPTH) fail(`${label} 层级过深或存在环`);
      cursor = next;
    }
  }
  void sprite;
}

function isSafeCharacterId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64
    && !id.startsWith('.') && !id.endsWith('.') && !id.endsWith(' ')
    && !WINDOWS_FORBIDDEN.test(id) && !RESERVED_NAMES.test(id);
}

function assertCharacterId(id) {
  if (!isSafeCharacterId(id)) fail('非法角色 id');
  return id;
}

function safeChildPath(base, id) {
  assertCharacterId(id);
  const root = path.resolve(base);
  const child = path.resolve(root, id);
  const relative = path.relative(root, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('角色路径越界');
  return child;
}

function assertImageBudget(width, height, frameCount = 1) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail('图片尺寸无效');
  }
  if (width > LIMITS.MAX_DIMENSION || height > LIMITS.MAX_DIMENSION) {
    fail(`图片边长超过限制（最大 ${LIMITS.MAX_DIMENSION}px）`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > LIMITS.MAX_FRAME_PIXELS) {
    fail(`单帧像素超过限制（最大 ${LIMITS.MAX_FRAME_PIXELS}）`);
  }
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > LIMITS.MAX_FRAMES) {
    fail(`帧数超过限制（最大 ${LIMITS.MAX_FRAMES}）`);
  }
  if (pixels * frameCount > LIMITS.MAX_TOTAL_PIXELS) {
    fail(`所有帧总像素超过限制（最大 ${LIMITS.MAX_TOTAL_PIXELS}）`);
  }
  return { width, height, pixels, frameCount, totalPixels: pixels * frameCount };
}

function assertSafeJson(value, label = '数据', state = { depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 20_000) fail(`${label} 结构过大`);
  if (state.depth > 12) fail(`${label} 嵌套过深`);

  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} 含有无效数字`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 16_384) fail(`${label} 含有过长字符串`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) fail(`${label} 数组过长`);
    const next = { depth: state.depth + 1, nodes: state.nodes };
    for (const item of value) {
      assertSafeJson(item, label, next);
      state.nodes = next.nodes;
    }
    return;
  }
  assertPlainRecord(value, label);
  const keys = Object.keys(value);
  if (keys.length > 256) fail(`${label} 字段过多`);
  const next = { depth: state.depth + 1, nodes: state.nodes };
  for (const key of keys) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      fail(`${label} 含有危险字段`);
    }
    if (key.length > 128) fail(`${label} 字段名过长`);
    assertSafeJson(value[key], label, next);
    state.nodes = next.nodes;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeName(value, fallback = '新角色') {
  if (typeof value !== 'string') return fallback;
  const name = value.trim();
  if (!name) return fallback;
  if (name.length > 100 || /[\u0000-\u001f]/.test(name)) fail('角色名称无效');
  return name;
}

function validateRig(rig) {
  assertPlainRecord(rig, 'rig');
  assertExactKeys(rig, new Set(['motion', 'anchor', 'flip', 'swayFrom']), 'rig');
  if (!['walk', 'float', 'idle'].includes(rig.motion)) fail('rig.motion 无效');
  if (!['feet', 'center'].includes(rig.anchor)) fail('rig.anchor 无效');
  if (typeof rig.flip !== 'boolean') fail('rig.flip 必须是布尔值');
  if (rig.swayFrom !== null && (typeof rig.swayFrom !== 'number'
      || !Number.isFinite(rig.swayFrom) || rig.swayFrom < 0 || rig.swayFrom > 1)) {
    fail('rig.swayFrom 无效');
  }
  return cloneJson(rig);
}

function runtimePartEntries(parts) {
  if (!parts) return [];
  if (Array.isArray(parts)) {
    if (parts.length > 128) fail('metadata.parts 过多');
    return parts.filter(Boolean);
  }
  assertPlainRecord(parts, 'metadata.parts');
  const entries = [];
  if (Array.isArray(parts.eyes)) {
    if (parts.eyes.length > 128) fail('metadata.parts.eyes 过多');
    entries.push(...parts.eyes.filter(Boolean));
  } else {
    if (parts.eyeL) entries.push(parts.eyeL);
    if (parts.eyeR) entries.push(parts.eyeR);
  }
  if (parts.mouth) entries.push(parts.mouth);
  return entries;
}

function validatePartRect(rect, sprite, label) {
  assertPlainRecord(rect, label);
  for (const key of ['x', 'y', 'w', 'h']) {
    if (!Number.isSafeInteger(rect[key])) fail(`${label}.${key} 无效`);
  }
  const pad = 16;
  if (rect.w < 1 || rect.h < 1 || rect.w > sprite.width + pad * 2
      || rect.h > sprite.height + pad * 2 || rect.x < -pad || rect.y < -pad
      || rect.x + rect.w > sprite.width + pad || rect.y + rect.h > sprite.height + pad) {
    fail(`${label} 超出 sprite 边界`);
  }
}

function validateAtlasFrame(frame, part, atlas, label) {
  assertPlainRecord(frame, label);
  for (const key of ['sx', 'sy', 'sw', 'sh']) {
    if (!Number.isSafeInteger(frame[key])) fail(`${label}.${key} 无效`);
  }
  if (frame.sx < 0 || frame.sy < 0 || frame.sw !== part.w || frame.sh !== part.h
      || frame.sx + frame.sw > atlas.width || frame.sy + frame.sh > atlas.height) {
    fail(`${label} 超出 atlas 边界`);
  }
}

function validateRuntimeParts(parts, sprite, atlas) {
  const entries = runtimePartEntries(parts);
  if (entries.length > 128) fail('metadata.parts 过多');
  for (const [index, part] of entries.entries()) {
    const label = `metadata.parts[${index}]`;
    validatePartRect(part, sprite, label);
    for (const key of ['id', 'name', 'role']) {
      if (part[key] !== undefined && (typeof part[key] !== 'string' || part[key].length > 128)) {
        fail(`${label}.${key} 无效`);
      }
    }
    const hasFrames = part.frame !== undefined || part.cleanFrame !== undefined;
    if (hasFrames) {
      if (!atlas || !part.frame || !part.cleanFrame) fail(`${label} 图集帧不完整`);
      validateAtlasFrame(part.frame, part, atlas, `${label}.frame`);
      validateAtlasFrame(part.cleanFrame, part, atlas, `${label}.cleanFrame`);
    } else if (atlas && (part.role === 'eye' || part.role === 'mouth'
        || part.role === undefined)) {
      // v0/v1 没有 role，但列入 parts 的就是眼/嘴；有 atlas 时运行时一定会访问两帧。
      fail(`${label} 缺少图集帧`);
    }
    if (part.src !== undefined) validatePartRect(part.src, sprite, `${label}.src`);
  }
}

function validateRuntimeNameAndRig(meta) {
  if (meta.name !== undefined && (typeof meta.name !== 'string' || meta.name.length > 100
      || /[\u0000-\u001f]/.test(meta.name))) fail('metadata.name 无效');
  if (meta.rig !== undefined) validateRig(meta.rig);
}

function validateSourceProvenance(source, sprite, frameCount) {
  if (source === undefined) return;
  assertPlainRecord(source, 'metadata.source');
  assertExactKeys(source, SOURCE_KEYS, 'metadata.source');

  assertPlainRecord(source.originalSize, 'metadata.source.originalSize');
  assertExactKeys(source.originalSize, new Set(['width', 'height']), 'metadata.source.originalSize');
  assertImageBudget(source.originalSize.width, source.originalSize.height, frameCount);

  if (!Array.isArray(source.cropBBox) || source.cropBBox.length !== 4
      || source.cropBBox.some(value => !Number.isSafeInteger(value))) {
    fail('metadata.source.cropBBox 无效');
  }
  const [x0, y0, x1, y1] = source.cropBBox;
  if (x0 < 0 || y0 < 0 || x1 < x0 || y1 < y0
      || x1 >= source.originalSize.width || y1 >= source.originalSize.height) {
    fail('metadata.source.cropBBox 超出原图边界');
  }
  if (!BACKGROUND_MODES.has(source.backgroundMode)) fail('metadata.source.backgroundMode 无效');

  assertPlainRecord(source.extraction, 'metadata.source.extraction');
  assertExactKeys(source.extraction, EXTRACTION_KEYS, 'metadata.source.extraction');
  if (source.extraction.contractVersion !== 1
      || source.extraction.extractor !== 'local-edge-v1'
      || !BACKGROUND_MODES.has(source.extraction.mode)
      || source.extraction.mode !== source.backgroundMode) {
    fail('metadata.source.extraction 无效');
  }
  const expectedStatus = source.extraction.mode === 'none'
    ? 'needs-advanced-extraction' : 'ready';
  if (source.extraction.status !== expectedStatus) fail('metadata.source.extraction.status 无效');

  assertPlainRecord(source.pixelize, 'metadata.source.pixelize');
  assertExactKeys(source.pixelize, PIXELIZE_KEYS, 'metadata.source.pixelize');
  const pixelize = source.pixelize;
  if (typeof pixelize.enabled !== 'boolean' || !PIXELIZE_PRESETS.has(pixelize.preset)
      || pixelize.methodVersion !== 'local-box-median-cut-v1'
      || !Number.isSafeInteger(pixelize.width) || pixelize.width !== sprite.width
      || !Number.isSafeInteger(pixelize.height) || pixelize.height !== sprite.height
      || !Number.isSafeInteger(pixelize.colors) || pixelize.colors < 1 || pixelize.colors > 256
      || typeof pixelize.sharedPalette !== 'boolean'
      || pixelize.sharedPalette !== (frameCount > 1)) {
    fail('metadata.source.pixelize 无效');
  }
  if (!pixelize.enabled) {
    if (pixelize.preset !== 'original' || pixelize.targetHeight !== null
        || pixelize.paletteSize !== null) fail('metadata.source.pixelize 原图配置无效');
  } else if (pixelize.preset === 'original'
      || !Number.isSafeInteger(pixelize.targetHeight) || pixelize.targetHeight < 16
      || pixelize.targetHeight > 400
      || !Number.isSafeInteger(pixelize.paletteSize) || pixelize.paletteSize < 2
      || pixelize.paletteSize > 48 || pixelize.colors > pixelize.paletteSize) {
    fail('metadata.source.pixelize 配置无效');
  }
}

function validateRgb(value, label) {
  if (!Array.isArray(value) || value.length !== 3
      || value.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    fail(`${label} 必须是 RGB 三元组`);
  }
}

function validateStrictV2Parts(parts, sprite, atlas) {
  if (!Array.isArray(parts) || parts.length > 128) fail('metadata.parts 无效');
  const ids = new Set();
  let mouths = 0;
  for (const [index, part] of parts.entries()) {
    const label = `metadata.parts[${index}]`;
    assertPlainRecord(part, label);
    assertExactKeys(part, V2_PART_KEYS, label);
    if (!['eye', 'mouth', 'appendage'].includes(part.role)) fail(`${label}.role 无效`);
    if (typeof part.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(part.id)
        || ids.has(part.id)) fail(`${label}.id 无效或重复`);
    ids.add(part.id);
    if (!['auto', 'user'].includes(part.source)) fail(`${label}.source 无效`);
    validatePartRect(part, sprite, label);

    if (part.role === 'appendage') {
      if (!APPENDAGE_LABELS.has(part.sublabel)
          || typeof part.areaRatio !== 'number' || !Number.isFinite(part.areaRatio)
          || part.areaRatio < 0 || part.areaRatio > 1
          || part.frame !== undefined || part.cleanFrame !== undefined) {
        fail(`${label} appendage 字段无效`);
      }
      continue;
    }

    if (part.sublabel !== undefined || part.areaRatio !== undefined || !part.src) {
      fail(`${label} 表情部件字段无效`);
    }
    assertExactKeys(part.src, new Set(['x', 'y', 'w', 'h']), `${label}.src`);
    if (!atlas || !part.frame || !part.cleanFrame) fail(`${label} 缺少图集帧`);
    assertExactKeys(part.frame, new Set(['sx', 'sy', 'sw', 'sh']), `${label}.frame`);
    assertExactKeys(part.cleanFrame, new Set(['sx', 'sy', 'sw', 'sh']), `${label}.cleanFrame`);
    if (part.role === 'mouth' && ++mouths > 1) fail('metadata.parts 只能包含一个 mouth');
  }
}

function validateStrictSuggestions(suggestions, sprite) {
  if (!Array.isArray(suggestions) || suggestions.length > 128) fail('metadata.suggestions 无效');
  const ids = new Set();
  for (const [index, suggestion] of suggestions.entries()) {
    const label = `metadata.suggestions[${index}]`;
    assertPlainRecord(suggestion, label);
    assertExactKeys(suggestion, SUGGESTION_KEYS, label);
    if (suggestion.role !== 'appendage' || !APPENDAGE_LABELS.has(suggestion.sublabel)
        || typeof suggestion.id !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(suggestion.id)
        || ids.has(suggestion.id)
        || typeof suggestion.areaRatio !== 'number' || !Number.isFinite(suggestion.areaRatio)
        || suggestion.areaRatio < 0 || suggestion.areaRatio > 1) {
      fail(`${label} 无效`);
    }
    ids.add(suggestion.id);
    validatePartRect(suggestion, sprite, label);
    if (suggestion.x < 0 || suggestion.y < 0
        || suggestion.x + suggestion.w > sprite.width
        || suggestion.y + suggestion.h > sprite.height) fail(`${label} 超出 sprite 边界`);
  }
}

function validateCharacterMeta(meta) {
  assertPlainRecord(meta, '角色 metadata');
  assertExactKeys(meta, META_KEYS, '角色 metadata');
  assertSafeJson(meta, '角色 metadata');
  const encoded = JSON.stringify(meta);
  if (Buffer.byteLength(encoded) > LIMITS.MAX_METADATA_BYTES) fail('角色 metadata 过大');
  // v2 = 表情部件角色，v3 = 关节骨架角色。两者是**互斥的两类素材**，
  // 版本号与 skeleton 字段互为充要条件——允许"v3 但没骨架"或"v2 却带骨架"
  // 会让下游多出两种没人测过的中间态。
  const hasSkeleton = meta.skeleton !== undefined && meta.skeleton !== null;
  if (meta.schemaVersion !== 2 && meta.schemaVersion !== SKELETAL_SCHEMA_VERSION) {
    fail(`metadata.schemaVersion 必须是 2 或 ${SKELETAL_SCHEMA_VERSION}`);
  }
  if (hasSkeleton && meta.schemaVersion !== SKELETAL_SCHEMA_VERSION) {
    fail(`带 skeleton 的角色 metadata.schemaVersion 必须是 ${SKELETAL_SCHEMA_VERSION}`);
  }
  if (!hasSkeleton && meta.schemaVersion === SKELETAL_SCHEMA_VERSION) {
    fail(`metadata.schemaVersion ${SKELETAL_SCHEMA_VERSION} 必须带 skeleton`);
  }
  if (meta.source === undefined) fail('metadata.source 缺失');
  for (const key of ['frames', 'atlas', 'parts', 'suggestions', 'footY', 'outline', 'palette', 'rig']) {
    if (meta[key] === undefined) fail(`metadata.${key} 缺失`);
  }

  if (!isPlainRecord(meta.sprite)) fail('metadata.sprite 缺失');
  assertExactKeys(meta.sprite, new Set(['width', 'height']), 'metadata.sprite');
  let frameCount = 1;
  if (meta.frames !== null && meta.frames !== undefined) {
    assertPlainRecord(meta.frames, 'metadata.frames');
    assertExactKeys(meta.frames, new Set(['count', 'fps', 'clips']), 'metadata.frames');
    if (!Number.isSafeInteger(meta.frames.count) || meta.frames.count < 2
        || meta.frames.count > LIMITS.MAX_FRAMES) fail('metadata.frames.count 无效');
    frameCount = meta.frames.count;
    if (!Number.isInteger(meta.frames.fps) || meta.frames.fps < 1 || meta.frames.fps > 120) {
      fail('metadata.frames.fps 无效');
    }
    assertFrameClips(meta.frames, 'metadata.frames.clips');
  }
  assertImageBudget(meta.sprite.width, meta.sprite.height, frameCount);
  if (meta.atlas !== null && meta.atlas !== undefined) {
    assertPlainRecord(meta.atlas, 'metadata.atlas');
    assertExactKeys(meta.atlas, new Set(['width', 'height']), 'metadata.atlas');
    assertImageBudget(meta.atlas.width, meta.atlas.height, 1);
  }
  if (hasSkeleton) {
    // 骨架角色的动作是**算**出来的，帧带角色的动作是**画**出来的。
    // 同时声明会让程序化摆臂叠在已经画好的走路姿势上，两套动作互相打架；
    // 而运行时的 isSkeletal() 遇到这种素材会静默忽略骨架，作者永远不会知道
    // 自己的骨架没生效。所以在边界当场拒绝，而不是让它落盘。
    if (frameCount > 1) fail('metadata.skeleton 不能与多帧帧带同时存在');
    assertSkeleton(meta.skeleton, meta.sprite, meta.atlas, 'metadata.skeleton');
  }
  validateRuntimeParts(meta.parts, meta.sprite, meta.atlas);
  validateRuntimeNameAndRig(meta);
  validateSourceProvenance(meta.source, meta.sprite, frameCount);
  validateStrictV2Parts(meta.parts, meta.sprite, meta.atlas);
  validateStrictSuggestions(meta.suggestions, meta.sprite);
  if (!Number.isSafeInteger(meta.footY) || meta.footY < 0 || meta.footY >= meta.sprite.height) {
    fail('metadata.footY 无效');
  }
  validateRgb(meta.outline, 'metadata.outline');
  if (!Array.isArray(meta.palette) || meta.palette.length < 1 || meta.palette.length > 256) {
    fail('metadata.palette 无效');
  }
  meta.palette.forEach((color, index) => validateRgb(color, `metadata.palette[${index}]`));
  if (meta.builtin !== undefined && typeof meta.builtin !== 'boolean') fail('metadata.builtin 无效');
  if (meta.importedAt !== undefined) {
    const timestamp = typeof meta.importedAt === 'string' ? Date.parse(meta.importedAt) : Number.NaN;
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== meta.importedAt) {
      fail('metadata.importedAt 无效');
    }
  }
  return cloneJson(meta);
}

// 读取已有磁盘角色时只校验运行时会消费的安全形状，并兼容 v0/v1 的 parts 对象。
// 新导入仍走上面的严格 schema；这里不能因为升级安全边界而让旧角色全部失效。
function validateRuntimeCharacterMeta(meta) {
  assertPlainRecord(meta, '角色 metadata');
  assertSafeJson(meta, '角色 metadata');
  if (Buffer.byteLength(JSON.stringify(meta)) > LIMITS.MAX_METADATA_BYTES) fail('角色 metadata 过大');
  if (!isPlainRecord(meta.sprite)) fail('metadata.sprite 缺失');

  let frameCount = 1;
  if (meta.frames !== null && meta.frames !== undefined) {
    assertPlainRecord(meta.frames, 'metadata.frames');
    if (!Number.isSafeInteger(meta.frames.count) || meta.frames.count < 2
        || meta.frames.count > LIMITS.MAX_FRAMES) fail('metadata.frames.count 无效');
    if (meta.frames.fps !== undefined
        && (!Number.isInteger(meta.frames.fps) || meta.frames.fps < 1 || meta.frames.fps > 120)) {
      fail('metadata.frames.fps 无效');
    }
    assertFrameClips(meta.frames, 'metadata.frames.clips');
    frameCount = meta.frames.count;
  }
  assertImageBudget(meta.sprite.width, meta.sprite.height, frameCount);
  if (meta.atlas !== null && meta.atlas !== undefined) {
    assertPlainRecord(meta.atlas, 'metadata.atlas');
    assertImageBudget(meta.atlas.width, meta.atlas.height, 1);
  }
  if (meta.parts !== undefined && meta.parts !== null
      && !Array.isArray(meta.parts) && !isPlainRecord(meta.parts)) fail('metadata.parts 无效');
  // 读盘路径没有顶层 assertExactKeys（旧角色不能因为边界升级而全部失效），
  // 所以一个未知的 skeleton 字段本来会原样活到渲染器。这里补上同一道形状检查：
  // 严格路径拒绝的东西，磁盘上也不该被当成合法骨架加载。
  if (meta.skeleton !== undefined && meta.skeleton !== null) {
    if (frameCount > 1) fail('metadata.skeleton 不能与多帧帧带同时存在');
    assertSkeleton(meta.skeleton, meta.sprite, meta.atlas, 'metadata.skeleton');
  }
  validateRuntimeParts(meta.parts, meta.sprite, meta.atlas);
  validateRuntimeNameAndRig(meta);
  return cloneJson(meta);
}

function byteView(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  fail(`${label} 必须是二进制数据`);
}

function validateCharacterPngFiles(meta, inputFiles, { requireIcon }) {
  assertPlainRecord(inputFiles, '角色 files');
  const files = {};
  const dimensions = {};
  let total = 0;
  for (const [fileName, value] of Object.entries(inputFiles)) {
    if (!GENERATED_FILES.has(fileName)) fail(`不允许的角色文件: ${fileName}`);
    const bytes = byteView(value, fileName);
    if (bytes.byteLength < 33 || bytes.byteLength > LIMITS.MAX_GENERATED_FILE_BYTES) {
      fail(`${fileName} 大小无效`);
    }
    try {
      dimensions[fileName] = probePngDimensions(bytes, { requireComplete: true });
    } catch (error) {
      fail(`${fileName} 无效：${error.message}`);
    }
    total += bytes.byteLength;
    if (total > LIMITS.MAX_IMPORT_BYTES) fail('角色文件总大小超过限制');
    files[fileName] = Buffer.from(bytes);
  }
  if (!files['pet.png'] || (requireIcon && !files['icon.png'])) {
    fail(requireIcon ? '角色缺少 pet.png 或 icon.png' : '角色缺少 pet.png');
  }

  const frameCount = meta.frames?.count || 1;
  const expectedPetWidth = meta.sprite.width * frameCount;
  const pet = dimensions['pet.png'];
  const petPixels = pet.width * pet.height;
  if (!Number.isSafeInteger(expectedPetWidth) || pet.width > LIMITS.MAX_SHEET_WIDTH
      || !Number.isSafeInteger(petPixels) || petPixels > LIMITS.MAX_WORKING_PIXELS) {
    fail('pet.png 物理尺寸超过限制');
  }
  if (pet.width !== expectedPetWidth || pet.height !== meta.sprite.height) {
    fail('pet.png 尺寸与 metadata.sprite/frames 不一致');
  }

  const hasAtlas = meta.atlas !== null && meta.atlas !== undefined;
  if (hasAtlas !== !!files['parts.png']) fail('parts.png 与 metadata.atlas 不一致');
  if (hasAtlas) {
    const parts = dimensions['parts.png'];
    assertImageBudget(parts.width, parts.height, 1);
    if (parts.width * parts.height > LIMITS.MAX_WORKING_PIXELS) fail('parts.png 物理尺寸超过限制');
    if (parts.width !== meta.atlas.width || parts.height !== meta.atlas.height) {
      fail('parts.png 尺寸与 metadata.atlas 不一致');
    }
  }

  if (files['icon.png']) {
    const icon = dimensions['icon.png'];
    assertImageBudget(icon.width, icon.height, 1);
    if (icon.width !== icon.height || icon.width > LIMITS.MAX_ICON_DIMENSION) {
      fail(`icon.png 必须是边长不超过 ${LIMITS.MAX_ICON_DIMENSION}px 的正方形`);
    }
  }
  return files;
}

function validateStoredCharacter(meta, files) {
  const safeMeta = validateRuntimeCharacterMeta(meta);
  return { meta: safeMeta, files: validateCharacterPngFiles(safeMeta, files, { requireIcon: false }) };
}

function validateImportPayload(payload) {
  assertPlainRecord(payload, '导入 payload');
  assertExactKeys(payload, new Set(['id', 'name', 'meta', 'files', 'activate']), '导入 payload');
  if (payload.id !== undefined) assertCharacterId(payload.id);
  if (payload.activate !== undefined && typeof payload.activate !== 'boolean') fail('activate 必须是布尔值');
  const name = normalizeName(payload.name);
  const meta = validateCharacterMeta(payload.meta);
  const files = validateCharacterPngFiles(meta, payload.files, { requireIcon: true });
  return { id: payload.id, name, meta, files, activate: payload.activate };
}

// 同一个 fd 上先 fstat 再按精确长度读取；文件增长也只会多读 1 byte 用于拒绝，
// 不会让 readFileSync 在预算检查前按攻击者替换后的巨大尺寸分配内存。
function readRegularFileLimitedSync(file, maxBytes, label = '文件') {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail(`${label} 读取限制无效`);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) fail(`${label} 必须是普通文件`);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(file, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size < 1 || opened.size > maxBytes) fail(`${label} 大小无效`);
    if (before.dev !== opened.dev || before.ino !== opened.ino) fail(`${label} 在读取前发生变化`);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) fail(`${label} 在读取中被截断`);
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, null) !== 0) fail(`${label} 在读取中增长`);
    const after = fs.fstatSync(fd);
    const pathAfter = fs.lstatSync(file);
    if (after.size !== opened.size || pathAfter.isSymbolicLink()
        || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      fail(`${label} 在读取中被替换`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateMetadataUpdate(value) {
  assertPlainRecord(value, 'metadata 更新');
  assertExactKeys(value, new Set(['id', 'patch']), 'metadata 更新');
  const id = assertCharacterId(value.id);
  assertPlainRecord(value.patch, 'metadata patch');
  assertExactKeys(value.patch, UPDATE_META_KEYS, 'metadata patch');
  if (!Object.keys(value.patch).length) fail('metadata patch 不能为空');
  const patch = {};
  if (value.patch.name !== undefined) patch.name = normalizeName(value.patch.name);
  if (value.patch.rig !== undefined) patch.rig = validateRig(value.patch.rig);
  if (value.patch.skeleton !== undefined) {
    assertPlainRecord(value.patch.skeleton, 'metadata patch.skeleton');
    // 原型污染在这里先拦一次而不是等写入前：patch 会被展开进已有 meta，
    // 一个 __proto__ 键在合并那一步就已经生效了。
    assertSafeJson(value.patch.skeleton, 'metadata patch.skeleton');
    if (Buffer.byteLength(JSON.stringify(value.patch.skeleton)) > LIMITS.MAX_METADATA_BYTES) {
      fail('metadata patch.skeleton 过大');
    }
    patch.skeleton = cloneJson(value.patch.skeleton);
  }
  return { id, patch };
}

function validateSettingsPatch(patch) {
  assertPlainRecord(patch, '设置 patch');
  assertExactKeys(patch, IPC_SETTINGS_KEYS, '设置 patch');
  if (!Object.keys(patch).length) fail('设置 patch 不能为空');
  const out = {};
  if (patch.scale !== undefined) {
    if (typeof patch.scale !== 'number' || !Number.isFinite(patch.scale)
        || patch.scale < 0.25 || patch.scale > 2) fail('scale 超出范围');
    out.scale = patch.scale;
  }
  for (const key of ['wander', 'clickThrough']) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') fail(`${key} 必须是布尔值`);
      out[key] = patch[key];
    }
  }
  if (patch.fps !== undefined) {
    // 与 library.js 的持久化校验保持同一范围：整数 8~120。
    if (!Number.isInteger(patch.fps) || patch.fps < 8 || patch.fps > 120) {
      fail('fps 必须是 8~120 的整数');
    }
    out.fps = patch.fps;
  }
  return out;
}

function validateMove(value) {
  assertPlainRecord(value, '移动 payload');
  assertExactKeys(value, new Set(['dx', 'dy']), '移动 payload');
  for (const key of ['dx', 'dy']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key]) > 512) {
      fail(`${key} 超出范围`);
    }
  }
  return { dx: value.dx, dy: value.dy };
}

function validateBoolean(value, label = 'payload') {
  if (typeof value !== 'boolean') fail(`${label} 必须是布尔值`);
  return value;
}

function validateLog(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('日志 payload 无效');
  return value;
}

function noArguments(args) {
  if (args.length) fail('此 IPC 通道不接受参数');
  return undefined;
}

function oneArgument(args, validator) {
  if (args.length !== 1) fail('IPC 参数数量错误');
  return validator(args[0]);
}

function assertTrustedIpcFrame(event, expectedWebContents, expectedHtmlPath) {
  if (!event || !expectedWebContents || expectedWebContents.isDestroyed?.()) fail('IPC 来源窗口无效');
  if (event.sender !== expectedWebContents) fail('IPC sender 不可信');
  const frame = event.senderFrame;
  const mainFrame = expectedWebContents.mainFrame;
  if (!frame || !mainFrame || frame !== mainFrame) fail('只允许顶层 frame 调用 IPC');

  let actualPath;
  try {
    if (!frame.url || !frame.url.startsWith('file:')) fail('IPC 页面协议无效');
    actualPath = fileURLToPath(frame.url);
  } catch {
    fail('IPC 页面 URL 无效');
  }
  if (path.resolve(actualPath) !== path.resolve(expectedHtmlPath)) fail('IPC 页面路径不可信');
  return true;
}

function safeIpcListener(channel, listener, logger = console.warn) {
  if (typeof channel !== 'string' || typeof listener !== 'function') fail('IPC listener 配置无效');
  const report = (error) => {
    try {
      logger(`[ipc:${channel}] 已忽略无效 send 消息`, error);
    } catch {
      // 日志实现本身不能让不可信 send 消息重新逃逸到主进程事件循环。
    }
  };
  return function guardedIpcListener(event, ...args) {
    try {
      const result = listener(event, ...args);
      if (result && typeof result.then === 'function') result.catch(report);
    } catch (error) {
      report(error);
    }
  };
}

module.exports = {
  LIMITS,
  isPlainRecord,
  isSafeCharacterId,
  assertCharacterId,
  safeChildPath,
  assertImageBudget,
  validateCharacterMeta,
  validateRuntimeCharacterMeta,
  validateStoredCharacter,
  validateCharacterPngFiles,
  validateImportPayload,
  validateMetadataUpdate,
  validateSettingsPatch,
  validateMove,
  validateBoolean,
  validateLog,
  noArguments,
  oneArgument,
  assertTrustedIpcFrame,
  safeIpcListener,
  readRegularFileLimitedSync,
};

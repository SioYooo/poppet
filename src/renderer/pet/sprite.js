// 精灵渲染：把静态立绘 + 眼/嘴部件合成为带表情的一帧。
//
// 合成方式是"加法式"的——先用背景板把五官抹掉，再按开合度把部件贴回去。
// 好处是全程只用原图已有的像素，不需要凭空生成，所以任何角色都不会出现接缝或空洞。
// 这份算法与 tools/verify-face.mjs 一一对应，改动时两边要同步。

import { normalizeParts, capabilityOf, clipRangeFor, CLIP_FALLBACK } from '../../shared/parts.js';
import { skeletonOf, drawOrder, resolvePose, boneTransforms, poseKey, frameFor, exprKey }
  from '../../shared/skeleton.js';

// 嘴张到的最大倍数。合成用的是增量重绘，脏矩形必须按这个上限预留，
// 而且传进来的值也按它夹一次，免得某个状态给出更大的值时画出脏矩形之外。
const MAX_MOUTH_OPEN = 2;

export const FIRST_FRAME_PROBE_MAX_PIXELS = 64 * 1024;

// Read back the actual final stage, not Sprite's offscreen composition buffer.
// Large/DPR-scaled stages are copied into one reusable bounded probe canvas first;
// this keeps the CPU readback fixed while preserving the final transform, clipping,
// alpha and clear state that the user really sees.
export function hasVisibleStagePixel(stageCanvas, probeCanvas,
                                     maxPixels = FIRST_FRAME_PROBE_MAX_PIXELS) {
  const width = stageCanvas?.width;
  const height = stageCanvas?.height;
  if (!Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0
      || !Number.isSafeInteger(maxPixels) || maxPixels <= 0
      || !probeCanvas?.getContext) return false;

  const area = width * height;
  const scale = Number.isSafeInteger(area) && area <= maxPixels
    ? 1 : Math.sqrt(maxPixels / area);
  let probeWidth = Math.max(1, Math.floor(width * scale));
  let probeHeight = Math.max(1, Math.floor(height * scale));
  while (probeWidth * probeHeight > maxPixels) {
    if (probeWidth >= probeHeight) probeWidth--;
    else probeHeight--;
  }
  probeCanvas.width = probeWidth;
  probeCanvas.height = probeHeight;
  const probeContext = probeCanvas.getContext('2d', { willReadFrequently: true });
  if (!probeContext) return false;
  probeContext.clearRect(0, 0, probeWidth, probeHeight);
  probeContext.imageSmoothingEnabled = true;
  probeContext.drawImage(stageCanvas, 0, 0, width, height, 0, 0, probeWidth, probeHeight);
  const pixels = probeContext.getImageData(0, 0, probeWidth, probeHeight).data;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 8) return true;
  }
  return false;
}

export class Sprite {
  constructor(character) {
    this.meta = character.meta;
    // 规整成 role 数组：素材可能是 v0(eyeL/eyeR) / v1(eyes 数组) / v2(role 数组) 任一种，
    // 运行时只认规整后的形态，兼容逻辑全部收在 shared/parts.js 里。
    this.partList = normalizeParts(character.meta.parts);
    this.capability = capabilityOf(character.meta);
    this.outline = character.meta.outline || [0, 0, 0];
    this.size = character.meta.sprite;
    this.spriteImg = null;
    this.atlasImg = null;
    this.rowSpans = null;   // 部件每一行的不透明列区间，画眼睑线时用
    this.faceRect = null;   // 需要重绘的脸部矩形
    this.canvas = null;     // 合成结果
    this.ctx = null;
    this._key = '';
    // 多帧素材（精灵表切分）：精灵图是一条横向排列的帧带
    this.frames = character.meta.frames || null;
    this.frameIndex = 0;
    this.frameTime = 0;
    // 当前播放区间。没有 clips 的素材就是整条帧带，行为与分段之前完全一致。
    this.clipRange = clipRangeFor(character.meta, CLIP_FALLBACK);
    this.clipState = null;
    // 关节骨架（v3 素材）。和帧带互斥，导入边界已经拒过同时声明两者的素材，
    // 这里再取一次是因为磁盘上的老文件走的是宽松校验路径。
    this.skeleton = this.frames && this.frames.count > 1 ? null : skeletonOf(character.meta);
    this.boneOrder = drawOrder(this.skeleton);
    this.boneAngles = new Map();
    this.boneKey = '';
  }

  // 运动信号 -> 关节档位。由主循环每帧在 brain.update 之后调用（信号必须是本帧的），
  // 返回值直接当作 render-policy 的 frameKey：档位是整数，同一姿势永远同一个键，
  // 亚像素抖动不会产生新键，跳帧机制因此对骨架角色同样成立。
  applySignals(signals, blink, mouthOpen) {
    if (!this.skeleton) return null;
    this.boneAngles = resolvePose(this.skeleton, signals);
    // 表情也要进键：姿势没变、图换了，光看关节档位看不出来，
    // 跳帧会把一次眨眼整个冻住。
    this.boneKey = poseKey(this.skeleton, this.boneAngles)
      + '|' + exprKey(this.skeleton, blink, mouthOpen);
    return 'b' + this.boneKey;
  }

  // 行为状态 -> 播放区间。由主循环每帧调用，同名状态直接返回，切段才重置相位。
  setClip(state) {
    if (!this.clipRange || state === this.clipState) return;
    this.clipState = state;
    const next = clipRangeFor(this.meta, state);
    if (!next || (next[0] === this.clipRange[0] && next[1] === this.clipRange[1])) return;
    this.clipRange = next;
    // 从段首重新起算：沿用上一段的相位会让新段从中间某帧切进去，
    // 一段只有两三帧的招手看起来就是"漏掉了开头"。
    this.frameIndex = next[0];
    this.frameTime = 0;
  }

  get eyes() {
    return this.partList.filter(p => p.role === 'eye');
  }

  get mouth() {
    return this.partList.find(p => p.role === 'mouth') || null;
  }

  get hasFace() {
    // 口型是独立能力：只有嘴、没有可靠眼睛的角色仍然应该说话。
    // 管理器预览也按这个契约工作，运行时不能因 blink=false 跳过整个合成层。
    // 注意骨架角色也可能是 true——它的 blink/talk 来自骨骼的 expr 替换帧，
    // 走的是完全不同的实现。凡是按 hasFace 去碰 parts 覆盖层的代码，
    // 都必须另外排除骨架角色。
    return this.capability.blink || this.capability.talk;
  }

  // 推进帧动画。由主循环按真实 dt 调用，与渲染帧率解耦。
  tick(dt) {
    if (!this.frames || this.frames.count < 2 || !this.clipRange) return;
    const [start, end] = this.clipRange;
    // 区间之外一律拉回段首：下面的取模是相对 start 的，索引落在区间外会算出
    // 一个仍然在区间外的结果，一帧错位会永远错下去。
    if (this.frameIndex < start || this.frameIndex > end) this.frameIndex = start;
    const span = end - start + 1;
    const spf = 1 / Math.max(1, this.frames.fps || 10);
    this.frameTime += dt;
    while (this.frameTime >= spf) {
      this.frameTime -= spf;
      this.frameIndex = start + ((this.frameIndex - start + 1) % span);
    }
  }

  async load(character) {
    this.spriteImg = await loadImage(character.spriteDataURL);
    this.atlasImg = character.atlasDataURL ? await loadImage(character.atlasDataURL) : null;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size.width;
    this.canvas.height = this.size.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.ctx.imageSmoothingEnabled = false;

    // 骨架角色必须排除：它的 hasFace 来自骨骼的 expr 替换帧，而 partList 是空的。
    // 在空表上算脸部矩形会得到 Math.min(...[]) === Infinity，faceRect 变成一个
    // 由 Infinity 组成的矩形。今天无害只是因为 compose 的骨架分支先返回了——
    // 这正是"测试全绿但埋着一条不可能成立的状态"的形状，所以在源头挡掉。
    if (this.hasFace && this.atlasImg && !this.skeleton) {
      this.rowSpans = this.#measureRowSpans();
      this.faceRect = this.#computeFaceRect();
    }
    this.compose(1, 1);
    return this;
  }

  // 预读图集的 alpha，得到每个部件每一行的不透明列区间。
  // 眼睑线只画在这个区间内，否则闭眼时黑线会甩到脸颊上。
  #measureRowSpans() {
    const c = document.createElement('canvas');
    c.width = this.atlasImg.width;
    c.height = this.atlasImg.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = false;
    cx.drawImage(this.atlasImg, 0, 0);
    const img = cx.getImageData(0, 0, c.width, c.height);

    const spans = {};
    for (const p of this.partList) {
      if (!p.frame) continue;
      // id 是图集帧与 rowSpans 的查表键。旧素材是 eyeL/eyeR，新素材是 eye0/eye1，
      // 两者都必须原样保留——换了键就查不到区间，闭眼会从"两条黑线"退化成"眼睛缩没"。
      const name = p.id;
      const rows = [];
      for (let y = 0; y < p.h; y++) {
        let min = -1, max = -1;
        for (let x = 0; x < p.w; x++) {
          const a = img.data[((p.frame.sy + y) * c.width + p.frame.sx + x) * 4 + 3];
          if (a > 0) { if (min < 0) min = x; max = x; }
        }
        rows.push(min < 0 ? null : [min, max]);
      }
      spans[name] = rows;
    }
    return spans;
  }

  // 每帧只重画这个矩形，所以它必须覆盖住任何表情可能画到的最大范围。
  // 嘴是向下拉伸的：张到 MAX_MOUTH_OPEN 时会画到 mouth.y + mouth.h * MAX_MOUTH_OPEN，
  // 若按各部件原始高度取下边界，溢出的那几行永远清不掉，残影会一直留在下巴上。
  #computeFaceRect() {
    const ps = this.partList.filter(p => p.frame);
    const m = this.mouth;
    const x0 = Math.max(0, Math.min(...ps.map(p => p.x)));
    const y0 = Math.max(0, Math.min(...ps.map(p => p.y)) - 1); // 眼睑线会画到上沿再往上 1px
    const x1 = Math.min(this.size.width, Math.max(...ps.map(p => p.x + p.w)));
    const y1 = Math.min(this.size.height, Math.max(
      ...ps.map(p => p.y + p.h),
      m ? m.y + Math.ceil(m.h * MAX_MOUTH_OPEN) : 0,
    ));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // 该行为空就往下找最近的非空行——眼皮压到底时用下眼线的宽度画线
  #spanAtOrBelow(name, row) {
    const rows = this.rowSpans?.[name];
    if (!rows) return null;
    for (let y = Math.max(0, Math.min(row, rows.length - 1)); y < rows.length; y++) {
      if (rows[y]) return rows[y];
    }
    return null;
  }

  // 逐骨绘制：按 z 序把每个部件画到自己的世界枢轴上。
  //
  // 这里是全项目唯一一处对**局部**四边形做旋转的地方，所以像素观感的责任在这一段。
  // 三条纪律：
  //  1) imageSmoothingEnabled 全程 false（load 里设过），最近邻不糊边；
  //  2) 角度已经在 resolvePose 里量化到 angleStep 的整数倍，不会逐帧微抖出
  //     不同的采样格局——像素艺术里"抖"比"歪"难看得多；
  //  3) 平移吸附到整数像素。半像素的 translate 会让整块部件重采样，
  //     1px 的描边会碎成虚线，而这正是这套美术的骨相。
  //
  // 画布尺寸是素材声明的 sprite.width/height。抬臂这类姿势会画到绑定姿势的
  // 包围盒之外，所以作者必须把画布留出余量——这条写在 docs/poppetpack-format.md。
  #composeSkeleton(ctx, blink, mouthOpen) {
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.atlasImg) {
      // 没有图集就画不出骨架。退化成静态立绘而不是空白：
      // 一只不动的桌宠仍然是一只桌宠，一块空白是一个 bug。
      if (this.spriteImg) ctx.drawImage(this.spriteImg, 0, 0);
      return;
    }
    const nodes = boneTransforms(this.skeleton, this.boneAngles);
    for (const bone of this.boneOrder) {
      const node = nodes.get(bone.id);
      if (!node) continue;
      const f = frameFor(bone, blink, mouthOpen);
      ctx.save();
      ctx.translate(Math.round(node.x), Math.round(node.y));
      if (node.angle) ctx.rotate(node.angle * Math.PI / 180);
      ctx.drawImage(this.atlasImg, f.sx, f.sy, f.sw, f.sh,
        -bone.pivot.x, -bone.pivot.y, f.sw, f.sh);
      ctx.restore();
    }
  }

  // blink: 1=睁开 0=闭合；mouthOpen: 1=原样，<1 收拢，>1 张大
  compose(blink, mouthOpen) {
    blink = Math.min(1, Math.max(0, blink));
    mouthOpen = Math.min(MAX_MOUTH_OPEN, Math.max(0, mouthOpen));
    const key = this.skeleton
      ? `b${this.boneKey}`
      : this.frames
        ? `f${this.frameIndex}`
        : `${blink.toFixed(3)}|${mouthOpen.toFixed(3)}`;
    if (key === this._key) return this.canvas;
    this._key = key;
    if (window.__poppetPace) window.__poppetPace.miss();

    const ctx = this.ctx;
    if (this.skeleton) { this.#composeSkeleton(ctx, blink, mouthOpen); return this.canvas; }
    if (this.frames) {
      // 帧带里取出当前这一帧，画布尺寸就是单帧尺寸
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.spriteImg,
        this.frameIndex * this.size.width, 0, this.size.width, this.size.height,
        0, 0, this.size.width, this.size.height);
      return this.canvas;
    }
    if (!this.hasFace || !this.atlasImg) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.spriteImg, 0, 0);
      return this.canvas;
    }

    const faceIntact = blink >= 0.999 && Math.abs(mouthOpen - 1) < 0.001;
    if (this._drawnBase !== true) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.spriteImg, 0, 0);
      this._drawnBase = true;
    } else {
      // 只重画脸，身体部分保持不变
      const f = this.faceRect;
      ctx.clearRect(f.x, f.y, f.w, f.h);
      ctx.drawImage(this.spriteImg, f.x, f.y, f.w, f.h, f.x, f.y, f.w, f.h);
    }
    if (faceIntact) return this.canvas;

    for (const p of this.eyes) {
      if (blink >= 0.999) break;
      const name = p.id;
      // 1) 背景板抹掉整只眼
      ctx.drawImage(this.atlasImg, p.cleanFrame.sx, p.cleanFrame.sy, p.w, p.h, p.x, p.y, p.w, p.h);
      // 2) 眼睛只保留下部 blink 比例：源与目标 1:1 裁切，不做缩放。
      //    blink 不取到 0，留下的几像素正是原图的下眼线，闭眼才像"合上"而不是"消失"。
      const keep = Math.max(0, Math.round(p.h * blink));
      if (keep > 0) {
        ctx.drawImage(this.atlasImg,
          p.frame.sx, p.frame.sy + (p.h - keep), p.w, keep,
          p.x, p.y + (p.h - keep), p.w, keep);
      }
      // 3) 眼睑线
      // 只要眼睛有一点闭合就补这条眼睑线。
      // 眼睛顶部原本就有一条睫毛线，按 blink 裁掉上部时它一起被裁走了，
      // 这条线正是把它补回来。
      if (blink < 0.95) {
        const lidRow = p.h - keep;
        const span = this.#spanAtOrBelow(name, lidRow);
        if (span) {
          ctx.fillStyle = `rgb(${this.outline[0]},${this.outline[1]},${this.outline[2]})`;
          ctx.fillRect(p.x + span[0], p.y + lidRow, span[1] - span[0] + 1, 1);
          if (blink < 0.3) ctx.fillRect(p.x + span[0], p.y + lidRow - 1, span[1] - span[0] + 1, 1);
        }
      }
    }

    const m = this.mouth;
    if (m && Math.abs(mouthOpen - 1) > 0.001) {
      ctx.drawImage(this.atlasImg, m.cleanFrame.sx, m.cleanFrame.sy, m.w, m.h, m.x, m.y, m.w, m.h);
      const nh = Math.max(1, Math.round(m.h * mouthOpen));
      // 纵向缩放，锚在嘴的上沿（张嘴是下巴往下掉，不是整张嘴变大）
      ctx.drawImage(this.atlasImg, m.frame.sx, m.frame.sy, m.w, m.h, m.x, m.y, m.w, nh);
    }
    return this.canvas;
  }
}

function loadImage(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataURL;
  });
}

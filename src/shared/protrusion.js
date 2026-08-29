// 轮廓凸起（protrusion）检测：只靠剪影几何找出"突出末端"，不理解语义。
//
// 与五官检测是**结构上不同**的两件事：眼睛和嘴是被身体包住的**内部区域**，
// 尾巴/耳朵/翅膀是长在剪影边界上的**外部凸起**。所以它们各有各的探测器，
// 不是一个分类器分两类。
//
// 方法：剪影 S -> 开运算 O = dilate^k(erode^k(S)) -> 残差 R = S \ O 的连通域即候选。
// 结构元必须用方形(8邻域)：菱形结构元会把每个凸角削掉一个三角，
// 纯矩形的角色会凭空冒出四个"凸起"。像素画多是轴对齐的，方形结构元对矩形是恒等的。
//
// 阈值全部来自**真实手绘素材**（547 张 CC0 素材，见 README「闸门结果」），不是合成 fixture：
// fixture 上定出来的"实心度 >= 0.80"会扔掉几乎每一个真实附肢——
// 斜的带弧度的尾巴 bbox 里大半是空的，老鼠尾巴实心度只有 0.50。
//
// 这里的输出**只能当候选**：命名不可靠（老鼠的尾巴会被判成"腿"），
// 定位也不完美（天使的翅膀会框到袍角）。所以它进管线只产生 suggestions，
// 永远不直接写 parts——必须由人确认。
import { fillHoles, labelBlobs } from './imageops.js';

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function silhouette(img) {
  const { width: w, height: h, data } = img;
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const comps = labelBlobs(raw, w, h, 1);
  const mask = new Uint8Array(w * h);
  if (comps.length) for (const c of comps[0].cells) mask[c] = 1;
  const holes = fillHoles(mask, w, h);
  return { mask, w, h, components: comps.length, dropped: comps.slice(1).reduce((s, c) => s + c.size, 0), holes };
}

// 四邻域 BFS 得到精确的 L1 距离变换（图外算背景）
function distanceTransform(mask, w, h) {
  const dt = new Int32Array(w * h).fill(-1);
  let q = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) { dt[i] = 0; q.push(i); continue; }
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { dt[i] = 1; q.push(i); } // 贴画布边 = 贴背景
  }
  let d = 0;
  while (q.length) {
    const next = [];
    for (const cur of q) {
      const cx = cur % w, cy = (cur / w) | 0;
      for (const [dx, dy] of N4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (dt[ni] !== -1) continue;
        dt[ni] = dt[cur] + 1; next.push(ni);
      }
    }
    q = next; d++;
  }
  let max = 0;
  for (let i = 0; i < w * h; i++) if (dt[i] > max) max = dt[i];
  return { dt, max };
}

function pad(mask, w, h, p) {
  const W = w + 2 * p, H = h + 2 * p;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) out[(y + p) * W + (x + p)] = 1;
  return { mask: out, w: W, h: H };
}

// 8 邻域（方形结构元）版本。菱形结构元开运算会把每个凸角削掉一个 ~k^2/2 的三角
// （blockGuy 这种纯矩形图会凭空冒出 4 个"凸起"），方形结构元对轴对齐的像素画是恒等的。
function erode8(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    let keep = 1;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) { keep = 0; break; }
      if (!mask[ny * w + nx]) { keep = 0; break; }
    }
    out[i] = keep;
  }
  return out;
}
function dilate8(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i]) { out[i] = 1; continue; }
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) { out[i] = 1; break; }
    }
  }
  return out;
}

function opening(mask, w, h, k, se = 'square') {
  const er = se === 'square' ? erode8 : erode;
  const di = se === 'square' ? dilate8 : dilate;
  let m = mask;
  for (let i = 0; i < k; i++) m = er(m, w, h);
  for (let i = 0; i < k; i++) m = di(m, w, h);
  // 开运算是 S 的子集；4 邻域膨胀在极少数情况下会溢出，交一下保险
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] && mask[i] ? 1 : 0;
  return out;
}

function bboxOf(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area: n };
}

// ---------- 凸起检测 ----------
export function detectProtrusions(img, opts = {}) {
  const frac = opts.frac ?? 0.45;
  const se = opts.se ?? 'square';
  const sil = silhouette(img);
  const silBox = bboxOf(sil.mask, sil.w, sil.h);
  if (silBox.area === 0) return { sil, silBox, k: 0, maxDT: 0, prots: [] };
  const { max: maxDT } = distanceTransform(sil.mask, sil.w, sil.h);
  const k = opts.k ?? Math.max(2, Math.min(12, Math.round(frac * maxDT)));
  const P = k + 2;
  const { mask: S, w: W, h: H } = pad(sil.mask, sil.w, sil.h, P);
  const O = opening(S, W, H, k, se);
  const R = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) R[i] = S[i] && !O[i] ? 1 : 0;

  const minArea = opts.minArea ?? Math.max(8, Math.round(0.005 * silBox.area));
  const comps = labelBlobs(R, W, H, minArea);

  const prots = comps.map((c) => {
    opts.kRef = k;
    const inComp = new Uint8Array(W * H);
    for (const p of c.cells) inComp[p] = 1;
    // 接触面：残差里 4 邻接于开运算主体的像素
    const contact = [];
    for (const p of c.cells) {
      const cx = p % W, cy = (p / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (O[ny * W + nx]) { contact.push(p); break; }
      }
    }
    // 接触段数：8 连通分块（2 段 = 夹在两块主体之间的"接头"，不是末端凸起）
    const cset = new Set(contact);
    const seenC = new Set();
    let segments = 0;
    for (const s of contact) {
      if (seenC.has(s)) continue;
      segments++; const st = [s]; seenC.add(s);
      while (st.length) {
        const cur = st.pop(); const cx = cur % W, cy = (cur / W) | 0;
        for (const [dx, dy] of N8) {
          const ni = (cy + dy) * W + (cx + dx);
          if (cset.has(ni) && !seenC.has(ni)) { seenC.add(ni); st.push(ni); }
        }
      }
    }
    // 测地长度：从接触面在残差内 BFS，最远距离 +1
    const dist = new Map();
    let q = contact.slice(); for (const p of contact) dist.set(p, 0);
    let tip = contact[0] ?? c.cells[0], maxd = 0;
    while (q.length) {
      const next = [];
      for (const cur of q) {
        const cx = cur % W, cy = (cur / W) | 0;
        for (const [dx, dy] of N4) {
          const nx = cx + dx, ny = cy + dy;
          const ni = ny * W + nx;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || !inComp[ni] || dist.has(ni)) continue;
          const d = dist.get(cur) + 1; dist.set(ni, d); next.push(ni);
          if (d > maxd) { maxd = d; tip = ni; }
        }
      }
      q = next;
    }
    const len = maxd + 1;
    // 残差自身的最大内接厚度：开运算在弧形边界上刮下来的是一层**薄壳**（厚度≈1~2），
    // 而翅膀、鳍这类宽大附肢是一个**叶片**，内部装得下更大的圆。
    // 长/接触分不开它们——翅膀沿长边贴着身体，接触面很宽，长细比自然低。
    let thick = 0;
    {
      const d2 = new Map();
      let q2 = [];
      for (const pp of c.cells) {
        const cx = pp % W, cy = (pp / W) | 0;
        let edge = false;
        for (const [dx, dy] of N4) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || !inComp[ny * W + nx]) { edge = true; break; }
        }
        if (edge) { d2.set(pp, 1); q2.push(pp); }
      }
      while (q2.length) {
        const nx2 = [];
        for (const cur of q2) {
          const cx = cur % W, cy = (cur / W) | 0;
          for (const [dx, dy] of N4) {
            const ni = (cy + dy) * W + (cx + dx);
            if (!inComp[ni] || d2.has(ni)) continue;
            const v = d2.get(cur) + 1; d2.set(ni, v); nx2.push(ni);
            if (v > thick) thick = v;
          }
        }
        q2 = nx2;
      }
      if (!thick && c.cells.length) thick = 1;
    }
    let ccx = 0, ccy = 0;
    for (const p of contact) { ccx += p % W; ccy += (p / W) | 0; }
    ccx = contact.length ? ccx / contact.length : c.cx;
    ccy = contact.length ? ccy / contact.length : c.cy;
    const tx = tip % W, ty = (tip / W) | 0;
    const vx = tx - ccx, vy = ty - ccy;
    const dirName = Math.abs(vx) >= Math.abs(vy) ? (vx >= 0 ? '右' : '左') : (vy >= 0 ? '下' : '上');
    const angle = Math.round(Math.atan2(-vy, vx) * 180 / Math.PI); // 数学角，上为 +90
    // 换回原图坐标
    const ox0 = c.x0 - P, oy0 = c.y0 - P, ox1 = c.x1 - P, oy1 = c.y1 - P;
    return {
      area: c.size,
      areaRatio: c.size / silBox.area,
      bw: c.w, bh: c.h,
      aspect: Math.max(c.w, c.h) / Math.max(1, Math.min(c.w, c.h)),
      solidity: c.size / (c.w * c.h),
      contact: contact.length,
      segments,
      len,
      lenOverContact: len / Math.max(1, contact.length),
      thick,
      thickOverK: thick / Math.max(1, opts.kRef || 1),
      dirName, angle,
      box: [ox0, oy0, ox1, oy1],
      cx: c.cx - P, cy: c.cy - P,
      rx: (c.cx - P - silBox.x0) / Math.max(1, silBox.w),
      ry: (c.cy - P - silBox.y0) / Math.max(1, silBox.h),
      reachesBottom: (oy1) >= silBox.y1 - 2,
      reachesTop: (oy0) <= silBox.y0 + 2,
    };
  }).sort((a, b) => b.area - a.area);

  return { sil, silBox, k, maxDT, minArea, prots };
}


// fixture 上定出来的提名规则，原样搬过来——闸门要测的就是它在真实素材上还成不成立
// 默认值来自**真实素材**，不是 fixture：
//   实心度判据整条删掉（默认 0 = 不生效）。fixture 上定的 0.80 会扔掉几乎每一个
//   真实手绘附肢——老鼠尾巴实心度 0.50、猎犬尾巴 0.38、龙翼 0.48。斜的带弧度的尾巴
//   bbox 里大半是空的，实心度天然就低；0.80 是被轴对齐的合成矩形喂出来的。
//   长/接触从 0.7 提到 1.5：这是在真实素材上唯一还站得住的判据
//   （老鼠尾巴 4.33、猎犬尾巴 2.54、龙翼 1.75，而残渣是 0.20~0.33）。
export let SOLIDITY_MIN = 0;
export let LEN_MIN = 1.5;
export let THICK_MIN = 0.8;        // 残差内接厚度 / 开运算尺度 k
export let THICK_AREA_MIN = 0.02;  // 宽厚型还要够大，否则每个圆角都会提名
export function setLen(v) { LEN_MIN = v; }
export function setThick(v, a) { THICK_MIN = v; if (a !== undefined) THICK_AREA_MIN = a; }
export function setSolidity(v) { SOLIDITY_MIN = v; }   // 可用 --solidity 覆盖，用来扫这条阈值
export function nominate(p) {
  if (p.segments !== 1) return null;          // 接头，不是末端
  if (p.areaRatio < 0.01) return null;
  if (p.solidity < SOLIDITY_MIN) return null; // 默认不生效，见上面的说明

  // 两条独立的提名规则，因为附肢有两种拓扑：
  //   细长型（尾巴/呆毛/触手）——从身体伸出去，接触面窄，长/接触高。
  //   宽厚型（翅膀/鳍/耳廓）——沿着身体长边贴着长，接触面很宽，长/接触天然上不去，
  //     但它是**叶片**：残差内部装得下一个大圆。开运算在弧形边界上刮下来的残渣是
  //     厚度 1~2 的薄壳，翅膀的内接厚度能到 k 的 0.8~1.2 倍。
  //     实测：狮鹫翅膀 长/接触=0.82 厚/k=1.17，天使翅膀 1.17/0.83，而残渣是 0.20/0.17。
  const slender = p.lenOverContact >= LEN_MIN;
  const lobed = p.thickOverK >= THICK_MIN && p.areaRatio >= THICK_AREA_MIN;
  if (!slender && !lobed) return null;

  if (lobed && !slender) return 'wing/fin';   // 宽厚型不套朝向分类：翅膀朝哪边都不改变它是翅膀
  if (p.reachesBottom || (p.angle > -135 && p.angle < -45)) return 'leg';
  if (p.angle > 45 && p.angle < 135) return 'ear/ahoge';
  return 'tail';
}

// 闸门：轮廓凸起检测在**真实手绘像素画**上的提名率。
//
// 为什么需要这道闸门：这套方法在 12 个合成 fixture 上 0 假阳 0 假阴，
// 但那 12 张全是轴对齐的矩形和椭圆——而方形结构元的开运算对轴对齐矩形是恒等运算，
// 所谓"真部件实心度 0.97~1.00 vs 残渣 0.48~0.63"的漂亮间隔很可能是语料造出来的。
// 真实手绘的尾巴/耳朵是斜的、带弧度的，实心度会低得多。
// 在这道闸门跑通之前，不写摆动/脉动的运行时代码。
//
// 判据（提名率的含义）：
//   ≈0        -> 方法在真实素材上找不到东西，砍掉附肢这条线
//   0.5~3/图  -> 可用，做成"提名 + 一次确认"
//   >6/图     -> 提名太吵，确认清单必须退化成一个总开关
//
// 用法: node tools/gate-protrusion.mjs <目录> [--upscale N] [--limit N] [--list]
//   --upscale N  最近邻整数放大。形状与实心度逐像素不变，只是给形态学操作留出尺度余量，
//                用来把"方法不行"和"素材太小"这两件事分开。
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './png.mjs';
import { detectProtrusions, nominate, setSolidity, setLen, setThick,
         SOLIDITY_MIN, LEN_MIN, THICK_MIN, THICK_AREA_MIN } from '../src/shared/protrusion.js';

// ---------- 主流程 ----------
const argv = process.argv.slice(2);
const DIR = argv.find(a => !a.startsWith('--'));
const num = (flag, def) => argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : def;
const UP = num('--upscale', 1);
const LIMIT = num('--limit', Infinity);
const LIST = argv.includes('--list');
setSolidity(num('--solidity', SOLIDITY_MIN));
setLen(num('--len', LEN_MIN));
setThick(num('--thick', THICK_MIN), num('--thickarea', THICK_AREA_MIN));
// 被 import 时不跑主流程（可视化脚本要复用 detectProtrusions/nominate）
const IS_MAIN = !!process.argv[1] && process.argv[1].endsWith('gate-protrusion.mjs');
const RUN = IS_MAIN && !!DIR;
if (IS_MAIN && !DIR) {
  console.error('用法: node tools/gate-protrusion.mjs <目录> [--upscale N] [--limit N] [--solidity X] [--list]');
  process.exit(2);
}

export function upscale(img, n) {
  if (n <= 1) return img;
  const W = img.width * n, H = img.height * n;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = (((y / n) | 0) * img.width + ((x / n) | 0)) * 4, d = (y * W + x) * 4;
    out[d] = img.data[s]; out[d+1] = img.data[s+1]; out[d+2] = img.data[s+2]; out[d+3] = img.data[s+3];
  }
  return { width: W, height: H, data: out };
}

if (RUN) {
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.png')) files.push(p);
  }
})(DIR);
files.sort();

let imgs = 0, withNom = 0, totalNom = 0, empty = 0, failed = 0;
const byRole = {}, solid = [], lenR = [], areaR = [], allCand = [];
for (const f of files.slice(0, LIMIT)) {
  let img;
  try {
    const d = decodePNG(f);
    img = upscale({ width: d.width, height: d.height,
                    data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length) }, UP);
  } catch { failed++; continue; }
  let r;
  try { r = detectProtrusions(img); } catch { failed++; continue; }
  if (!r.silBox.area) { empty++; continue; }
  imgs++;
  const noms = [];
  for (const p of r.prots) {
    allCand.push(p);
    const label = nominate(p);
    if (!label) continue;
    noms.push(label);
    byRole[label] = (byRole[label] || 0) + 1;
    solid.push(p.solidity); lenR.push(p.lenOverContact); areaR.push(p.areaRatio);
  }
  if (noms.length) withNom++;
  totalNom += noms.length;
  if (LIST && noms.length) console.log(`  ${path.basename(f).padEnd(30)} ${noms.join(' ')}`);
}

const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
const q = (arr, p) => { if (!arr.length) return NaN; const s = arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(s.length*p))]; };

console.log(`\n语料 ${path.relative(process.cwd(), DIR)}  放大 x${UP}`);
console.log(`  可用图 ${imgs}  空图 ${empty}  解码/检测失败 ${failed}`);
console.log(`  有提名的图 ${withNom} (${pct(withNom, imgs)})   提名总数 ${totalNom}   平均 ${(totalNom/Math.max(1,imgs)).toFixed(2)} 个/图`);
console.log(`  分类: ${Object.entries(byRole).map(([k,v])=>k+'='+v).join('  ') || '（无）'}`);
console.log(`  候选（未过滤）共 ${allCand.length}，平均 ${(allCand.length/Math.max(1,imgs)).toFixed(2)} 个/图`);
if (solid.length) {
  console.log(`\n  被提名者的判据分布（当前判据：实心度>=${SOLIDITY_MIN}，长/接触>=${LEN_MIN}）`);
  console.log(`    实心度   p10=${q(solid,.1).toFixed(2)}  中位=${q(solid,.5).toFixed(2)}  p90=${q(solid,.9).toFixed(2)}`);
  console.log(`    长/接触  p10=${q(lenR,.1).toFixed(2)}  中位=${q(lenR,.5).toFixed(2)}  p90=${q(lenR,.9).toFixed(2)}`);
  console.log(`    面积占比 中位=${(q(areaR,.5)*100).toFixed(1)}%  p90=${(q(areaR,.9)*100).toFixed(1)}%`);
}
// 关键反问：真实素材的候选实心度长什么样？如果绝大多数候选都卡在 0.8 以下，
// 说明那条阈值是被合成语料的"矩形"性质喂出来的，不是真部件的性质。
if (allCand.length) {
  const cs = allCand.map(p => p.solidity);
  const below = cs.filter(v => v < 0.8).length;
  console.log(`\n  全部候选的实心度：中位=${q(cs,.5).toFixed(2)}  <0.80 的占 ${pct(below, cs.length)}`);
  const seg1 = allCand.filter(p => p.segments === 1 && p.areaRatio >= 0.01 && p.lenOverContact >= 0.7);
  const s2 = seg1.map(p => p.solidity);
  console.log(`  过了前三关、只差实心度那一关的候选 ${seg1.length} 个，其中实心度<0.80 的占 ${pct(s2.filter(v=>v<0.8).length, s2.length)}`);
}

}

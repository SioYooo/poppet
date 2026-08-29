// 探测原图是否存在规则的像素网格（AI 生成的"伪像素画"常常并不严格对齐）。
// 做法：对二值 alpha 轮廓取水平/垂直方向的边缘台阶宽度直方图，再对候选格宽做相位打分。
import { decodePNG } from './png.mjs';

const img = decodePNG(new URL('../assets/source/original.png', import.meta.url).pathname);
const { width: W, height: H, data } = img;
const A = (x, y) => data[(y * W + x) * 4 + 3];
const ALPHA_TH = 160;

// 1) 台阶宽度直方图：沿每一行，记录 mask 从 0->1 / 1->0 的 x 位置，
//    相邻行边缘 x 相同的连续段长度就是"台阶高"，同一行内边缘的间隔无意义，
//    所以这里改为统计左右轮廓 x 坐标在竖直方向的游程长度。
function contourRuns() {
  const leftEdge = new Array(H).fill(-1);
  const rightEdge = new Array(H).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (A(x, y) >= ALPHA_TH) { leftEdge[y] = x; break; }
    for (let x = W - 1; x >= 0; x--) if (A(x, y) >= ALPHA_TH) { rightEdge[y] = x; break; }
  }
  const runs = [];
  for (const edges of [leftEdge, rightEdge]) {
    let start = -1;
    for (let y = 1; y < H; y++) {
      if (edges[y] === -1 || edges[y - 1] === -1) { start = y; continue; }
      if (edges[y] !== edges[y - 1]) {
        if (start >= 0 && y - start > 1) runs.push(y - start);
        start = y;
      }
    }
  }
  return runs;
}

const runs = contourRuns();
const hist = {};
for (const r of runs) if (r <= 40) hist[r] = (hist[r] || 0) + 1;
console.log('轮廓台阶高度直方图（游程长度: 出现次数）：');
console.log(Object.entries(hist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('台阶总数', runs.length, '中位数', runs.slice().sort((a, b) => a - b)[runs.length >> 1]);

// 2) 相位打分：对候选格宽 g 和相位 p，统计边缘落在网格线上的比例。
function phaseScore(cell) {
  // 收集所有"颜色发生变化"的位置（水平方向）
  let best = { phase: 0, hitRate: 0 };
  const edgesX = [];
  for (let y = 80; y < H - 80; y += 7) {
    for (let x = 1; x < W; x++) {
      const i = (y * W + x) * 4, j = i - 4;
      const d = Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) +
                Math.abs(data[i + 2] - data[j + 2]) + Math.abs(data[i + 3] - data[j + 3]);
      if (d > 40) edgesX.push(x);
    }
  }
  for (let p = 0; p < cell; p++) {
    let hit = 0;
    for (const x of edgesX) if (((x - p) % cell + cell) % cell === 0) hit++;
    const rate = hit / edgesX.length;
    if (rate > best.hitRate) best = { phase: p, hitRate: rate };
  }
  return { cell, ...best, edges: edgesX.length, expected: 1 / cell };
}

console.log('\n候选格宽相位打分（hitRate 显著高于 expected 才说明存在网格）：');
for (const c of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16]) {
  const s = phaseScore(c);
  const lift = s.hitRate / s.expected;
  console.log(`cell=${String(c).padStart(2)} phase=${String(s.phase).padStart(2)} hitRate=${s.hitRate.toFixed(4)} expected=${s.expected.toFixed(4)} lift=${lift.toFixed(2)}x`);
}

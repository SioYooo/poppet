// 清理本地构建产物。electron-builder 的输出很大（单次 mac+win 打包约 1.5 GB），
// 而且它**不会**清掉上一次的结果：改名前的 KTT 产物会和 Poppet 的并排堆着，
// 磁盘上越积越多而没人注意。
//
//   node tools/clean-build.mjs            # 看看会删什么，不动手
//   node tools/clean-build.mjs --yes      # 真的删
//   node tools/clean-build.mjs --yes --caches   # 连 Electron/builder 下载缓存一起
//
// 只删**已知的打包器输出形状**，不做"清空目录"。理由很具体：dist/ 里也放着
// tools/make-rig-demo.mjs 产出的演示角色包与对照图，按目录清空会把它们一起删掉，
// 而它们不是构建产物、也重建不出同一份字节（预览图来自一次真实抓帧）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--yes');
const WITH_CACHES = process.argv.includes('--caches');

// 打包器输出的扩展名与目录名。清单是白名单式的：没登记的一律不碰。
const BUILD_EXTENSIONS = new Set([
  '.dmg', '.zip', '.exe', '.blockmap', '.appx', '.appxbundle', '.msix',
  '.AppImage', '.deb', '.rpm', '.snap', '.pkg', '.tar.gz',
]);
const BUILD_DIRS = new Set([
  'mac', 'mac-arm64', 'mac-universal', 'win-unpacked', 'win-arm64-unpacked',
  'linux-unpacked', 'linux-arm64-unpacked', '.icon-set', '.icon-ico',
]);
// electron-builder 写的元数据。latest*.yml 是自动更新元数据，
// tools/verify-package.mjs 明确把它当成不该出现的东西，留在磁盘上只会误导。
const BUILD_FILES = new Set(['builder-debug.yml', 'latest.yml', 'latest-mac.yml', 'latest-linux.yml']);

function sizeOf(target) {
  let total = 0;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) total += sizeOf(path.join(target, entry));
    return total;
  }
  return stat.size;
}

const human = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
};

function collectFrom(dir, { everything = false } = {}) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const target = path.join(abs, entry.name);
    // 符号链接一律跳过：跟着它走可能删到仓库外面去。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (everything || BUILD_DIRS.has(entry.name)) out.push(target);
      continue;
    }
    const ext = entry.name.endsWith('.tar.gz') ? '.tar.gz' : path.extname(entry.name);
    if (everything || BUILD_EXTENSIONS.has(ext) || BUILD_FILES.has(entry.name)) out.push(target);
  }
  return out;
}

const targets = [
  ...collectFrom('dist'),
  // release-assets 整个目录都是 collect-release-assets.mjs 重新生成的，
  // 没有任何手工内容，所以这里可以按目录清。
  ...collectFrom('release-assets', { everything: true }),
];

if (WITH_CACHES) {
  for (const cache of [
    path.join(os.homedir(), 'Library/Caches/electron'),
    path.join(os.homedir(), 'Library/Caches/electron-builder'),
    path.join(os.homedir(), '.cache/electron'),
    path.join(os.homedir(), '.cache/electron-builder'),
    path.join(ROOT, '.electron-builder-cache'),
  ]) {
    if (fs.existsSync(cache) && !fs.lstatSync(cache).isSymbolicLink()) targets.push(cache);
  }
}

if (!targets.length) {
  console.log('没有可清理的构建产物。');
  process.exit(0);
}

let total = 0;
for (const target of targets) {
  const bytes = sizeOf(target);
  total += bytes;
  const rel = target.startsWith(ROOT) ? path.relative(ROOT, target) : target;
  console.log(`  ${APPLY ? '删除' : '将删除'}  ${human(bytes).padStart(9)}  ${rel}`);
  if (APPLY) fs.rmSync(target, { recursive: true, force: true });
}

// 留下的东西也报一句：清理工具最容易犯的错是安静地多删一点。
// 干跑时必须减掉待删项再报，否则会把「将删」的东西也说成「保留」——
// 一个自相矛盾的清单会让人不敢按下 --yes。
const distDir = path.join(ROOT, 'dist');
const doomed = new Set(targets.filter(t => path.dirname(t) === distDir).map(t => path.basename(t)));
const keptDist = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter(name => APPLY || !doomed.has(name)) : [];
if (keptDist.length) console.log(`\n  保留 dist/ 中 ${keptDist.length} 项: ${keptDist.join(', ')}`);
else console.log('\n  dist/ 将被清空');

console.log(`\n${APPLY ? '已回收' : '可回收'} ${human(total)}`);
if (!APPLY) console.log('加 --yes 真的执行；再加 --caches 连 Electron 下载缓存一起清（下次打包要重新下载约 1.2 GB）。');

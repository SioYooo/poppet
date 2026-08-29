// 从金发默认角色生成固定品牌图标：macOS 的 .icns、Windows 的 .ico，以及系统托盘图。
// 放大一律用最近邻整数倍，像素画放大后依然是硬边，比插值好看得多。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePNG, encodePNG, createImage } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRAND_CHARACTER_ID = 'default';
export const BRAND_SOURCE_PATH = path.join(
  ROOT, 'assets/characters', BRAND_CHARACTER_ID, 'pet.png');

const sprite = decodePNG(BRAND_SOURCE_PATH);

// 角色等比放进正方形画布，底部留一点边，视觉上"站"在图标里
export function renderBrandIcon(size) {
  const out = createImage(size, size);
  const inner = size * 0.88;
  const scale = Math.min(inner / sprite.width, inner / sprite.height);
  const dw = Math.max(1, Math.round(sprite.width * scale));
  const dh = Math.max(1, Math.round(sprite.height * scale));
  const ox = Math.round((size - dw) / 2);
  const oy = Math.round((size - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sprite.height - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sprite.width - 1, Math.floor(x / scale));
      const si = (sy * sprite.width + sx) * 4;
      if (sprite.data[si + 3] === 0) continue;
      const di = ((y + oy) * size + x + ox) * 4;
      out.data[di] = sprite.data[si];
      out.data[di + 1] = sprite.data[si + 1];
      out.data[di + 2] = sprite.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

// Vista 起 ICO 可以直接内嵌 PNG，比 BMP 分支简单得多，也支持 alpha。
function writeICO(file, sizes) {
  const build = path.dirname(file);
  const pngs = sizes.map(size => {
    const img = renderBrandIcon(size);
    const tmp = path.join(build, `.ico-${size}.png`);
    encodePNG(tmp, img);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return { size, buf };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    entries[o] = p.size >= 256 ? 0 : p.size;      // 0 表示 256
    entries[o + 1] = p.size >= 256 ? 0 : p.size;
    entries[o + 2] = 0;                            // 调色板色数
    entries[o + 3] = 0;                            // reserved
    entries.writeUInt16LE(1, o + 4);               // color planes
    entries.writeUInt16LE(32, o + 6);              // bits per pixel
    entries.writeUInt32LE(p.buf.length, o + 8);
    entries.writeUInt32LE(offset, o + 12);
    offset += p.buf.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, entries, ...pngs.map(p => p.buf)]));
}

export function generateBrandIcons({
  outputRoot = ROOT,
  targetPlatform = process.platform,
  runIconutil = execFileSync,
} = {}) {
  const build = path.join(outputRoot, 'build');
  const iconset = path.join(build, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });

  const icnsSizes = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of icnsSizes) {
    encodePNG(path.join(iconset, name), renderBrandIcon(size));
  }

  let icnsOk = false;
  if (targetPlatform === 'darwin') {
    // macOS 构建必须 fail-closed：iconutil 失败时不能保留旧 .icns 却继续报告成功。
    runIconutil('iconutil', [
      '-c', 'icns', iconset, '-o', path.join(build, 'icon.icns'),
    ], { stdio: 'pipe' });
    icnsOk = true;
  } else {
    console.warn('⚠ 当前平台不生成 .icns；请在受支持的 macOS 构建机上完成并验证');
  }

  writeICO(path.join(build, 'icon.ico'), [16, 24, 32, 48, 64, 128, 256]);

  // 文件名为兼容既有包清单继续保留；运行时始终把它当作品牌图标。
  const trayPath = path.join(outputRoot, 'assets/tray-fallback.png');
  fs.mkdirSync(path.dirname(trayPath), { recursive: true });
  encodePNG(trayPath, renderBrandIcon(44));

  console.log(`图标已生成到 build/：${icnsOk ? 'icon.icns, ' : ''}icon.ico, icon.iconset/`);
  console.log('系统托盘品牌图：assets/tray-fallback.png');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) generateBrandIcons();

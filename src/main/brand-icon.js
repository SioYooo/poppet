'use strict';

const path = require('node:path');

const BRAND_TRAY_ICON_PATH = path.join(__dirname, '../../assets/tray-fallback.png');

function brandIconError(code, message) {
  return Object.assign(new Error(message), { code });
}

function loadBrandTrayImage({ existsSync, trayImage }) {
  if (!existsSync(BRAND_TRAY_ICON_PATH)) {
    throw brandIconError('POPPET_BRAND_ICON_MISSING', 'Poppet 品牌托盘图标缺失');
  }
  const image = trayImage(BRAND_TRAY_ICON_PATH);
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) {
    throw brandIconError('POPPET_BRAND_ICON_INVALID', 'Poppet 品牌托盘图标无法读取');
  }
  return image;
}

module.exports = { BRAND_TRAY_ICON_PATH, loadBrandTrayImage };

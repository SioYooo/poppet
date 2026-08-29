'use strict';

const { captureElectronNotices } = require('./electron-notices.cjs');

async function captureTargetElectronNotices(context) {
  if (!['darwin', 'win32'].includes(context.electronPlatformName)) return;
  captureElectronNotices(context);
}

module.exports = captureTargetElectronNotices;

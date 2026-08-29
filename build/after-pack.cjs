const fs = require('node:fs');
const path = require('node:path');
const {
  ELECTRON_NOTICE_FILES,
  getTargetContract,
  verifyElectronNoticeBundle,
} = require('./electron-notices.cjs');

const FORBIDDEN_MAC_INFO_KEYS = Object.freeze([
  'NSAppTransportSecurity',
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]);

function isForbiddenMacInfoKey(key) {
  return key === 'NSAppTransportSecurity' || /^NS.*UsageDescription$/.test(key);
}

function assertRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`afterPack expected a regular ${label}: ${file}`);
  }
}

async function finalizePackage(context) {
  if (!['darwin', 'win32'].includes(context.electronPlatformName)) return;
  const contract = getTargetContract(context);

  if (context.electronPlatformName === 'win32') {
    const resourcesPath = path.join(context.appOutDir, 'resources');
    verifyElectronNoticeBundle({
      resourcesPath,
      noticeRoot: context.appOutDir,
      expectedPlatform: contract.platform,
      expectedArch: contract.arch,
    });
    return;
  }

  const plist = await import('plist');

  const productFilename = context.packager?.appInfo?.productFilename;
  if (typeof productFilename !== 'string' || !productFilename) {
    throw new Error('afterPack could not resolve the macOS product filename');
  }

  const infoPath = path.join(
    context.appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Info.plist',
  );
  assertRegularFile(infoPath, 'Info.plist');

  const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
  for (const key of Object.keys(info)) {
    if (isForbiddenMacInfoKey(key)) delete info[key];
  }

  const temporaryPath = `${infoPath}.poppet-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, plist.build(info), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  fs.renameSync(temporaryPath, infoPath);

  const resourcesPath = path.join(path.dirname(infoPath), 'Resources');
  const resourcesStat = fs.lstatSync(resourcesPath);
  if (!resourcesStat.isDirectory() || resourcesStat.isSymbolicLink()) {
    throw new Error(`afterPack expected a regular Resources directory: ${resourcesPath}`);
  }
  verifyElectronNoticeBundle({
    resourcesPath,
    noticeRoot: resourcesPath,
    expectedPlatform: contract.platform,
    expectedArch: contract.arch,
  });
}

finalizePackage.FORBIDDEN_MAC_INFO_KEYS = FORBIDDEN_MAC_INFO_KEYS;
finalizePackage.ELECTRON_NOTICE_FILES = ELECTRON_NOTICE_FILES;
finalizePackage.isForbiddenMacInfoKey = isForbiddenMacInfoKey;
module.exports = finalizePackage;

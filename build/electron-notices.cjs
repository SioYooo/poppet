'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ELECTRON_PACKAGE_ROOT = path.dirname(require.resolve('electron/package.json'));
const ELECTRON_PACKAGE = JSON.parse(
  fs.readFileSync(path.join(ELECTRON_PACKAGE_ROOT, 'package.json'), 'utf8'),
);
const PROJECT_PACKAGE = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const ELECTRON_CHECKSUMS = JSON.parse(
  fs.readFileSync(path.join(ELECTRON_PACKAGE_ROOT, 'checksums.json'), 'utf8'),
);

const MANIFEST_NAME = 'POPPET_ELECTRON_NOTICES.json';
const MANIFEST_SCHEMA_VERSION = 1;
const ELECTRON_NOTICE_FILES = Object.freeze([
  Object.freeze({
    packagedName: 'LICENSE.electron.txt',
    manifestSource: 'electron-npm-package-root/LICENSE',
  }),
  Object.freeze({
    packagedName: 'LICENSES.chromium.html',
    manifestSource: 'electron-builder-target-distribution/LICENSES.chromium.html',
  }),
]);

function assertRegularDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    throw new Error(`missing ${label}: ${error.code || error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory: ${directory}`);
  }
}

function readRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`missing ${label}: ${error.code || error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${file}`);
  }
  return fs.readFileSync(file);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function normalizeArch(value) {
  const arch = typeof value === 'number' ? Arch[value] : value;
  if (!['ia32', 'x64', 'armv7l', 'arm64', 'universal'].includes(arch)) {
    throw new Error(`Electron notice capture received an unsupported architecture: ${value}`);
  }
  return arch;
}

function getTargetContract(context) {
  const platform = context?.electronPlatformName;
  if (!['darwin', 'win32'].includes(platform)) {
    throw new Error(`Electron notice capture received an unsupported platform: ${platform}`);
  }

  const configuredDistribution = context.packager?.config?.electronDist;
  if (configuredDistribution != null) {
    throw new Error('Poppet Electron notice preservation requires electron-builder default distribution');
  }

  const electronVersion = ELECTRON_PACKAGE.version;
  if (PROJECT_PACKAGE.devDependencies?.electron !== electronVersion) {
    throw new Error(
      `Electron package contract mismatch: package.json=${PROJECT_PACKAGE.devDependencies?.electron || 'missing'} installed=${electronVersion}`,
    );
  }
  if (context.packager?.config?.electronVersion !== electronVersion) {
    throw new Error(
      `Electron builder version mismatch: configured=${context.packager?.config?.electronVersion || 'missing'} installed=${electronVersion}`,
    );
  }

  const arch = normalizeArch(context.arch);
  const expectedArtifactName = `electron-v${electronVersion}-${platform}-${arch}.zip`;
  const expectedArchiveSha256 = ELECTRON_CHECKSUMS[expectedArtifactName];
  if (typeof expectedArchiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedArchiveSha256)) {
    throw new Error(`Electron checksum contract is missing for ${expectedArtifactName}`);
  }

  return {
    platform,
    arch,
    electronVersion,
    expectedArtifactName,
    expectedArchiveSha256,
  };
}

function resolveExtractPaths(context) {
  const contract = getTargetContract(context);
  assertRegularDirectory(context.appOutDir, 'electron-builder extraction directory');

  if (contract.platform === 'darwin') {
    const appName = context.packager?.info?.framework?.distMacOsAppName;
    if (typeof appName !== 'string' || path.basename(appName) !== appName || !appName.endsWith('.app')) {
      throw new Error('Electron notice capture could not resolve the extracted macOS app name');
    }
    const resourcesPath = path.join(context.appOutDir, appName, 'Contents', 'Resources');
    assertRegularDirectory(resourcesPath, 'extracted macOS Resources directory');
    return {
      contract,
      resourcesPath,
      noticeRoot: resourcesPath,
      distributionLicensePath: path.join(context.appOutDir, 'LICENSE'),
      distributionChromiumPath: path.join(context.appOutDir, 'LICENSES.chromium.html'),
    };
  }

  const resourcesPath = path.join(context.appOutDir, 'resources');
  assertRegularDirectory(resourcesPath, 'extracted Windows resources directory');
  return {
    contract,
    resourcesPath,
    noticeRoot: context.appOutDir,
    distributionLicensePath: path.join(context.appOutDir, 'LICENSE.electron.txt'),
    distributionChromiumPath: path.join(context.appOutDir, 'LICENSES.chromium.html'),
  };
}

function writeRegularFile(file, bytes, label) {
  if (fs.existsSync(file)) {
    readRegularFile(file, label);
  }
  fs.writeFileSync(file, bytes, { mode: 0o644 });
  const written = readRegularFile(file, label);
  if (!written.equals(bytes)) throw new Error(`failed to preserve ${label} bytes`);
}

function writeManifest(resourcesPath, manifest) {
  const manifestPath = path.join(resourcesPath, MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) readRegularFile(manifestPath, 'Electron notice manifest');
  const temporaryPath = `${manifestPath}.poppet-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
  fs.renameSync(temporaryPath, manifestPath);
}

function captureElectronNotices(context) {
  const {
    contract,
    resourcesPath,
    noticeRoot,
    distributionLicensePath,
    distributionChromiumPath,
  } = resolveExtractPaths(context);
  const packageLicensePath = path.join(ELECTRON_PACKAGE_ROOT, 'LICENSE');
  const packageLicense = readRegularFile(packageLicensePath, 'Electron package-root LICENSE');
  const distributionLicense = readRegularFile(
    distributionLicensePath,
    'electron-builder target-distribution LICENSE',
  );
  if (!distributionLicense.equals(packageLicense)) {
    throw new Error('Electron target-distribution LICENSE differs from package-root LICENSE contract');
  }
  const chromiumNotice = readRegularFile(
    distributionChromiumPath,
    'electron-builder target-distribution LICENSES.chromium.html',
  );

  if (contract.platform === 'darwin') {
    writeRegularFile(
      path.join(noticeRoot, 'LICENSE.electron.txt'),
      packageLicense,
      'packaged Electron LICENSE.electron.txt',
    );
    writeRegularFile(
      path.join(noticeRoot, 'LICENSES.chromium.html'),
      chromiumNotice,
      'packaged Electron LICENSES.chromium.html',
    );
  }

  const noticeBytes = new Map([
    ['LICENSE.electron.txt', readRegularFile(
      path.join(noticeRoot, 'LICENSE.electron.txt'),
      'packaged Electron LICENSE.electron.txt',
    )],
    ['LICENSES.chromium.html', readRegularFile(
      path.join(noticeRoot, 'LICENSES.chromium.html'),
      'packaged Electron LICENSES.chromium.html',
    )],
  ]);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    electronVersion: contract.electronVersion,
    target: { platform: contract.platform, arch: contract.arch },
    // This records the pinned official artifact expectation from Electron's npm
    // package. Poppet does not observe the archive that electron-builder downloaded,
    // so this must never be presented as verified archive provenance.
    expectedOfficialArtifact: {
      artifactName: contract.expectedArtifactName,
      sha256: contract.expectedArchiveSha256,
      source: 'electron-npm-package/checksums.json',
      archiveVerification: 'not-observed-by-poppet',
    },
    notices: Object.fromEntries(ELECTRON_NOTICE_FILES.map(({ packagedName, manifestSource }) => {
      const bytes = noticeBytes.get(packagedName);
      return [packagedName, { source: manifestSource, bytes: bytes.length, sha256: sha256(bytes) }];
    })),
  };
  writeManifest(resourcesPath, manifest);
  verifyElectronNoticeBundle({
    resourcesPath,
    noticeRoot,
    expectedPlatform: contract.platform,
    expectedArch: contract.arch,
  });
  return manifest;
}

function parseManifest(resourcesPath) {
  const bytes = readRegularFile(
    path.join(resourcesPath, MANIFEST_NAME),
    'Electron notice manifest',
  );
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Electron notice manifest is not valid JSON: ${error.message}`);
  }
  return manifest;
}

function verifyElectronNoticeBundle({ resourcesPath, noticeRoot, expectedPlatform, expectedArch = null }) {
  assertRegularDirectory(resourcesPath, 'packaged Resources directory');
  assertRegularDirectory(noticeRoot, 'packaged Electron notice directory');
  const manifest = parseManifest(resourcesPath);
  if (!hasExactKeys(manifest, [
    'schemaVersion',
    'electronVersion',
    'target',
    'expectedOfficialArtifact',
    'notices',
  ])) {
    throw new Error('Electron notice manifest has unexpected top-level fields');
  }
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Electron notice manifest schema mismatch: ${manifest?.schemaVersion ?? 'missing'}`);
  }
  if (manifest.electronVersion !== ELECTRON_PACKAGE.version) {
    throw new Error(
      `Electron notice manifest version mismatch: ${manifest.electronVersion || 'missing'} != ${ELECTRON_PACKAGE.version}`,
    );
  }
  if (manifest.target?.platform !== expectedPlatform) {
    throw new Error(
      `Electron notice manifest platform mismatch: ${manifest.target?.platform || 'missing'} != ${expectedPlatform}`,
    );
  }
  if (!hasExactKeys(manifest.target, ['platform', 'arch'])) {
    throw new Error('Electron notice manifest target fields are invalid');
  }
  const manifestArch = normalizeArch(manifest.target?.arch);
  if (expectedArch != null && manifestArch !== normalizeArch(expectedArch)) {
    throw new Error(`Electron notice manifest architecture mismatch: ${manifestArch} != ${normalizeArch(expectedArch)}`);
  }

  const artifactName = `electron-v${ELECTRON_PACKAGE.version}-${expectedPlatform}-${manifestArch}.zip`;
  const expectedArchiveSha256 = ELECTRON_CHECKSUMS[artifactName];
  if (typeof expectedArchiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedArchiveSha256)) {
    throw new Error(`Electron checksum contract is missing for ${artifactName}`);
  }
  if (!hasExactKeys(manifest.expectedOfficialArtifact, [
    'artifactName',
    'sha256',
    'source',
    'archiveVerification',
  ])
      || manifest.expectedOfficialArtifact?.artifactName !== artifactName
      || manifest.expectedOfficialArtifact?.sha256 !== expectedArchiveSha256
      || manifest.expectedOfficialArtifact?.source !== 'electron-npm-package/checksums.json'
      || manifest.expectedOfficialArtifact?.archiveVerification !== 'not-observed-by-poppet') {
    throw new Error(`Electron notice manifest official artifact expectation mismatch for ${artifactName}`);
  }

  const manifestNoticeNames = Object.keys(manifest.notices || {}).sort();
  const expectedNoticeNames = ELECTRON_NOTICE_FILES.map(({ packagedName }) => packagedName).sort();
  if (JSON.stringify(manifestNoticeNames) !== JSON.stringify(expectedNoticeNames)) {
    throw new Error('Electron notice manifest has an unexpected notice inventory');
  }

  for (const { packagedName, manifestSource } of ELECTRON_NOTICE_FILES) {
    const descriptor = manifest.notices[packagedName];
    if (!hasExactKeys(descriptor, ['source', 'bytes', 'sha256'])
        || descriptor?.source !== manifestSource
        || !Number.isSafeInteger(descriptor?.bytes)
        || descriptor.bytes <= 0
        || typeof descriptor?.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
      throw new Error(`Electron notice manifest entry is invalid: ${packagedName}`);
    }
    const packaged = readRegularFile(
      path.join(noticeRoot, packagedName),
      `packaged Electron notice ${packagedName}`,
    );
    if (packaged.length !== descriptor.bytes || sha256(packaged) !== descriptor.sha256) {
      throw new Error(`stale or modified packaged Electron notice: ${packagedName}`);
    }
    if (packagedName === 'LICENSE.electron.txt') {
      const packageLicense = readRegularFile(
        path.join(ELECTRON_PACKAGE_ROOT, 'LICENSE'),
        'Electron package-root LICENSE',
      );
      if (!packaged.equals(packageLicense)) {
        throw new Error('stale or modified packaged Electron notice: LICENSE.electron.txt');
      }
    }
  }
  return manifest;
}

module.exports = {
  ELECTRON_NOTICE_FILES,
  MANIFEST_NAME,
  MANIFEST_SCHEMA_VERSION,
  captureElectronNotices,
  getTargetContract,
  normalizeArch,
  readRegularFile,
  sha256,
  verifyElectronNoticeBundle,
};

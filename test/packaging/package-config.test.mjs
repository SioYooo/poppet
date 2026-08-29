import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as plist from 'plist';

const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar');
const afterExtract = require('../../build/after-extract.cjs');
const afterPack = require('../../build/after-pack.cjs');
const {
  ELECTRON_NOTICE_FILES,
  MANIFEST_NAME: ELECTRON_NOTICE_MANIFEST,
  readRegularFile,
} = require('../../build/electron-notices.cjs');
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const afterExtractSource = fs.readFileSync(new URL('../../build/after-extract.cjs', import.meta.url), 'utf8');
const afterPackSource = fs.readFileSync(new URL('../../build/after-pack.cjs', import.meta.url), 'utf8');
const electronNoticesSource = fs.readFileSync(new URL('../../build/electron-notices.cjs', import.meta.url), 'utf8');
const verifier = fs.readFileSync(new URL('../../tools/verify-package.mjs', import.meta.url), 'utf8');
const verifierPath = fileURLToPath(new URL('../../tools/verify-package.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
const electronPackageLicense = path.join(electronPackageRoot, 'LICENSE');
// Derived from the fail-closed inventory instead of hardcoded, so authorizing or
// removing a root reference stays the two-edit operation the publication route
// documents (delete the file and its `repositoryArtwork` record; this suite
// follows). check-release-readiness.mjs independently enforces that the
// inventory and the real repository root are the same set, and the source-tarball
// test below still rejects any root raster whether or not it is inventoried.
const releasePolicy = JSON.parse(
  fs.readFileSync(new URL('../../.github/release-policy.json', import.meta.url), 'utf8'),
);
const unbundledRootCharacterArt = releasePolicy.repositoryArtwork.assets
  .map(({ path: relative }) => relative);
// A root-raster name for the packaged-entry rejection fixture; it only has to
// look like one, so it stays defined even if the inventory is ever emptied.
const rootRasterFixtureName = unbundledRootCharacterArt[0] ?? 'Unexpected-Root-Raster.PNG';

function writeFixtureFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function buildHookContext(appOutDir, electronPlatformName, arch = 'x64') {
  return {
    appOutDir,
    arch,
    electronPlatformName,
    packager: {
      appInfo: { productFilename: 'Poppet' },
      config: { electronVersion: pkg.devDependencies.electron },
      info: { framework: { distMacOsAppName: 'Electron.app' } },
    },
  };
}

async function captureFixtureElectronNotices(root, resourcesPath, packagedRoot, platform) {
  const chromiumNotice = Buffer.from(`Electron ${pkg.devDependencies.electron} ${platform} target notice fixture\n`);
  const extractRoot = platform === 'mac' ? path.join(root, 'electron-extract') : packagedRoot;
  const extractedResources = platform === 'mac'
    ? path.join(extractRoot, 'Electron.app', 'Contents', 'Resources')
    : path.join(extractRoot, 'resources');
  fs.mkdirSync(extractedResources, { recursive: true });
  writeFixtureFile(
    path.join(extractRoot, platform === 'mac' ? 'LICENSE' : 'LICENSE.electron.txt'),
    fs.readFileSync(electronPackageLicense),
  );
  writeFixtureFile(path.join(extractRoot, 'LICENSES.chromium.html'), chromiumNotice);
  await afterExtract(buildHookContext(extractRoot, platform === 'mac' ? 'darwin' : 'win32'));

  if (platform === 'mac') {
    for (const relative of [
      ...ELECTRON_NOTICE_FILES.map(({ packagedName }) => packagedName),
      ELECTRON_NOTICE_MANIFEST,
    ]) {
      writeFixtureFile(
        path.join(resourcesPath, relative),
        fs.readFileSync(path.join(extractedResources, relative)),
      );
    }
  }
  return chromiumNotice;
}

async function createVerifierFixture(t, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `poppet-package-${platform}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'asar-source');
  const packageContents = `${JSON.stringify({
    name: 'poppet-package-fixture',
    version: '1.0.0',
    main: 'src/main/index.js',
  })}\n`;
  const productionFiles = new Map([
    ['package.json', packageContents],
    ['src/main/index.js', "'use strict';\n"],
    ['assets/characters/default/character.json', '{}\n'],
    ['assets/tray-fallback.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ]);
  for (const [relative, contents] of productionFiles) {
    writeFixtureFile(path.join(root, relative), contents);
    writeFixtureFile(path.join(sourceRoot, relative), contents);
  }

  const packagedRoot = platform === 'mac'
    ? path.join(root, 'dist', 'mac', 'Poppet.app', 'Contents')
    : path.join(root, 'dist', 'win-unpacked');
  const resourcesPath = platform === 'mac'
    ? path.join(packagedRoot, 'Resources')
    : path.join(packagedRoot, 'resources');
  fs.mkdirSync(resourcesPath, { recursive: true });
  const asarPath = path.join(resourcesPath, 'app.asar');
  await createPackage(sourceRoot, asarPath);

  if (platform === 'mac') {
    writeFixtureFile(
      path.join(packagedRoot, 'Info.plist'),
      plist.build({ CFBundleIdentifier: 'com.poppet.package-fixture' }),
    );
  }

  for (const [packagedName, sourceName] of [
    ['LICENSE.POPPET.txt', 'LICENSE'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ['ASSETS_LICENSE.md', 'ASSETS_LICENSE.md'],
  ]) {
    const contents = `${sourceName} fixture\n`;
    writeFixtureFile(path.join(root, sourceName), contents);
    writeFixtureFile(path.join(resourcesPath, packagedName), contents);
  }

  const chromiumNotice = await captureFixtureElectronNotices(
    root,
    resourcesPath,
    packagedRoot,
    platform,
  );

  return { root, sourceRoot, packagedRoot, resourcesPath, asarPath, chromiumNotice };
}

function runVerifier(root, platform) {
  return spawnSync(process.execPath, [verifierPath, '--platform', platform], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('release toolchain is exact and uses the Node 22 baseline', () => {
  assert.equal(pkg.name, 'poppet');
  assert.equal(pkg.build.productName, 'Poppet');
  assert.equal(pkg.build.appId, 'com.sioyoo.poppet');
  assert.equal(pkg.build.nsis.guid, 'aff6dd02-d42c-52f2-a0d0-8591b48e503f');
  assert.equal(pkg.private, true);
  assert.equal(pkg.engines.node, '>=22.12.0 <23');
  assert.equal(pkg.devDependencies['@electron/asar'], '4.2.1');
  assert.equal(pkg.devDependencies.electron, '43.4.1');
  assert.equal(pkg.devDependencies['electron-builder'], '26.15.7');
  assert.equal(pkg.devDependencies.plist, '5.0.0');
});

test('electron-builder uses a production-only allowlist', () => {
  assert.equal(pkg.build.publish, null);
  assert.equal(pkg.build.afterExtract, 'build/after-extract.cjs');
  assert.equal(pkg.build.afterPack, 'build/after-pack.cjs');
  assert.ok(pkg.build.files.includes('src/**/*'));
  assert.ok(pkg.build.files.includes('!src/main/dev-capture.js'));
  assert.ok(pkg.build.files.includes('!src/renderer/dev/**/*'));
  assert.ok(pkg.build.files.includes('assets/characters/default/**/*'));
  assert.ok(!pkg.build.files.includes('assets/characters/**/*'));
  assert.ok(pkg.build.files.includes('!*.{png,PNG}'));
  assert.ok(pkg.build.files.includes('!test/**/*'));
  assert.ok(pkg.build.files.includes('!tools/**/*'));
  assert.ok(pkg.build.files.includes('!assets/source/**/*'));
  assert.deepEqual(pkg.build.extraResources, [
    { from: 'LICENSE', to: 'LICENSE.POPPET.txt' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: 'ASSETS_LICENSE.md', to: 'ASSETS_LICENSE.md' },
  ]);
});

test('tracked root character references stay outside production packages', () => {
  for (const relative of unbundledRootCharacterArt) {
    const source = fileURLToPath(new URL(`../../${relative}`, import.meta.url));
    assert.ok(
      fs.existsSync(source) && fs.statSync(source).isFile(),
      `${relative} is inventoried in .github/release-policy.json but is not a regular file at the repository root`,
    );
    assert.ok(!pkg.build.files.includes(relative));
    assert.ok(!pkg.build.extraResources.some(({ from }) => from === relative));
  }
});

test('source tarball excludes tracked root character references and every root raster', (t) => {
  const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-npm-pack-cache-'));
  t.after(() => fs.rmSync(npmCache, { recursive: true, force: true }));
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'pack', '--dry-run', '--json', '--ignore-scripts',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
    shell: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1);
  const packaged = reports[0].files.map(({ path: relative }) => relative);
  for (const relative of unbundledRootCharacterArt) assert.ok(!packaged.includes(relative));
  assert.deepEqual(
    packaged.filter((relative) => !relative.includes('/') && /\.(?:png|jpe?g|gif|webp)$/i.test(relative)),
    [],
  );
});

test('afterExtract rejects a substituted target license and custom Electron distribution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-after-extract-negative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Electron.app', 'Contents', 'Resources'), { recursive: true });
  writeFixtureFile(path.join(root, 'LICENSE'), 'substituted license\n');
  writeFixtureFile(path.join(root, 'LICENSES.chromium.html'), 'target chromium notice\n');
  const context = buildHookContext(root, 'darwin');

  await assert.rejects(
    afterExtract(context),
    /target-distribution LICENSE differs from package-root LICENSE contract/,
  );

  writeFixtureFile(path.join(root, 'LICENSE'), fs.readFileSync(electronPackageLicense));
  context.packager.config.electronDist = 'custom-electron';
  await assert.rejects(
    afterExtract(context),
    /notice preservation requires electron-builder default distribution/,
  );
});

test('production notice source contract rejects non-regular files and symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-notice-source-negative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const directory = path.join(root, 'not-a-file');
  fs.mkdirSync(directory);
  assert.throws(
    () => readRegularFile(directory, 'fixture notice source'),
    /fixture notice source is not a regular file/,
  );

  const target = path.join(root, 'target-license');
  const link = path.join(root, 'linked-license');
  writeFixtureFile(target, 'license fixture\n');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }
  assert.throws(
    () => readRegularFile(link, 'fixture notice symlink'),
    /fixture notice symlink is not a regular file/,
  );
});

test('production contract rejects a tampered package-root Electron LICENSE', { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-package-license-negative-'));
  const originalLicense = fs.readFileSync(electronPackageLicense);
  t.after(() => {
    fs.writeFileSync(electronPackageLicense, originalLicense);
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(root, 'Electron.app', 'Contents', 'Resources'), { recursive: true });
  writeFixtureFile(path.join(root, 'LICENSE'), originalLicense);
  writeFixtureFile(path.join(root, 'LICENSES.chromium.html'), 'target chromium notice\n');
  const tamperedLicense = Buffer.concat([originalLicense, Buffer.from('\ntampered\n')]);

  try {
    fs.writeFileSync(electronPackageLicense, tamperedLicense);
    await assert.rejects(
      afterExtract(buildHookContext(root, 'darwin')),
      /target-distribution LICENSE differs from package-root LICENSE contract/,
    );
  } finally {
    fs.writeFileSync(electronPackageLicense, originalLicense);
  }
});

test('real package verification is exposed to CI and release jobs', () => {
  assert.equal(pkg.scripts['verify:package'], 'node tools/verify-package.mjs');
  assert.match(verifier, /productionSourceEntries/);
  assert.match(verifier, /stale or modified packaged source/);
  assert.match(verifier, /stale or modified packaged notice/);
  assert.match(verifier, /exactAsarManifest/);
  assert.match(verifier, /replaceAll\('\\\\', '\/'\)/);
  assert.match(verifier, /entry\.replaceAll\('\/', path\.sep\)/);
  assert.match(verifier, /ambiguous or duplicate normalized entries/);
  assert.match(verifier, /could not validate ASAR archive/);
  assert.match(verifier, /verifyElectronNoticeBundle/);
  assert.match(electronNoticesSource, /electron-npm-package-root\/LICENSE/);
  assert.match(electronNoticesSource, /electron-builder-target-distribution\/LICENSES\.chromium\.html/);
  assert.match(electronNoticesSource, /checksums\.json/);
  assert.match(electronNoticesSource, /archiveVerification: 'not-observed-by-poppet'/);
  assert.doesNotMatch(electronNoticesSource, /\bdistribution:\s*\{/);
  assert.match(electronNoticesSource, /isSymbolicLink/);
  for (const source of [afterExtractSource, afterPackSource, electronNoticesSource, verifier]) {
    assert.doesNotMatch(source, /electronDistPath/);
  }
  assert.match(afterPackSource, /await import\('plist'\)/);
  assert.doesNotMatch(afterPackSource, /require\('plist'\)/);
  assert.match(verifier, /unintended updater metadata/);
  assert.match(verifier, /unnecessary macOS permission\/network declaration/);
  assert.match(verifier, /packaged package\.json .* mismatch/);
});

test('Electron smoke scripts use the isolated fail-closed runner', () => {
  assert.equal(pkg.scripts['test:click'], 'node tools/run-electron-smoke.mjs --test-click');
  assert.equal(pkg.scripts['test:manager'], 'node tools/run-electron-smoke.mjs --test-manager');
  assert.equal(pkg.scripts['test:multi'], 'node tools/run-electron-smoke.mjs --test-multi');
  const runner = fileURLToPath(new URL('../../tools/run-electron-smoke.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [runner, '--invalid-mode'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test('macOS afterPack hook removes unused permission and network declarations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-after-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extractedApp = path.join(root, 'Electron.app');
  const contents = path.join(extractedApp, 'Contents');
  const infoPath = path.join(contents, 'Info.plist');
  const resourcesPath = path.join(contents, 'Resources');
  fs.mkdirSync(resourcesPath, { recursive: true });
  const chromiumNotice = Buffer.from('target Electron Chromium notice preserved before mac cleanup\n');
  writeFixtureFile(path.join(root, 'LICENSE'), fs.readFileSync(electronPackageLicense));
  writeFixtureFile(path.join(root, 'LICENSES.chromium.html'), chromiumNotice);
  const info = { CFBundleIdentifier: 'com.poppet.test' };
  for (const key of afterPack.FORBIDDEN_MAC_INFO_KEYS) {
    info[key] = key === 'NSAppTransportSecurity' ? {} : 'unused';
  }
  info.NSUnexpectedFutureDeviceUsageDescription = 'unused';
  fs.writeFileSync(infoPath, plist.build(info));

  const hookContext = buildHookContext(root, 'darwin');
  await afterExtract(hookContext);
  fs.renameSync(extractedApp, path.join(root, 'Poppet.app'));
  fs.rmSync(path.join(root, 'LICENSE'));
  fs.rmSync(path.join(root, 'LICENSES.chromium.html'));
  await afterPack(hookContext);

  const finalContents = path.join(root, 'Poppet.app', 'Contents');
  const finalResources = path.join(finalContents, 'Resources');
  const cleaned = plist.parse(fs.readFileSync(path.join(finalContents, 'Info.plist'), 'utf8'));
  assert.equal(cleaned.CFBundleIdentifier, 'com.poppet.test');
  for (const key of afterPack.FORBIDDEN_MAC_INFO_KEYS) {
    assert.equal(Object.hasOwn(cleaned, key), false);
  }
  assert.equal(Object.hasOwn(cleaned, 'NSUnexpectedFutureDeviceUsageDescription'), false);
  for (const { packagedName } of afterPack.ELECTRON_NOTICE_FILES) {
    const packagedPath = path.join(finalResources, packagedName);
    assert.equal(fs.lstatSync(packagedPath).isFile(), true);
  }
  assert.deepEqual(
    fs.readFileSync(path.join(finalResources, 'LICENSE.electron.txt')),
    fs.readFileSync(electronPackageLicense),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(finalResources, 'LICENSES.chromium.html')),
    chromiumNotice,
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(finalResources, ELECTRON_NOTICE_MANIFEST), 'utf8'));
  const electronChecksums = JSON.parse(
    fs.readFileSync(path.join(electronPackageRoot, 'checksums.json'), 'utf8'),
  );
  assert.equal(manifest.electronVersion, pkg.devDependencies.electron);
  assert.deepEqual(manifest.target, { platform: 'darwin', arch: 'x64' });
  assert.equal(Object.hasOwn(manifest, 'distribution'), false);
  assert.deepEqual(manifest.expectedOfficialArtifact, {
    artifactName: `electron-v${pkg.devDependencies.electron}-darwin-x64.zip`,
    sha256: electronChecksums[`electron-v${pkg.devDependencies.electron}-darwin-x64.zip`],
    source: 'electron-npm-package/checksums.json',
    archiveVerification: 'not-observed-by-poppet',
  });
});

test('package verifier accepts complete mac notices and rejects missing notices, unknown plist keys, and extra ASAR files', async (t) => {
  const fixture = await createVerifierFixture(t, 'mac');
  let result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 0, result.stderr);

  const noticeManifestPath = path.join(fixture.resourcesPath, ELECTRON_NOTICE_MANIFEST);
  const originalNoticeManifest = fs.readFileSync(noticeManifestPath, 'utf8');
  const overclaimedManifest = JSON.parse(originalNoticeManifest);
  overclaimedManifest.expectedOfficialArtifact.archiveVerification = 'verified-by-poppet';
  fs.writeFileSync(noticeManifestPath, `${JSON.stringify(overclaimedManifest, null, 2)}\n`);
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /official artifact expectation mismatch/);

  overclaimedManifest.expectedOfficialArtifact.archiveVerification = 'not-observed-by-poppet';
  overclaimedManifest.distribution = { sha256: 'not-allowed' };
  fs.writeFileSync(noticeManifestPath, `${JSON.stringify(overclaimedManifest, null, 2)}\n`);
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected top-level fields/);
  fs.writeFileSync(noticeManifestPath, originalNoticeManifest);

  const chromiumNotice = path.join(fixture.resourcesPath, 'LICENSES.chromium.html');
  const heldNotice = `${chromiumNotice}.held`;
  fs.renameSync(chromiumNotice, heldNotice);
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing packaged Electron notice LICENSES\.chromium\.html/);
  fs.renameSync(heldNotice, chromiumNotice);

  fs.appendFileSync(chromiumNotice, 'tampered');
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale or modified packaged Electron notice: LICENSES\.chromium\.html/);
  fs.writeFileSync(chromiumNotice, fixture.chromiumNotice);

  const electronLicense = path.join(fixture.resourcesPath, 'LICENSE.electron.txt');
  fs.appendFileSync(electronLicense, 'tampered');
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale or modified packaged Electron notice: LICENSE\.electron\.txt/);
  fs.writeFileSync(electronLicense, fs.readFileSync(electronPackageLicense));

  const infoPath = path.join(fixture.packagedRoot, 'Info.plist');
  fs.writeFileSync(infoPath, plist.build({
    CFBundleIdentifier: 'com.poppet.package-fixture',
    NSFutureSensorUsageDescription: 'must be rejected',
  }));
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unnecessary macOS permission\/network declaration: NSFutureSensorUsageDescription/);
  fs.writeFileSync(infoPath, plist.build({ CFBundleIdentifier: 'com.poppet.package-fixture' }));

  writeFixtureFile(path.join(fixture.sourceRoot, 'src/main/extra.js'), "'use strict';\n");
  fs.rmSync(fixture.asarPath);
  await createPackage(fixture.sourceRoot, fixture.asarPath);
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected packaged entry: src\/main\/extra\.js/);

  fs.rmSync(path.join(fixture.sourceRoot, 'src/main/extra.js'));
  writeFixtureFile(
    path.join(fixture.sourceRoot, rootRasterFixtureName),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  fs.rmSync(fixture.asarPath);
  await createPackage(fixture.sourceRoot, fixture.asarPath);
  result = runVerifier(fixture.root, 'mac');
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`unexpected packaged entry: ${rootRasterFixtureName}`));

  if (process.platform !== 'win32') {
    fs.rmSync(path.join(fixture.sourceRoot, rootRasterFixtureName));
    writeFixtureFile(path.join(fixture.sourceRoot, 'src\\main\\index.js'), "'use strict';\n");
    fs.rmSync(fixture.asarPath);
    await createPackage(fixture.sourceRoot, fixture.asarPath);
    result = runVerifier(fixture.root, 'mac');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not validate ASAR archive: .*invalid entry name/i);
  }
});

test('package verifier checks Electron notices at the Windows unpacked-app root', async (t) => {
  const fixture = await createVerifierFixture(t, 'win');
  await afterPack(buildHookContext(fixture.packagedRoot, 'win32'));
  let result = runVerifier(fixture.root, 'win');
  assert.equal(result.status, 0, result.stderr);

  const rootNotice = path.join(fixture.packagedRoot, 'LICENSE.electron.txt');
  const misplacedNotice = path.join(fixture.resourcesPath, 'LICENSE.electron.txt');
  fs.renameSync(rootNotice, misplacedNotice);
  result = runVerifier(fixture.root, 'win');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing packaged Electron notice LICENSE\.electron\.txt/);
});

test('portable Node test discovery fails closed for a missing required root', () => {
  const runner = fileURLToPath(new URL('../../tools/run-node-tests.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [runner, 'test/definitely-missing-required-root'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing/i);
});

// Fail-closed inspection of the real app.asar emitted by electron-builder.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as plist from 'plist';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');
const { verifyElectronNoticeBundle } = require('../build/electron-notices.cjs');

const platformArg = process.argv.indexOf('--platform');
const requestedPlatform = platformArg >= 0 ? process.argv[platformArg + 1] : null;
const platform = requestedPlatform || (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : null);
const distRoot = path.resolve('dist');

if (!['mac', 'win'].includes(platform)) {
  console.error('Package verification requires macOS/Windows or an explicit --platform mac|win.');
  process.exit(2);
}

function findAsars(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name === 'app.asar') results.push(target);
    }
  }
  return results;
}

function isPlatformAsar(file) {
  const normalized = file.split(path.sep).join('/');
  if (platform === 'mac') return /\.app\/Contents\/Resources\/app\.asar$/.test(normalized);
  return /\/win(?:32|64)?(?:-[^/]+)?-unpacked\/resources\/app\.asar$/i.test(normalized)
    || /\/win-unpacked\/resources\/app\.asar$/i.test(normalized);
}

function productionSourceEntries() {
  const roots = ['src', 'assets/characters/default'];
  const files = ['assets/tray-fallback.png'];
  const pending = roots.filter(root => fs.existsSync(root));
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const normalized = target.split(path.sep).join('/');
      if (normalized === 'src/main/dev-capture.js' || normalized.startsWith('src/renderer/dev/')) continue;
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(normalized);
    }
  }
  return files.sort();
}

// Package completeness is derived from the actual production source tree. The
// byte comparison is deliberate: a stale app.asar must not pass merely because
// its paths still satisfy the allowlist.
const sourceEntries = productionSourceEntries();
const requiredEntries = ['package.json', ...sourceEntries];
function exactAsarManifest(files) {
  const manifest = new Set();
  for (const file of files) {
    manifest.add(file);
    let parent = path.posix.dirname(file);
    while (parent !== '.') {
      manifest.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...manifest].sort();
}

function normalizeAsarEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '');
}

function extractNormalizedAsarFile(archive, entry) {
  return extractFile(archive, entry.replaceAll('/', path.sep));
}
const expectedAsarEntries = exactAsarManifest(requiredEntries);
const expectedAsarEntrySet = new Set(expectedAsarEntries);
const expectedPackage = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const forbiddenPathRules = [
  [/^src\/main\/dev-capture\.js$/, 'development capture driver'],
  [/^src\/renderer\/dev(?:\/|$)/, 'renderer development helper'],
  [/^src\/renderer\/.*(?:dev|test)[-_].*\.(?:js|mjs|cjs)$/i, 'renderer development/test helper'],
  [/^assets\/characters\/(?!default(?:\/|$))/, 'non-production character'],
  [/^(?:test|tools)(?:\/|$)/, 'test/tooling content'],
  [/^assets\/source(?:\/|$)/, 'private source image'],
  [/(?:^|\/)\.env(?:\.|$)/i, 'environment file'],
  [/\.(?:key|pem|p12|pfx)$/i, 'credential/key material'],
  [/\.log$/i, 'private/debug log'],
];

const forbiddenTextRules = [
  [/__poppetDev/, 'development renderer hook'],
  [/(?:^|["'`\s])\/Users\/[A-Za-z0-9._-]+\//m, 'absolute macOS user path'],
  [/[A-Za-z]:\\Users\\[^\\\s]+\\/, 'absolute Windows user path'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key contents'],
];

const textExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.md']);
const externalNotices = [
  ['LICENSE.POPPET.txt', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['ASSETS_LICENSE.md', 'ASSETS_LICENSE.md'],
];
function isForbiddenMacInfoKey(key) {
  return key === 'NSAppTransportSecurity' || /^NS.*UsageDescription$/.test(key);
}

function verifyNotice(errors, packagedPath, sourcePath, label) {
  try {
    const sourceStat = fs.lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      errors.push(`notice source is not a regular file: ${label}`);
      return;
    }
    const packagedStat = fs.lstatSync(packagedPath);
    if (!packagedStat.isFile() || packagedStat.isSymbolicLink()) {
      errors.push(`packaged notice is not a regular file: ${label}`);
      return;
    }
    if (!fs.readFileSync(packagedPath).equals(fs.readFileSync(sourcePath))) {
      errors.push(`stale or modified packaged notice: ${label}`);
    }
  } catch (error) {
    errors.push(`missing packaged notice: ${label} (${error.code || error.message})`);
  }
}

const asars = findAsars(distRoot).filter(isPlatformAsar).sort();
if (!asars.length) {
  console.error(`No ${platform} app.asar found below ${distRoot}. Build the current platform before verification.`);
  process.exit(1);
}

let failures = 0;
for (const asar of asars) {
  const relativeAsar = path.relative(process.cwd(), asar);
  const resourcesDir = path.dirname(asar);
  let rawEntries;
  try {
    rawEntries = listPackage(asar);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${relativeAsar}`);
    console.error(`  - could not validate ASAR archive: ${detail}`);
    continue;
  }
  const normalizedEntries = rawEntries.map(normalizeAsarEntry);
  const entries = normalizedEntries.filter(Boolean);
  const entrySet = new Set(entries);
  const errors = [];
  if (entries.length !== rawEntries.length) {
    errors.push('ASAR contains an invalid empty normalized entry');
  }
  if (entrySet.size !== entries.length) {
    errors.push('ASAR contains ambiguous or duplicate normalized entries');
  }
  if (entries.length !== expectedAsarEntries.length) {
    errors.push(`ASAR entry count mismatch: ${entries.length} != ${expectedAsarEntries.length}`);
  }

  if (platform === 'mac') {
    const infoPath = path.resolve(resourcesDir, '..', 'Info.plist');
    try {
      const stat = fs.lstatSync(infoPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push('Info.plist is not a regular file');
      } else {
        const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
        for (const key of Object.keys(info)) {
          if (isForbiddenMacInfoKey(key)) {
            errors.push(`unnecessary macOS permission/network declaration: ${key}`);
          }
        }
      }
    } catch (error) {
      errors.push(`could not validate Info.plist: ${error.code || error.message}`);
    }
  }

  for (const [packagedName, sourceName] of externalNotices) {
    verifyNotice(errors, path.join(resourcesDir, packagedName), sourceName, packagedName);
  }

  try {
    verifyElectronNoticeBundle({
      resourcesPath: resourcesDir,
      noticeRoot: platform === 'mac' ? resourcesDir : path.resolve(resourcesDir, '..'),
      expectedPlatform: platform === 'mac' ? 'darwin' : 'win32',
    });
  } catch (error) {
    errors.push(error.message);
  }

  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === 'app-update.yml') errors.push('unintended updater metadata: app-update.yml');
    if (/\.log$/i.test(entry.name)) errors.push(`private/debug log outside ASAR: ${entry.name}`);
    if (/^\.env(?:\.|$)/i.test(entry.name) || /\.(?:key|pem|p12|pfx)$/i.test(entry.name)) {
      errors.push(`credential/environment file outside ASAR: ${entry.name}`);
    }
  }

  for (const required of expectedAsarEntries) {
    if (!entrySet.has(required)) errors.push(`missing required entry: ${required}`);
  }

  for (const entry of entries) {
    if (!expectedAsarEntrySet.has(entry)) errors.push(`unexpected packaged entry: ${entry}`);
  }

  for (const entry of sourceEntries) {
    if (!entrySet.has(entry)) continue;
    let packaged;
    try {
      packaged = extractNormalizedAsarFile(asar, entry);
    } catch (error) {
      errors.push(`could not read packaged source ${entry}: ${error.message}`);
      continue;
    }
    const local = fs.readFileSync(entry);
    if (!packaged.equals(local)) errors.push(`stale or modified packaged source: ${entry}`);
  }

  if (entrySet.has('package.json')) {
    try {
      const packagedPackage = JSON.parse(
        extractNormalizedAsarFile(asar, 'package.json').toString('utf8'),
      );
      for (const field of ['name', 'version', 'main']) {
        if (packagedPackage[field] !== expectedPackage[field]) {
          errors.push(`packaged package.json ${field} mismatch: ${packagedPackage[field] ?? 'missing'} != ${expectedPackage[field]}`);
        }
      }
    } catch (error) {
      errors.push(`could not validate packaged package.json: ${error.message}`);
    }
  }

  for (const entry of entries) {
    for (const [rule, label] of forbiddenPathRules) {
      if (rule.test(entry)) errors.push(`${label}: ${entry}`);
    }

    if (!textExtensions.has(path.extname(entry)) || entry.endsWith('/')) continue;
    let contents;
    try {
      contents = extractNormalizedAsarFile(asar, entry).toString('utf8');
    } catch (error) {
      errors.push(`could not inspect text entry ${entry}: ${error.message}`);
      continue;
    }
    for (const [rule, label] of forbiddenTextRules) {
      if (rule.test(contents)) errors.push(`${label} in ${entry}`);
    }
  }

  if (errors.length) {
    failures += errors.length;
    console.error(`✗ ${relativeAsar}`);
    for (const error of [...new Set(errors)].sort()) console.error(`  - ${error}`);
  } else {
    console.log(`✓ ${relativeAsar}: ${entries.length} entries, 0 forbidden items`);
  }
}

process.exit(failures ? 1 : 0);

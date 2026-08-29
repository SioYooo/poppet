'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const {
  BRAND_TRAY_ICON_PATH,
  loadBrandTrayImage,
} = require('../../src/main/brand-icon');

test('free Core loads only the bundled blonde brand image for the system tray', () => {
  const expectedImage = { isEmpty: () => false };
  const observed = [];
  const result = loadBrandTrayImage({
    existsSync(file) {
      observed.push(['exists', file]);
      return true;
    },
    trayImage(file) {
      observed.push(['load', file]);
      return expectedImage;
    },
  });

  assert.equal(result, expectedImage);
  assert.deepEqual(observed, [
    ['exists', BRAND_TRAY_ICON_PATH],
    ['load', BRAND_TRAY_ICON_PATH],
  ]);
  assert.equal(path.relative(root, BRAND_TRAY_ICON_PATH), path.join('assets', 'tray-fallback.png'));
});

test('a missing or invalid brand image fails closed instead of creating an invisible tray', () => {
  assert.throws(
    () => loadBrandTrayImage({ existsSync: () => false, trayImage: () => null }),
    error => error?.code === 'POPPET_BRAND_ICON_MISSING',
  );
  assert.throws(
    () => loadBrandTrayImage({
      existsSync: () => true,
      trayImage: () => ({ isEmpty: () => true }),
    }),
    error => error?.code === 'POPPET_BRAND_ICON_INVALID',
  );
});

test('the main process wires the tray through the fixed brand-image loader', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  const start = source.indexOf('function trayIconImage()');
  const end = source.indexOf('\n}\n\nfunction buildTray()', start);

  assert.ok(start >= 0 && end > start, 'trayIconImage implementation must remain discoverable');
  const block = source.slice(start, end + 2);
  assert.match(block, /loadBrandTrayImage\(/);
  assert.doesNotMatch(block, /\bpets\b|characterIconDataURL|trayImageDataURL/,
    'a user-imported or active character must not replace the free system tray icon');
});

test('brand outputs render from the fixed default blonde source', async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const icons = await import(pathToFileURL(path.join(root, 'tools/make-icons.mjs')).href);
  const { decodePNG } = await import(pathToFileURL(path.join(root, 'tools/png.mjs')).href);

  assert.equal(packageJson.build.mac.icon, 'build/icon.icns');
  assert.equal(packageJson.build.win.icon, 'build/icon.ico');
  assert.equal(icons.BRAND_CHARACTER_ID, 'default');
  assert.equal(path.relative(root, icons.BRAND_SOURCE_PATH),
    path.join('assets', 'characters', 'default', 'pet.png'));
  assert.deepEqual(
    icons.renderBrandIcon(44),
    decodePNG(path.join(root, 'assets/tray-fallback.png')),
  );
});

test('macOS icon conversion failures propagate before partial platform outputs are reported', async (t) => {
  const icons = await import(pathToFileURL(path.join(root, 'tools/make-icons.mjs')).href);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-brand-icons-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: false }));
  const sentinel = Object.assign(new Error('iconutil failed'), { code: 'TEST_ICONUTIL_FAILURE' });

  assert.throws(
    () => icons.generateBrandIcons({
      outputRoot,
      targetPlatform: 'darwin',
      runIconutil() { throw sentinel; },
    }),
    error => error === sentinel,
  );
  assert.equal(fs.existsSync(path.join(outputRoot, 'build/icon.ico')), false);
  assert.equal(fs.existsSync(path.join(outputRoot, 'assets/tray-fallback.png')), false);
});

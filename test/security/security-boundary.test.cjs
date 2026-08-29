'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const security = require('../../src/main/security');
const { makePng } = require('./png-fixture.cjs');

const validMeta = () => ({
  schemaVersion: 2,
  sprite: { width: 16, height: 16 },
  frames: null,
  atlas: null,
  parts: [],
  suggestions: [],
  footY: 15,
  outline: [0, 0, 0],
  palette: [[0, 0, 0]],
  rig: { motion: 'walk', anchor: 'feet', flip: true, swayFrom: 0.5 },
  source: {
    cropBBox: [0, 0, 15, 15],
    backgroundMode: 'alpha',
    originalSize: { width: 16, height: 16 },
    extraction: {
      contractVersion: 1,
      extractor: 'local-edge-v1',
      status: 'ready',
      mode: 'alpha',
    },
    pixelize: {
      enabled: false,
      preset: 'original',
      targetHeight: null,
      paletteSize: null,
      methodVersion: 'local-box-median-cut-v1',
      width: 16,
      height: 16,
      colors: 1,
      sharedPalette: false,
    },
  },
});

test('character ids and child paths fail closed', () => {
  assert.equal(security.assertCharacterId('角色-2'), '角色-2');
  for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', 'CON', 'x:', 'x.', 'x ']) {
    assert.throws(() => security.assertCharacterId(id), /非法角色 id/);
  }
  const base = path.resolve('/tmp/poppet-security-root');
  assert.equal(security.safeChildPath(base, 'ok'), path.join(base, 'ok'));
  assert.throws(() => security.safeChildPath(base, '../escape'));
});

test('IPC setting, metadata and binary schemas reject extra or hostile data', () => {
  assert.deepEqual(security.validateSettingsPatch({ scale: 0.5, wander: true }), { scale: 0.5, wander: true });
  assert.throws(() => security.validateSettingsPatch({ activeId: 'x' }), /不允许/);
  assert.throws(() => security.validateSettingsPatch({ scale: Infinity }), /scale/);
  assert.throws(() => security.validateMetadataUpdate({ id: 'x', patch: { builtin: true } }), /不允许/);
  assert.equal(security.validateMetadataUpdate({ id: 'x', patch: {
    rig: { motion: 'idle', anchor: 'feet', flip: false, swayFrom: null },
  } }).patch.rig.motion, 'idle');
  assert.throws(() => security.validateCharacterMeta(JSON.parse('{"sprite":{"width":1,"height":1},"__proto__":{}}')));

  const png = makePng(16, 16);
  const value = security.validateImportPayload({
    name: 'valid', meta: validMeta(), files: { 'pet.png': png, 'icon.png': png },
  });
  assert.equal(value.name, 'valid');
  assert.throws(() => security.validateImportPayload({
    name: 'bad', meta: validMeta(), files: { 'pet.png': png, 'icon.png': png, '../x.png': png },
  }), /不允许/);
  assert.throws(() => security.validateImportPayload({
    name: 'bad', meta: validMeta(), files: { 'pet.png': Buffer.alloc(8), 'icon.png': png },
  }), /大小无效/);
  assert.throws(() => security.validateImportPayload({
    name: 'bad', meta: validMeta(), files: { 'pet.png': makePng(15, 16), 'icon.png': png },
  }), /尺寸与 metadata/);
  assert.throws(() => security.validateImportPayload({
    name: 'bad', meta: validMeta(), files: { 'pet.png': png, 'icon.png': makePng(16, 15) },
  }), /正方形/);

  const withAtlas = validMeta();
  withAtlas.atlas = { width: 8, height: 4 };
  assert.throws(() => security.validateImportPayload({
    name: 'bad', meta: withAtlas, files: { 'pet.png': png, 'icon.png': png },
  }), /parts\.png/);
  assert.doesNotThrow(() => security.validateImportPayload({
    name: 'valid-atlas', meta: withAtlas,
    files: { 'pet.png': png, 'icon.png': png, 'parts.png': makePng(8, 4) },
  }));

  const wideSheet = validMeta();
  wideSheet.sprite = { width: 8192, height: 1 };
  wideSheet.footY = 0;
  wideSheet.frames = { count: 64, fps: 10 };
  wideSheet.source.originalSize = { width: 8192, height: 1 };
  wideSheet.source.cropBBox = [0, 0, 8191, 0];
  wideSheet.source.pixelize.width = 8192;
  wideSheet.source.pixelize.height = 1;
  wideSheet.source.pixelize.sharedPalette = true;
  assert.throws(() => security.validateImportPayload({
    name: 'too-wide', meta: wideSheet,
    files: { 'pet.png': makePng(8192 * 64, 1), 'icon.png': makePng(1, 1) },
  }), /物理尺寸/);
});

test('new imports validate extraction and pixelization provenance strictly', () => {
  assert.doesNotThrow(() => security.validateCharacterMeta(validMeta()));
  const appendages = validMeta();
  appendages.parts.push({
    role: 'appendage', id: 'app0', source: 'user', sublabel: 'tail',
    x: 1, y: 1, w: 3, h: 4, areaRatio: 0.0469,
  });
  appendages.suggestions.push({
    role: 'appendage', id: 'app1', sublabel: 'wing/fin',
    x: 8, y: 2, w: 4, h: 5, areaRatio: 0.0781,
  });
  assert.doesNotThrow(() => security.validateCharacterMeta(appendages));
  const invalid = [
    meta => { delete meta.source; },
    meta => { meta.schemaVersion = 1; },
    meta => { meta.source.unexpected = true; },
    meta => { meta.source.extraction.extractor = 'claimed-remote-model'; },
    meta => { meta.source.extraction.status = 'ready-ish'; },
    meta => { meta.source.cropBBox = [0, 0, 16, 15]; },
    meta => { meta.source.pixelize.enabled = 'yes'; },
    meta => { meta.source.pixelize.preset = 'detailed'; },
    meta => {
      Object.assign(meta.source.pixelize, {
        enabled: true, preset: 'tiny', targetHeight: -1, paletteSize: 8,
      });
    },
  ];
  for (const mutate of invalid) {
    const meta = validMeta();
    mutate(meta);
    assert.throws(() => security.validateCharacterMeta(meta), /metadata\.(?:source|schemaVersion)/);
  }
});

test('image budgets enforce dimensions, frame count and aggregate pixels', () => {
  assert.deepEqual(security.assertImageBudget(16, 16, 2).totalPixels, 512);
  assert.throws(() => security.assertImageBudget(8193, 1), /边长/);
  assert.throws(() => security.assertImageBudget(1, 1, 65), /帧数/);
  assert.throws(() => security.assertImageBudget(4096, 4096, 2), /总像素/);
});

test('runtime metadata accepts legacy parts but rejects hostile geometry and names', () => {
  const legacy = validMeta();
  legacy.atlas = { width: 40, height: 20 };
  legacy.parts = {
    eyeL: {
      x: 1, y: 1, w: 4, h: 4,
      frame: { sx: 0, sy: 0, sw: 4, sh: 4 },
      cleanFrame: { sx: 4, sy: 0, sw: 4, sh: 4 },
    },
    eyeR: null,
    mouth: null,
  };
  assert.doesNotThrow(() => security.validateRuntimeCharacterMeta(legacy));

  const hostile = structuredClone(legacy);
  hostile.parts.eyeL.h = 1e12;
  assert.throws(() => security.validateRuntimeCharacterMeta(hostile), /parts|边界|无效/);
  const outsideAtlas = structuredClone(legacy);
  outsideAtlas.parts.eyeL.frame.sx = 39;
  assert.throws(() => security.validateRuntimeCharacterMeta(outsideAtlas), /atlas/);
  const badName = structuredClone(legacy);
  badName.name = {};
  assert.throws(() => security.validateRuntimeCharacterMeta(badName), /name/);
});

test('IPC accepts only the expected top-level file frame and sender', () => {
  const html = path.resolve('/tmp/app/manager.html');
  const mainFrame = { url: pathToFileURL(html).href + '?poppetDev=1' };
  const webContents = { mainFrame, isDestroyed: () => false };
  assert.equal(security.assertTrustedIpcFrame({ sender: webContents, senderFrame: mainFrame }, webContents, html), true);
  assert.throws(() => security.assertTrustedIpcFrame(
    { sender: webContents, senderFrame: { url: mainFrame.url } }, webContents, html), /顶层 frame/);
  assert.throws(() => security.assertTrustedIpcFrame(
    { sender: {}, senderFrame: mainFrame }, webContents, html), /sender/);
  const remote = { url: 'https://example.invalid/' };
  assert.throws(() => security.assertTrustedIpcFrame(
    { sender: webContents, senderFrame: remote }, { ...webContents, mainFrame: remote }, html));
});

test('send-style IPC listener contains sync and async handler failures', async () => {
  const logged = [];
  const sync = security.safeIpcListener('sync:test', () => { throw new Error('invalid'); },
    (...args) => logged.push(args));
  assert.doesNotThrow(() => sync({}, { hostile: true }));
  assert.equal(logged.length, 1);

  const asyncHandler = security.safeIpcListener('async:test', async () => { throw new Error('invalid async'); },
    (...args) => logged.push(args));
  assert.doesNotThrow(() => asyncHandler({}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logged.length, 2);
});

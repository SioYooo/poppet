'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { makePng } = require('./png-fixture.cjs');
const { LIMITS, validateCharacterMeta } = require('../../src/main/security');
const { buildPoppetpack } = require('../../src/main/pack');
const png = makePng(1, 1);
const meta = {
  schemaVersion: 2, sprite: { width: 1, height: 1 }, frames: null, atlas: null,
  parts: [], suggestions: [], footY: 0, outline: [0, 0, 0], palette: [[0, 0, 0]],
  rig: { motion: 'walk', anchor: 'feet', flip: true, swayFrom: 0.5 },
  source: {
    cropBBox: [0, 0, 0, 0],
    backgroundMode: 'alpha',
    originalSize: { width: 1, height: 1 },
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
      width: 1,
      height: 1,
      colors: 1,
      sharedPalette: false,
    },
  },
};

function requireLibraryFor(t, userData) {
  const originalLoad = Module._load;
  const libraryPath = require.resolve('../../src/main/library');
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[libraryPath];
    const library = require(libraryPath);
    t.after(() => { delete require.cache[libraryPath]; });
    return library;
  } finally {
    Module._load = originalLoad;
  }
}

function createDirectorySymlinkOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`directory symlinks unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function paddedMeta(paddingLength) {
  return {
    ...meta,
    provenance: {
      bulk: Array(4095).fill('x'.repeat(501)),
      padding: 'p'.repeat(paddingLength),
    },
  };
}

test('post-rename fsync failure preserves exact id for idempotent durability finalize', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-import-finalize-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const originalLoad = Module._load;
  const storagePath = require.resolve('../../src/main/storage');
  const libraryPath = require.resolve('../../src/main/library');
  const realStorage = require(storagePath);
  let injectParentFsyncFailure = true;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData } };
    if (request === './storage' && parent?.filename === libraryPath) {
      return {
        ...realStorage,
        fsyncDirSync(dir) {
          const published = path.join(userData, 'characters', 'uncertain-id');
          if (injectParentFsyncFailure && path.basename(dir) === 'characters'
              && fs.existsSync(published)) {
            injectParentFsyncFailure = false;
            const error = new Error('simulated parent directory fsync failure');
            error.code = 'EIO';
            throw error;
          }
          return realStorage.fsyncDirSync(dir);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; delete require.cache[libraryPath]; });
  delete require.cache[libraryPath];
  const library = require(libraryPath);

  let uncertain;
  try {
    library.importCharacter({ id: 'uncertain-id', name: 'Uncertain', meta,
      files: { 'pet.png': png, 'icon.png': png } });
  } catch (error) {
    uncertain = error;
  }
  assert.equal(uncertain?.code, 'POPPET_IMPORT_DURABILITY_UNCONFIRMED');
  assert.equal(uncertain?.persistedId, 'uncertain-id');
  assert.equal(uncertain?.stage, 'parent-directory-fsync');
  assert.ok(library.loadCharacter('uncertain-id'),
    'published bytes must remain addressable for finalize, not be re-imported');
  assert.equal(library.listCharacters().filter(character => character.id === 'uncertain-id').length, 1);
  assert.equal(library.finalizeImportedCharacter('uncertain-id'), 'uncertain-id');
  assert.equal(library.finalizeImportedCharacter('uncertain-id'), 'uncertain-id',
    'durability finalize must be idempotent across repeated recovery clicks');
  assert.throws(() => library.finalizeImportedCharacter('missing-finalize-id'), error =>
    error?.code === 'POPPET_IMPORT_RECOVERY_MISSING');
  fs.mkdirSync(path.join(userData, 'characters', 'invalid-finalize-id'));
  assert.throws(() => library.finalizeImportedCharacter('invalid-finalize-id'), error =>
    error?.code === 'POPPET_IMPORT_RECOVERY_INVALID');
  assert.throws(() => library.importCharacter({ id: 'uncertain-id', name: 'Duplicate', meta,
    files: { 'pet.png': png, 'icon.png': png } }), /角色 id 已存在/,
  'the recovery contract must never ask the caller to import the same bytes again');
});

test('library stages imports, recovers metadata and soft-deletes characters', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-library-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData } };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  delete require.cache[require.resolve('../../src/main/library')];
  const library = require('../../src/main/library');

  const id = library.importCharacter({ id: 'safe-id', name: 'Safe', meta,
    files: { 'pet.png': png, 'icon.png': png } });
  assert.equal(id, 'safe-id');
  assert.equal(library.loadCharacter(id).meta.name, 'Safe');
  assert.match(library.characterIconDataURL(id), /^data:image\/png;base64,/);
  assert.throws(() => library.loadCharacter('../escape'));
  const staging = path.join(userData, 'characters', '.staging');
  assert.deepEqual(fs.readdirSync(staging), []);

  library.updateCharacterMeta(id, { name: 'Updated' });
  const metadataFile = path.join(userData, 'characters', id, 'character.json');
  fs.writeFileSync(metadataFile, '{broken');
  assert.equal(library.loadCharacter(id).meta.name, 'Safe'); // 从更新前的 .bak 恢复
  assert.ok(fs.readdirSync(path.dirname(metadataFile)).some((name) => name.startsWith('character.json.corrupt-')));

  // JSON 即使语法有效，只要会制造异常窗口尺寸或与 PNG 不一致，也必须回退最后好备份。
  fs.writeFileSync(metadataFile, JSON.stringify({ ...meta, name: 'Hostile', sprite: { width: 1e9, height: 1e9 } }));
  assert.equal(library.loadCharacter(id).meta.name, 'Safe');
  fs.writeFileSync(metadataFile, JSON.stringify({ ...meta, name: 'Mismatch', sprite: { width: 2, height: 2 } }));
  assert.equal(library.loadCharacter(id).meta.name, 'Safe');

  assert.equal(library.deleteCharacter(id), true);
  assert.equal(library.loadCharacter(id), null);
  assert.equal(fs.readdirSync(path.join(userData, 'characters', '.trash')).length, 1);
});

test('tray icon reads reject a user-controlled leaf symlink', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-icon-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-icon-outside-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const library = requireLibraryFor(t, userData);
  const id = library.importCharacter({
    id: 'linked-icon', name: 'Linked icon', meta,
    files: { 'pet.png': png, 'icon.png': png },
  });
  const icon = path.join(userData, 'characters', id, 'icon.png');
  const outsideIcon = path.join(outside, 'outside.png');
  fs.writeFileSync(outsideIcon, png);
  fs.unlinkSync(icon);
  try {
    fs.symlinkSync(outsideIcon, icon, 'file');
  } catch (error) {
    if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`file symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.equal(library.characterIconDataURL(id), null);
  assert.equal(library.listCharacters().find(character => character.id === id)?.iconDataURL, null);
});

test('builtin seeding uses the bounded trusted-ASAR path without weakening userData reads', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-asar-seed-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const originalLoad = Module._load;
  const storagePath = require.resolve('../../src/main/storage');
  const libraryPath = require.resolve('../../src/main/library');
  const realStorage = require(storagePath);
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData } };
    if (request === './storage' && parent?.filename === libraryPath) {
      return {
        ...realStorage,
        readJsonWithBackupSync(file, fallback, options) {
          if (file.includes(`${path.sep}assets${path.sep}characters${path.sep}`)) {
            throw new Error('simulated ASAR inode mismatch');
          }
          return realStorage.readJsonWithBackupSync(file, fallback, options);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  delete require.cache[libraryPath];
  const library = require('../../src/main/library');

  assert.doesNotThrow(() => library.seedBuiltins());
  const seeded = path.join(userData, 'characters', 'default');
  assert.ok(fs.existsSync(path.join(seeded, 'character.json')));
  assert.ok(library.loadCharacter('default'));
});

test('import and update enforce the exact pretty-serialized metadata byte limit', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-metadata-limit-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const library = requireLibraryFor(t, userData);
  const importedAt = '2026-08-20T00:00:00.000Z';

  const oversized = paddedMeta(3582);
  const oversizedFinal = { ...oversized, name: 'a', builtin: false, importedAt };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < LIMITS.MAX_METADATA_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedFinal, null, 2)) > LIMITS.MAX_METADATA_BYTES);
  assert.throws(() => library.importCharacter({
    id: 'too-large', name: 'a', meta: oversized,
    files: { 'pet.png': png, 'icon.png': png },
  }), /角色 metadata exceeds 2097152 byte limit/);
  assert.equal(fs.existsSync(path.join(userData, 'characters', 'too-large')), false);

  const nearLimit = paddedMeta(3482);
  const nearLimitFinal = { ...nearLimit, name: 'a', builtin: false, importedAt };
  const expectedBytes = Buffer.byteLength(JSON.stringify(nearLimitFinal, null, 2));
  assert.ok(expectedBytes <= LIMITS.MAX_METADATA_BYTES);
  assert.ok(expectedBytes > LIMITS.MAX_METADATA_BYTES - 100);
  const id = library.importCharacter({
    id: 'near-limit', name: 'a', meta: nearLimit,
    files: { 'pet.png': png, 'icon.png': png },
  });
  const metadataFile = path.join(userData, 'characters', id, 'character.json');
  assert.equal(fs.statSync(metadataFile).size, expectedBytes);
  const before = fs.readFileSync(metadataFile);

  assert.throws(
    () => library.updateCharacterMeta(id, { name: 'x'.repeat(100) }),
    /角色 metadata exceeds 2097152 byte limit/,
  );
  assert.deepEqual(fs.readFileSync(metadataFile), before);
  assert.equal(fs.existsSync(metadataFile + '.bak'), false);
  assert.equal(library.loadCharacter(id).meta.name, 'a');
});

test('characters root rejects symlink and non-directory substitution', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-character-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-character-outside-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const root = path.join(userData, 'characters');
  if (!createDirectorySymlinkOrSkip(t, outside, root)) return;
  const library = requireLibraryFor(t, userData);

  assert.throws(() => library.listCharacters(), /角色库目录 必须是应用自有普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);

  fs.unlinkSync(root);
  fs.writeFileSync(root, 'not a directory');
  assert.throws(() => library.importCharacter({
    id: 'blocked', name: 'Blocked', meta,
    files: { 'pet.png': png, 'icon.png': png },
  }), /角色库目录 必须是应用自有普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('staging root rejects symlink and non-directory substitution without outside writes', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-staging-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-staging-outside-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const characters = path.join(userData, 'characters');
  const staging = path.join(characters, '.staging');
  fs.mkdirSync(characters);
  if (!createDirectorySymlinkOrSkip(t, outside, staging)) return;
  const library = requireLibraryFor(t, userData);
  const payload = {
    id: 'blocked', name: 'Blocked', meta,
    files: { 'pet.png': png, 'icon.png': png },
  };

  assert.throws(() => library.importCharacter(payload), /角色暂存目录 必须是应用自有普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);

  fs.unlinkSync(staging);
  fs.writeFileSync(staging, 'not a directory');
  assert.throws(() => library.importCharacter(payload), /角色暂存目录 必须是应用自有普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('trash root rejects symlink and non-directory substitution without moving the character', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-trash-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-trash-outside-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const library = requireLibraryFor(t, userData);
  const id = library.importCharacter({
    id: 'kept', name: 'Kept', meta,
    files: { 'pet.png': png, 'icon.png': png },
  });
  const trash = path.join(userData, 'characters', '.trash');
  if (!createDirectorySymlinkOrSkip(t, outside, trash)) return;

  assert.throws(() => library.deleteCharacter(id), /角色回收站目录 必须是应用自有普通目录/);
  assert.ok(library.loadCharacter(id));
  assert.deepEqual(fs.readdirSync(outside), []);

  fs.unlinkSync(trash);
  fs.writeFileSync(trash, 'not a directory');
  assert.throws(() => library.deleteCharacter(id), /角色回收站目录 必须是应用自有普通目录/);
  assert.ok(library.loadCharacter(id));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('listCharacters reports why a character cannot be exported and keeps exportable as its boolean view', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-export-reason-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const library = requireLibraryFor(t, userData);
  const importPayload = (id, name) => ({ id, name, meta, files: { 'pet.png': png, 'icon.png': png } });
  // 旧格式与内置角色都过不了 importCharacter 的严格 v2 入口，只能直接落盘；
  // 宽松的 listCharacters 照样显示它们——这正是需要向用户解释的状态。
  const writeCharacter = (id, characterMeta, { icon = true } = {}) => {
    const dir = path.join(userData, 'characters', id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pet.png'), png);
    if (icon) fs.writeFileSync(path.join(dir, 'icon.png'), png);
    fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ ...characterMeta, name: id }));
  };
  const legacyMeta = { ...meta };
  delete legacyMeta.schemaVersion;

  library.importCharacter(importPayload('exportable', 'Exportable'));
  library.importCharacter(importPayload('no-icon', 'No icon'));
  fs.unlinkSync(path.join(userData, 'characters', 'no-icon', 'icon.png'));
  writeCharacter('legacy-v1', { ...legacyMeta, schemaVersion: 1 });
  writeCharacter('legacy-unversioned-no-icon', legacyMeta, { icon: false });
  writeCharacter('brand', { ...meta, builtin: true });
  writeCharacter('brand-no-icon', { ...meta, builtin: true }, { icon: false });

  const listed = library.listCharacters();
  assert.deepEqual(
    Object.fromEntries(listed.map(character => [character.id, [character.exportable, character.exportBlockReason]])),
    {
      exportable: [true, null],
      'no-icon': [false, 'missing-icon'],
      'legacy-v1': [false, 'legacy-schema'],
      // 旧格式只能重做角色才能修，单独补 icon 没用：legacy-schema 优先于 missing-icon。
      'legacy-unversioned-no-icon': [false, 'legacy-schema'],
      brand: [false, 'builtin'],
      // 许可证约束优先于任何可修原因，且不依赖内置角色自身的 schemaVersion。
      'brand-no-icon': [false, 'builtin'],
    });
  for (const character of listed) {
    assert.equal(character.exportable, character.exportBlockReason === null,
      `${character.id}: exportable must stay the boolean view of exportBlockReason`);
    assert.equal(character.builtin, character.exportBlockReason === 'builtin');
  }

  // 给用户看的原因必须对应导出管线的真实裁决：可导出的真能组包，被拦的真被拒，
  // 且拒绝理由与列表里的 exportBlockReason 同名。
  assert.ok(library.characterExportBundle('exportable').files['icon.png']);
  assert.throws(() => library.characterExportBundle('no-icon'),
    error => error?.code === 'POPPET_PACK_NOT_EXPORTABLE' && error.reason === 'missing-icon');
  // 'brand' 是严格 v2 合法 + builtin:true；随包内置 default（没有 schemaVersion）
  // 由下一个测试覆盖——两条不同的输入都必须落到同一个许可证拒绝码。
  assert.throws(() => library.characterExportBundle('brand'),
    error => error?.code === 'POPPET_PACK_BUILTIN_FORBIDDEN');
  assert.throws(() => library.characterExportBundle('legacy-v1'),
    error => error?.code === 'POPPET_PACK_NOT_EXPORTABLE' && error.reason === 'legacy-schema');
  assert.ok(library.listCharacters().some(character => character.id === 'legacy-v1'),
    'refusing to export a legacy character must not make it disappear');
});

test('refusing to export a non-exportable character never touches its files', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-export-refusal-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const library = requireLibraryFor(t, userData);
  const characterDir = id => path.join(userData, 'characters', id);
  const snapshot = id => ({
    entries: fs.readdirSync(characterDir(id)).sort(),
    metaBytes: fs.readFileSync(path.join(characterDir(id), 'character.json')),
  });
  const assertUntouched = (id, before) => {
    const after = snapshot(id);
    assert.deepEqual(after.entries, before.entries, `${id}: a refusal must not add, rename or remove files`);
    assert.ok(after.metaBytes.equals(before.metaBytes), `${id}: character.json bytes must be identical`);
    assert.ok(!after.entries.some(name => name.includes('.corrupt-')), `${id}: no corrupt-preservation rename`);
    assert.ok(library.listCharacters().some(character => character.id === id), `${id}: must still be listed`);
  };
  const refusal = (code, reason) => error => error?.code === code
    && (reason === undefined || error.reason === reason);
  const importPayload = (id, name) => ({ id, name, meta, files: { 'pet.png': png, 'icon.png': png } });

  // (a) 旧格式 v1 角色：能显示、不能导出。拒绝只能是拒绝，文件一个字节都不能动——
  // 严格 v2 校验若经带 corrupt-preservation 的读取器执行，会把这个合法文件改名成
  // .corrupt-*，角色随即从列表消失。
  library.importCharacter(importPayload('exportable', 'Exportable'));
  const legacyDir = characterDir('legacy-v1');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'pet.png'), png);
  fs.writeFileSync(path.join(legacyDir, 'icon.png'), png);
  fs.writeFileSync(path.join(legacyDir, 'character.json'),
    JSON.stringify({ ...meta, schemaVersion: 1, name: 'Legacy' }));
  const legacyBefore = snapshot('legacy-v1');
  assert.throws(() => library.characterExportBundle('legacy-v1'),
    refusal('POPPET_PACK_NOT_EXPORTABLE', 'legacy-schema'));
  assertUntouched('legacy-v1', legacyBefore);

  // (b) 随包内置 default 自身没有 schemaVersion：许可证拒绝同样不得碰它的文件。
  library.seedBuiltins();
  const defaultBefore = snapshot('default');
  assert.ok(defaultBefore.entries.includes('character.json'));
  assert.throws(() => library.characterExportBundle('default'), refusal('POPPET_PACK_BUILTIN_FORBIDDEN'));
  assertUntouched('default', defaultBefore);
  assert.equal(library.listCharacters().find(character => character.id === 'default')?.builtin, true);

  // (c) 严格 v2 但缺 icon.png。
  library.importCharacter(importPayload('no-icon', 'No icon'));
  fs.unlinkSync(path.join(characterDir('no-icon'), 'icon.png'));
  const noIconBefore = snapshot('no-icon');
  assert.throws(() => library.characterExportBundle('no-icon'),
    refusal('POPPET_PACK_NOT_EXPORTABLE', 'missing-icon'));
  assertUntouched('no-icon', noIconBefore);

  // (d) 可导出角色的 happy path：bundle 必须与"对落盘 JSON 直接做严格校验"的结果
  // 完全一致，组出的 .poppetpack 字节也一致——导出产物的 exact bytes/hash 语义零变化。
  const exportableBefore = snapshot('exportable');
  const bundle = library.characterExportBundle('exportable');
  const expectedMeta = validateCharacterMeta(JSON.parse(exportableBefore.metaBytes.toString('utf8')));
  assert.deepEqual(bundle.meta, expectedMeta);
  assert.deepEqual(Object.keys(bundle.files).sort(), ['icon.png', 'pet.png']);
  assert.ok(bundle.files['pet.png'].equals(png));
  assert.ok(bundle.files['icon.png'].equals(png));
  assertUntouched('exportable', exportableBefore);
  assert.ok(buildPoppetpack(bundle).equals(
    buildPoppetpack({ meta: expectedMeta, files: { 'pet.png': png, 'icon.png': png } })));

  // (e) 运行时合法、列表里看起来可导出（v2、非内置、有 icon），但过不了严格 v2
  // 校验（缺 source）：严格校验必须对已解析对象直接调用，失败只是带稳定码的拒绝。
  const looseMeta = { ...meta, name: 'Loose' };
  delete looseMeta.source;
  const looseDir = characterDir('loose-v2');
  fs.mkdirSync(looseDir);
  fs.writeFileSync(path.join(looseDir, 'pet.png'), png);
  fs.writeFileSync(path.join(looseDir, 'icon.png'), png);
  fs.writeFileSync(path.join(looseDir, 'character.json'), JSON.stringify(looseMeta));
  const looseBefore = snapshot('loose-v2');
  assert.equal(library.listCharacters().find(character => character.id === 'loose-v2')?.exportable, true);
  assert.throws(() => library.characterExportBundle('loose-v2'),
    error => error?.code === 'POPPET_PACK_NOT_EXPORTABLE' && error.reason === 'invalid-metadata'
      && /metadata\.source 缺失/.test(error.message));
  assertUntouched('loose-v2', looseBefore);
});

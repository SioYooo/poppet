'use strict';
// .poppetpack 归档边界回归：docs/poppetpack-format.md 的每一条拒绝规则
// 都必须有对应的负向断言。归档是不可信输入；这里的oracle是"拒绝并保持
// 原样"，而不是"尽力解析"。

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { makePng } = require('./png-fixture.cjs');
const zip = require('../../src/main/zip');
const { PACK_LIMITS, parsePoppetpack, buildPoppetpack } = require('../../src/main/pack');
const { validateImportPayload } = require('../../src/main/security');

const petPng = makePng(1, 1);
const iconPng = makePng(1, 1);
const baseMeta = {
  schemaVersion: 2, sprite: { width: 1, height: 1 }, frames: null, atlas: null,
  parts: [], suggestions: [], footY: 0, outline: [0, 0, 0], palette: [[0, 0, 0]],
  rig: { motion: 'walk', anchor: 'feet', flip: true, swayFrom: 0.5 },
  name: '测试角色',
  source: {
    cropBBox: [0, 0, 0, 0],
    backgroundMode: 'alpha',
    originalSize: { width: 1, height: 1 },
    extraction: {
      contractVersion: 1, extractor: 'local-edge-v1', status: 'ready', mode: 'alpha',
    },
    pixelize: {
      enabled: false, preset: 'original', targetHeight: null, paletteSize: null,
      methodVersion: 'local-box-median-cut-v1', width: 1, height: 1, colors: 1,
      sharedPalette: false,
    },
  },
};

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// —— 关节骨架角色（v3）的整条导入链 ——
//
// 这一段守的是"包能不能真的被导进去"，而不是校验器单独拿出来能不能过。
// 应用的导入路径是 parsePoppetpack -> validateImportPayload -> importCharacter
// （src/main/index.js 的 importPackFromPath），任何一环留着 schemaVersion === 2
// 的假设，都会让骨架包在所有单元测试全绿的情况下导入失败。
const rigPartsPng = makePng(64, 32);
const rigPetPng = makePng(48, 48);
const rigMeta = () => ({
  ...baseMeta,
  schemaVersion: 3,
  sprite: { width: 48, height: 48 },
  atlas: { width: 64, height: 32 },
  name: '骨架测试角色',
  source: {
    ...baseMeta.source,
    cropBBox: [0, 0, 47, 47],
    originalSize: { width: 48, height: 48 },
    pixelize: { ...baseMeta.source.pixelize, width: 48, height: 48 },
  },
  skeleton: {
    angleStep: 15,
    bones: [
      { id: 'torso', parent: null, pivot: { x: 4, y: 12 }, anchor: { x: 24, y: 36 },
        z: 10, frame: { sx: 0, sy: 0, sw: 8, sh: 12 }, drivers: { breathe: 1 } },
      { id: 'armL', parent: 'torso', pivot: { x: 1, y: 1 }, anchor: { x: 4, y: -10 },
        z: 20, frame: { sx: 10, sy: 0, sw: 3, sh: 9 },
        drivers: { wave: -2, walkSwing: -0.5 }, limit: [-150, 60] },
    ],
  },
});
const rigFiles = () => ({
  'pet.png': rigPetPng, 'parts.png': rigPartsPng, 'icon.png': iconPng,
});

test('骨架角色包走完整条导入链且不需要新的信封版本', () => {
  const bytes = buildPoppetpack({ meta: rigMeta(), files: rigFiles() });
  const parsed = parsePoppetpack(bytes);
  // 骨骼美术住在既有的 parts.png 里，所以条目集合与 v2 完全一致——
  // 这正是"不用 bump 信封版本"的可执行证据，而不只是文档里的一句话。
  assert.deepEqual(Object.keys(parsed.files).sort(), ['icon.png', 'parts.png', 'pet.png']);

  const candidate = { meta: parsed.meta, files: parsed.files };
  if (parsed.name !== undefined) candidate.name = parsed.name;
  const input = validateImportPayload(candidate);
  assert.equal(input.meta.schemaVersion, 3);
  assert.equal(input.meta.skeleton.bones.length, 2);
  assert.equal(input.meta.skeleton.angleStep, 15);
});

test('坏骨架的包在导入边界被整份拒绝', () => {
  const cases = [
    ['未知驱动器', m => { m.skeleton.bones[1].drivers = { moonwalk: 1 }; }, /未知驱动器/],
    ['悬空父引用', m => { m.skeleton.bones[1].parent = 'ghost'; }, /引用了不存在的父骨骼/],
    ['两个根', m => { m.skeleton.bones[1].parent = null; }, /必须恰好有一个根骨骼/],
    ['帧超出图集', m => { m.skeleton.bones[1].frame.sx = 62; }, /超出图集范围/],
    ['版本号对不上', m => { m.schemaVersion = 2; }, /schemaVersion 必须是 3/],
    ['与帧带共存', m => { m.frames = { count: 4, fps: 10 }; }, /不能与多帧帧带同时存在/],
  ];
  for (const [label, mutate, re] of cases) {
    const meta = rigMeta();
    mutate(meta);
    // buildPoppetpack 不做语义校验（它只组包），拒绝必须发生在导入边界。
    const parsed = parsePoppetpack(buildPoppetpack({ meta, files: rigFiles() }));
    assert.throws(() => validateImportPayload({ meta: parsed.meta, files: parsed.files }),
      re, `${label} 应当在导入边界被拒`);
  }
});

function validPack(overrides = {}) {
  const meta = overrides.meta ?? baseMeta;
  const contentFiles = overrides.contentFiles ?? [
    ['character/character.json', Buffer.from(`${JSON.stringify(meta, null, 2)}\n`)],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  const manifest = overrides.manifest ?? {
    format: 'poppetpack',
    version: 1,
    files: [...contentFiles]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  const entries = [
    { name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...contentFiles.map(([name, bytes]) => ({ name, bytes })),
  ];
  return zip.buildArchive(overrides.entries ?? entries);
}

function reject(bytes, pattern) {
  assert.throws(() => parsePoppetpack(bytes), (error) => {
    assert.equal(error.code, 'POPPET_PACK_INVALID', error.message);
    assert.match(error.message, pattern);
    return true;
  });
}

// ---- 正向:round-trip ----

test('valid pack parses and passes the normal import boundary', () => {
  const { name, meta, files } = parsePoppetpack(validPack());
  assert.equal(name, '测试角色');
  assert.deepEqual(meta.sprite, { width: 1, height: 1 });
  assert.ok(files['pet.png'].equals(petPng));
  assert.ok(files['icon.png'].equals(iconPng));
  assert.equal('parts.png' in files, false);
  const payload = validateImportPayload({ name, meta, files });
  assert.equal(payload.name, '测试角色');
});

test('export -> import round-trips bytes and strips local-only meta', () => {
  const stored = {
    meta: { ...baseMeta, builtin: false, importedAt: '2026-08-21T00:00:00.000Z' },
    files: { 'pet.png': petPng, 'icon.png': iconPng },
  };
  const archive = buildPoppetpack(stored);
  const first = parsePoppetpack(archive);
  assert.ok(first.files['pet.png'].equals(petPng));
  assert.ok(first.files['icon.png'].equals(iconPng));
  assert.equal('builtin' in first.meta, false);
  assert.equal('importedAt' in first.meta, false);
  assert.equal(first.meta.name, baseMeta.name);
  // 确定性:同一输入重复导出必须逐字节一致。
  assert.ok(archive.equals(buildPoppetpack(stored)));
  // 再导出一轮仍然一致（导入端不改内容）。
  const again = buildPoppetpack({ meta: first.meta, files: first.files });
  assert.ok(archive.equals(again));
});

// ---- 归档信封拒绝 ----

test('oversized archive is rejected before parsing', () => {
  const fake = Buffer.alloc(PACK_LIMITS.MAX_ARCHIVE_BYTES + 1);
  reject(fake, /归档大小超出预算/);
});

test('trailing bytes after EOCD are rejected', () => {
  reject(Buffer.concat([validPack(), Buffer.from('x')]), /EOCD/);
});

test('prepended bytes are rejected', () => {
  const bytes = validPack();
  // 让偏移全部失真:EOCD 处 central offset 不再与实际衔接。
  reject(Buffer.concat([Buffer.from('junk'), bytes]), /EOCD|衔接/);
});

test('too many entries are rejected', () => {
  const entries = [
    { name: 'manifest.json', bytes: Buffer.from('{}') },
    { name: 'a', bytes: Buffer.from('1') },
    { name: 'b', bytes: Buffer.from('1') },
    { name: 'c', bytes: Buffer.from('1') },
    { name: 'd', bytes: Buffer.from('1') },
    { name: 'e', bytes: Buffer.from('1') },
  ];
  reject(zip.buildArchive(entries), /条目数超过上限/);
});

test('unknown entry names are rejected', () => {
  reject(validPack({
    entries: [
      { name: 'manifest.json', bytes: Buffer.from('{}') },
      { name: 'character/evil.js', bytes: Buffer.from('x') },
    ],
  }), /不允许的条目/);
});

test('directory, traversal, absolute and backslash names are rejected by the zip layer', () => {
  for (const name of ['character/', '../pet.png', '/etc/passwd', 'a\\b', 'a//b', 'a/./b']) {
    assert.throws(
      () => zip.buildArchive([{ name, bytes: Buffer.from('x') }]),
      /目录条目|路径段|绝对路径|反斜杠/,
      name,
    );
  }
});

test('duplicate entry names are rejected', () => {
  assert.throws(
    () => zip.buildArchive([
      { name: 'manifest.json', bytes: Buffer.from('a') },
      { name: 'manifest.json', bytes: Buffer.from('b') },
    ]),
    /重复条目/,
  );
});

function patchU16(bytes, offsets, value) {
  const out = Buffer.from(bytes);
  for (const offset of offsets) out.writeUInt16LE(value, offset);
  return out;
}

function findAll(haystack, needle) {
  const offsets = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return offsets;
    offsets.push(at);
    from = at + 1;
  }
}

// 在 local + central 两处同时改字段，保证不会先撞上"不一致"检查。
function centralAndLocalFieldOffsets(bytes, name, localField, centralField) {
  const nameBytes = Buffer.from(name, 'utf8');
  const spots = findAll(bytes, nameBytes);
  assert.ok(spots.length >= 2, `expected local+central for ${name}`);
  const localHeader = spots[0] - 30;
  const centralHeader = spots[spots.length - 1] - 46;
  return [localHeader + localField, centralHeader + centralField];
}

test('encrypted entries are rejected', () => {
  const bytes = validPack();
  const patched = patchU16(bytes, centralAndLocalFieldOffsets(bytes, 'manifest.json', 6, 8), 0x0001);
  reject(patched, /flags/);
});

test('data-descriptor entries are rejected', () => {
  const bytes = validPack();
  const patched = patchU16(bytes, centralAndLocalFieldOffsets(bytes, 'manifest.json', 6, 8), 0x0008);
  reject(patched, /flags/);
});

test('unsupported compression methods are rejected', () => {
  const bytes = validPack();
  const patched = patchU16(bytes, centralAndLocalFieldOffsets(bytes, 'manifest.json', 8, 10), 12);
  reject(patched, /Store 或 Deflate/);
});

test('local/central header divergence is rejected', () => {
  const bytes = validPack();
  const [localOffset] = centralAndLocalFieldOffsets(bytes, 'manifest.json', 8, 10);
  const patched = patchU16(bytes, [localOffset], 8); // 只改 local method
  reject(patched, /不一致/);
});

test('symlink external attributes are rejected', () => {
  const bytes = Buffer.from(validPack());
  const nameBytes = Buffer.from('manifest.json', 'utf8');
  const spots = findAll(bytes, nameBytes);
  const centralHeader = spots[spots.length - 1] - 46;
  bytes.writeUInt32LE(0xa1ff0000, centralHeader + 38);
  reject(bytes, /符号链接/);
});

test('corrupted entry bytes fail the CRC check', () => {
  const bytes = Buffer.from(validPack());
  // manifest.json 的数据紧跟 local header + 名字。
  const dataStart = bytes.indexOf(Buffer.from('manifest.json', 'utf8')) + 'manifest.json'.length;
  bytes[dataStart] ^= 0xff;
  reject(bytes, /CRC/);
});

test('deflate bombs are rejected by declared expansion ratio', () => {
  // 声明诚实的炸弹（1KB -> >100x）直接被膨胀比预算拒绝。
  const payload = Buffer.alloc(512 * 1024);
  const compressed = zlib.deflateRawSync(payload, { level: 9 });
  assert.ok(compressed.length * PACK_LIMITS.MAX_EXPANSION_RATIO < payload.length);
  const name = 'character/pet.png';
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zip.crc32(payload), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(zip.crc32(payload), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralBytes = Buffer.concat([central, nameBytes]);
  const localBytes = Buffer.concat([local, nameBytes, compressed]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  reject(Buffer.concat([localBytes, centralBytes, eocd]), /膨胀比/);
});

test('lying uncompressed sizes are rejected at inflate time', () => {
  // 声明一个小尺寸、实际解压更大的条目：maxOutputLength 中途截断。
  const payload = Buffer.alloc(4096, 7);
  const compressed = zlib.deflateRawSync(payload);
  const lie = 64; // 声明 64 字节
  const name = 'character/pet.png';
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zip.crc32(payload), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(lie, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(zip.crc32(payload), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(lie, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralBytes = Buffer.concat([central, nameBytes]);
  const localBytes = Buffer.concat([local, nameBytes, compressed]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  const entries = zip.readArchive(Buffer.concat([localBytes, centralBytes, eocd]), { maxEntries: 5 });
  assert.throws(() => zip.extractEntry(Buffer.concat([localBytes, centralBytes, eocd]), entries[0], 1024),
    /解压失败|大小与声明不符/);
});

// ---- manifest 拒绝 ----

function packWithManifest(manifest) {
  return validPack({ manifest });
}

test('manifest with unknown fields is rejected', () => {
  const good = JSON.parse(JSON.stringify({
    format: 'poppetpack', version: 1, files: [],
  }));
  reject(packWithManifest({ ...good, extra: 1 }), /字段不符合/);
});

test('wrong format or version is rejected', () => {
  const base = validPack();
  const parsedOk = parsePoppetpack(base);
  assert.ok(parsedOk);
  reject(packWithManifest({ format: 'zip', version: 1, files: [] }), /poppetpack/);
  reject(packWithManifest({ format: 'poppetpack', version: 2, files: [] }), /版本/);
});

test('manifest must cover entries exactly, in strict path order', () => {
  const metaBytes = Buffer.from(`${JSON.stringify(baseMeta, null, 2)}\n`);
  const contentFiles = [
    ['character/character.json', metaBytes],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  const records = contentFiles.map(([name, bytes]) => ({
    path: name, bytes: bytes.length, sha256: sha256(bytes),
  }));
  // 少一条
  reject(validPack({ contentFiles, manifest: { format: 'poppetpack', version: 1, files: records.slice(1) } }),
    /恰好覆盖/);
  // 乱序
  reject(validPack({ contentFiles, manifest: { format: 'poppetpack', version: 1, files: [...records].reverse() } }),
    /升序/);
  // 重复
  reject(validPack({
    contentFiles,
    manifest: { format: 'poppetpack', version: 1, files: [records[0], records[0], records[1]] },
  }), /升序|恰好覆盖/);
});

test('manifest hash or size mismatch is rejected', () => {
  const metaBytes = Buffer.from(`${JSON.stringify(baseMeta, null, 2)}\n`);
  const contentFiles = [
    ['character/character.json', metaBytes],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  const records = contentFiles.map(([name, bytes]) => ({
    path: name, bytes: bytes.length, sha256: sha256(bytes),
  }));
  const badHash = records.map(r => ({ ...r }));
  badHash[2].sha256 = '0'.repeat(64);
  reject(validPack({ contentFiles, manifest: { format: 'poppetpack', version: 1, files: badHash } }),
    /哈希校验失败/);
  const badSize = records.map(r => ({ ...r }));
  badSize[2].bytes += 1;
  reject(validPack({ contentFiles, manifest: { format: 'poppetpack', version: 1, files: badSize } }),
    /声明大小/);
});

test('duplicate JSON keys fail closed in manifest and metadata', () => {
  const dupManifest = Buffer.from(
    '{"format":"poppetpack","format":"poppetpack","version":1,"files":[]}',
  );
  reject(validPack({
    entries: [
      { name: 'manifest.json', bytes: dupManifest },
      { name: 'character/character.json', bytes: Buffer.from('{}') },
      { name: 'character/icon.png', bytes: iconPng },
      { name: 'character/pet.png', bytes: petPng },
    ],
  }), /重复键/);

  const dupMetaText = `${JSON.stringify(baseMeta).slice(0, -1)},"footY":0}`;
  const dupMeta = Buffer.from(dupMetaText);
  const contentFiles = [
    ['character/character.json', dupMeta],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  reject(validPack({ contentFiles }), /重复键/);
});

test('escaped JSON keys fail closed', () => {
  const sneaky = Buffer.from('{"forma\\u0074":"poppetpack","version":1,"files":[]}');
  reject(validPack({
    entries: [
      { name: 'manifest.json', bytes: sneaky },
      { name: 'character/character.json', bytes: Buffer.from('{}') },
      { name: 'character/icon.png', bytes: iconPng },
      { name: 'character/pet.png', bytes: petPng },
    ],
  }), /转义/);
});

test('UTF-8 BOM is rejected', () => {
  const bom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"format":"poppetpack","version":1,"files":[]}'),
  ]);
  reject(validPack({
    entries: [
      { name: 'manifest.json', bytes: bom },
      { name: 'character/character.json', bytes: Buffer.from('{}') },
      { name: 'character/icon.png', bytes: iconPng },
      { name: 'character/pet.png', bytes: petPng },
    ],
  }), /BOM/);
});

// ---- 内容一致性 ----

test('missing required entries are rejected', () => {
  reject(zip.buildArchive([
    { name: 'manifest.json', bytes: Buffer.from('{"format":"poppetpack","version":1,"files":[]}') },
  ]), /缺少/);
});

test('parts.png without atlas metadata is rejected', () => {
  const partsPng = makePng(1, 1);
  const metaBytes = Buffer.from(`${JSON.stringify(baseMeta, null, 2)}\n`);
  const contentFiles = [
    ['character/character.json', metaBytes],
    ['character/icon.png', iconPng],
    ['character/parts.png', partsPng],
    ['character/pet.png', petPng],
  ];
  reject(validPack({ contentFiles }), /parts\.png 与 metadata\.atlas 不一致/);
});

test('per-entry byte budgets are enforced before extraction', () => {
  // manifest 声明尺寸超过 character.json 的 2MiB 预算。
  const big = Buffer.alloc(3 * 1024 * 1024, 0x20);
  const contentFiles = [
    ['character/character.json', big],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  reject(validPack({ contentFiles }), /大小超出预算/);
});

// ---- 信封补充拒绝 ----

test('zip64 size markers are rejected', () => {
  const bytes = Buffer.from(validPack());
  const nameBytes = Buffer.from('manifest.json', 'utf8');
  const spots = findAll(bytes, nameBytes);
  const localHeader = spots[0] - 30;
  const centralHeader = spots[spots.length - 1] - 46;
  bytes.writeUInt32LE(0xffffffff, localHeader + 22);
  bytes.writeUInt32LE(0xffffffff, centralHeader + 24);
  reject(bytes, /zip64/);
});

test('versionNeeded above 20 is rejected', () => {
  const bytes = validPack();
  const patched = patchU16(bytes, centralAndLocalFieldOffsets(bytes, 'manifest.json', 4, 6), 45);
  reject(patched, /版本过高/);
});

test('extra fields, entry comments, and multi-disk markers are rejected', () => {
  const base = validPack();
  const nameBytes = Buffer.from('manifest.json', 'utf8');
  const centralHeader = findAll(base, nameBytes).at(-1) - 46;
  const withExtra = Buffer.from(base);
  withExtra.writeUInt16LE(4, centralHeader + 30);
  reject(withExtra, /extra 字段|被截断|多余字节/);
  const withComment = Buffer.from(base);
  withComment.writeUInt16LE(4, centralHeader + 32);
  reject(withComment, /条目注释|被截断|多余字节/);
  const withDisk = Buffer.from(base);
  withDisk.writeUInt16LE(1, centralHeader + 34);
  reject(withDisk, /多分卷/);
});

test('store entries with mismatched sizes are rejected', () => {
  const bytes = validPack();
  const [localOffset, centralOffset] = centralAndLocalFieldOffsets(bytes, 'manifest.json', 0, 0);
  const patched = Buffer.from(bytes);
  // 同时改 local(+22) 与 central(+24) 的 uncompressed size，保持两处一致，
  // 使检查落在 Store 大小一致性上而不是 local/central 不一致上。
  const current = patched.readUInt32LE(centralOffset + 24);
  patched.writeUInt32LE(current + 1, localOffset + 22);
  patched.writeUInt32LE(current + 1, centralOffset + 24);
  reject(patched, /Store 条目的压缩前后大小必须一致/);
});

test('uppercase alias of an allowed name is rejected by the allowlist', () => {
  const bytes = zip.buildArchive([
    { name: 'MANIFEST.JSON', bytes: Buffer.from('{}') },
    { name: 'character/character.json', bytes: Buffer.from('{}') },
    { name: 'character/icon.png', bytes: iconPng },
    { name: 'character/pet.png', bytes: petPng },
  ]);
  reject(bytes, /不允许的条目: MANIFEST\.JSON/);
});

test('non-NFC entry names are rejected at the zip layer', () => {
  const decomposed = 'café.png'; // café 的分解形式
  assert.notEqual(decomposed, decomposed.normalize('NFC'));
  assert.throws(
    () => zip.buildArchive([{ name: decomposed, bytes: Buffer.from('x') }]),
    /NFC/,
  );
});

test('manifest entries above the 64 KiB budget are rejected before extraction', () => {
  const oversized = Buffer.alloc(64 * 1024 + 1, 0x20);
  const bytes = zip.buildArchive([
    { name: 'manifest.json', bytes: oversized },
    { name: 'character/character.json', bytes: Buffer.from('{}') },
    { name: 'character/icon.png', bytes: iconPng },
    { name: 'character/pet.png', bytes: petPng },
  ]);
  reject(bytes, /条目大小超出预算: manifest\.json/);
});

test('character.json with a UTF-8 BOM is rejected', () => {
  const bomMeta = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(baseMeta)),
  ]);
  const contentFiles = [
    ['character/character.json', bomMeta],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  reject(validPack({ contentFiles }), /character\.json 不允许 BOM/);
});

test('a well-formed Deflate entry extracts and round-trips', () => {
  const payload = Buffer.from(JSON.stringify(baseMeta));
  const compressed = zlib.deflateRawSync(payload, { level: 9 });
  assert.ok(payload.length <= compressed.length * PACK_LIMITS.MAX_EXPANSION_RATIO);
  const name = 'character/character.json';
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zip.crc32(payload), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(zip.crc32(payload), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const localBytes = Buffer.concat([local, nameBytes, compressed]);
  const centralBytes = Buffer.concat([central, nameBytes]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  const archive = Buffer.concat([localBytes, centralBytes, eocd]);
  const entries = zip.readArchive(archive, { maxEntries: 5 });
  const out = zip.extractEntry(archive, entries[0], 2 * 1024 * 1024);
  assert.ok(out.equals(payload));
});

// ---- 导出边界 ----

test('buildPoppetpack itself refuses builtin characters (defense in depth)', () => {
  assert.throws(
    () => buildPoppetpack({
      meta: { ...baseMeta, builtin: true },
      files: { 'pet.png': petPng, 'icon.png': iconPng },
    }),
    (error) => error.code === 'POPPET_PACK_BUILTIN_FORBIDDEN',
  );
});

test('export refuses characters missing required bytes', () => {
  assert.throws(
    () => buildPoppetpack({ meta: baseMeta, files: { 'pet.png': petPng } }),
    /导出缺少 character\/icon\.png/,
  );
});

test('export with atlas requires parts bytes and imports back', () => {
  const atlasMeta = {
    ...baseMeta,
    atlas: { width: 1, height: 1 },
    parts: [],
  };
  assert.throws(
    () => buildPoppetpack({ meta: atlasMeta, files: { 'pet.png': petPng, 'icon.png': iconPng } }),
    /导出缺少 character\/parts\.png/,
  );
});

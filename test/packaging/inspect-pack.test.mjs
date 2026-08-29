// tools/inspect-pack.mjs 的黑盒回归：诊断器必须与应用的导入链给出同一结论，
// 输出稳定的 POPPET_* 错误码，并且在任何输入上都只读——不写文件、不解包到磁盘。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { PACK_LIMITS, buildPoppetpack } = require('../../src/main/pack');
const zip = require('../../src/main/zip');
const { makePng } = require('../security/png-fixture.cjs');

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const TOOL = 'tools/inspect-pack.mjs';
const toolSource = fs.readFileSync(path.join(repoRoot, TOOL), 'utf8');

const petPng = makePng(1, 1);
const iconPng = makePng(1, 1);
// 与 test/security/poppetpack.test.cjs 的 baseMeta 同形：能通过 validateImportPayload。
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
const metaBytes = Buffer.from(`${JSON.stringify(baseMeta, null, 2)}\n`);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-inspect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePack(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function goodArchive(meta = baseMeta, files = { 'pet.png': petPng, 'icon.png': iconPng }) {
  return buildPoppetpack({ meta, files });
}

// 用真实 zip 层手工组包，manifest 可被 mutate 改坏。
function archiveWithManifest(contentFiles, mutate = () => {}) {
  const files = contentFiles.map(([p, b]) => ({ path: p, bytes: b.length, sha256: sha256(b) }));
  mutate(files);
  const manifest = Buffer.from(`${JSON.stringify({ format: 'poppetpack', version: 1, files }, null, 2)}\n`);
  return zip.buildArchive([
    { name: 'manifest.json', bytes: manifest },
    ...contentFiles.map(([name, bytes]) => ({ name, bytes })),
  ]);
}

// 运行 --json 并断言：进程正常启动、stdout 恰好是一个 JSON 对象、目录内容未被改动。
function inspectJson(dir, file) {
  const before = fs.readdirSync(dir).sort();
  const result = runTool(['--json', file]);
  assert.equal(result.error, undefined);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'inspector must not create files');
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report, 'object');
  assert.notEqual(report, null);
  return { result, report };
}

test('a valid package is accepted and --json reports entries, digests, and budget usage', (t) => {
  const dir = tempDir(t);
  const archive = goodArchive();
  const file = writePack(dir, 'good.poppetpack', archive);
  const { result, report } = inspectJson(dir, file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.ok, true);
  assert.equal(report.stage, 'accepted');
  assert.equal(report.errorCode, null);
  assert.equal(report.error, null);
  assert.equal(report.listingError, null);
  assert.deepEqual(report.limits, { ...PACK_LIMITS });

  const expected = new Map([
    ['character/character.json', metaBytes],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ]);
  assert.deepEqual(report.entries.map(entry => entry.name), ['manifest.json', ...expected.keys()]);
  let total = 0;
  for (const entry of report.entries) {
    assert.equal(entry.method, 'store');
    assert.equal(entry.compressedBytes, entry.uncompressedBytes);
    assert.equal(entry.expansionRatio, 1);
    assert.equal(entry.hashSkipped, null);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.match(entry.crc32, /^[0-9a-f]{8}$/);
    total += entry.uncompressedBytes;
    if (entry.name === 'manifest.json') {
      assert.equal(entry.manifest, null);
      continue;
    }
    const bytes = expected.get(entry.name);
    assert.equal(entry.uncompressedBytes, bytes.length);
    assert.equal(entry.sha256, sha256(bytes));
    assert.deepEqual(entry.manifest, {
      declared: true,
      declaredBytes: bytes.length,
      declaredSha256: sha256(bytes),
      bytesMatch: true,
      sha256Match: true,
    });
  }

  assert.equal(report.manifest.format, 'poppetpack');
  assert.equal(report.manifest.version, 1);
  assert.deepEqual(report.manifest.keys, ['format', 'version', 'files']);
  assert.deepEqual(report.manifest.files.map(record => record.path), [...expected.keys()]);
  assert.deepEqual(report.manifest.missingEntries, []);
  assert.equal(report.manifestError, null);

  const manifestEntry = report.entries.find(entry => entry.name === 'manifest.json');
  assert.deepEqual(report.usage, {
    archiveBytes: { used: archive.length, limit: PACK_LIMITS.MAX_ARCHIVE_BYTES, within: true },
    entries: { used: 4, limit: PACK_LIMITS.MAX_ENTRIES, within: true },
    totalCompressedBytes: { used: total, limit: null, within: null },
    totalUncompressedBytes: { used: total, limit: PACK_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES, within: true },
    manifestBytes: { used: manifestEntry.uncompressedBytes, limit: PACK_LIMITS.MAX_MANIFEST_BYTES, within: true },
    expansionRatio: { used: 1, limit: PACK_LIMITS.MAX_EXPANSION_RATIO, within: true },
    maxEntryExpansionRatio: { used: 1, limit: PACK_LIMITS.MAX_EXPANSION_RATIO, within: true },
  });
  assert.ok(total < archive.length, 'uncompressed total excludes zip headers');
  assert.deepEqual(report.character, {
    name: '测试角色',
    schemaVersion: 2,
    hasAtlas: false,
    sprite: { width: 1, height: 1 },
    frames: null,
    files: ['icon.png', 'pet.png'],
  });

  // 文本模式同样退出 0，并把条目名、哈希与 manifest 一致性打印出来。
  const text = runTool([file]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /verdict: ACCEPTED/);
  assert.match(text.stdout, new RegExp(`character/pet\\.png\\n[^\\n]*\\n\\s+sha256=${sha256(petPng)} manifest=match`));
  assert.match(text.stdout, /entries\s+4 \/ 5\s+ok/);
  // --json 放在文件名后面也生效。
  const trailing = runTool([file, '--json']);
  assert.equal(trailing.status, 0);
  assert.equal(JSON.parse(trailing.stdout).ok, true);
});

test('a tampered entry is rejected with POPPET_PACK_INVALID and the failing entry is singled out', (t) => {
  const dir = tempDir(t);
  const bytes = Buffer.from(goodArchive());
  // icon.png 与 pet.png 字节相同且 icon 排在前面，所以最后一次出现的才是
  // pet.png 的数据段；central directory 不含 PNG 字节。
  const petData = bytes.lastIndexOf(petPng);
  assert.ok(petData > 0);
  bytes[petData + 8] ^= 0xff;
  const file = writePack(dir, 'tampered.poppetpack', bytes);

  const { result, report } = inspectJson(dir, file);
  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'parse');
  assert.equal(report.errorCode, 'POPPET_PACK_INVALID');
  assert.equal(report.cause, null);
  assert.match(report.error, /CRC 校验失败: character\/pet\.png/);
  assert.equal(report.character, null);

  const pet = report.entries.find(entry => entry.name === 'character/pet.png');
  assert.equal(pet.sha256, null);
  assert.match(pet.hashSkipped, /CRC/);
  assert.equal(pet.manifest.bytesMatch, true);
  assert.equal(pet.manifest.sha256Match, null);
  for (const other of report.entries.filter(entry => entry.name !== 'character/pet.png')) {
    assert.match(other.sha256, /^[0-9a-f]{64}$/, other.name);
    assert.equal(other.hashSkipped, null);
  }

  const text = runTool([file]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /verdict: REJECTED at stage parse/);
  assert.match(text.stdout, /error: POPPET_PACK_INVALID .*CRC/);
  assert.match(text.stdout, /sha256=skipped \(.*CRC.*\) manifest=unverified/);
});

test('a manifest digest mismatch is rejected and the mismatching entry is flagged', (t) => {
  const dir = tempDir(t);
  const contentFiles = [
    ['character/character.json', metaBytes],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  const archive = archiveWithManifest(contentFiles, (files) => { files[2].sha256 = '0'.repeat(64); });
  const file = writePack(dir, 'bad-digest.poppetpack', archive);

  const { result, report } = inspectJson(dir, file);
  assert.equal(result.status, 1);
  assert.equal(report.stage, 'parse');
  assert.equal(report.errorCode, 'POPPET_PACK_INVALID');
  assert.match(report.error, /哈希校验失败: character\/pet\.png/);
  const pet = report.entries.find(entry => entry.name === 'character/pet.png');
  assert.equal(pet.sha256, sha256(petPng));
  assert.deepEqual(pet.manifest, {
    declared: true,
    declaredBytes: petPng.length,
    declaredSha256: '0'.repeat(64),
    bytesMatch: true,
    sha256Match: false,
  });
  const icon = report.entries.find(entry => entry.name === 'character/icon.png');
  assert.equal(icon.manifest.sha256Match, true);

  const text = runTool([file]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /character\/pet\.png\n[^\n]*\n[^\n]*manifest=MISMATCH\(sha256\)/);
});

test('non-archive bytes and over-limit entry counts are rejected with POPPET_PACK_INVALID', (t) => {
  const dir = tempDir(t);
  const garbageBytes = Buffer.from('this is not a zip archive at all, just some text\n'.repeat(4));
  const garbage = writePack(dir, 'garbage.poppetpack', garbageBytes);
  const g = inspectJson(dir, garbage);
  assert.equal(g.result.status, 1);
  assert.equal(g.report.ok, false);
  assert.equal(g.report.stage, 'parse');
  assert.equal(g.report.errorCode, 'POPPET_PACK_INVALID');
  assert.match(g.report.error, /EOCD/);
  assert.match(g.report.listingError, /EOCD/);
  assert.equal(g.report.entries, null);
  assert.equal(g.report.manifest, null);
  assert.equal(g.report.usage.archiveBytes.used, garbageBytes.length);
  assert.equal(g.report.usage.entries.used, null);
  assert.equal(g.report.usage.entries.limit, PACK_LIMITS.MAX_ENTRIES);

  const crowded = zip.buildArchive([
    { name: 'manifest.json', bytes: Buffer.from('{}') },
    ...['a', 'b', 'c', 'd', 'e'].map(name => ({ name, bytes: Buffer.from('1') })),
  ]);
  const crowdedFile = writePack(dir, 'crowded.poppetpack', crowded);
  const c = inspectJson(dir, crowdedFile);
  assert.equal(c.result.status, 1);
  assert.equal(c.report.errorCode, 'POPPET_PACK_INVALID');
  assert.match(c.report.error, new RegExp(`条目数超过上限 ${PACK_LIMITS.MAX_ENTRIES}`));
  assert.equal(c.report.entries, null);
});

test('an entry above its per-entry budget is rejected before extraction', (t) => {
  const dir = tempDir(t);
  const big = Buffer.alloc(3 * 1024 * 1024, 0x20); // character.json 的预算是 2 MiB
  const contentFiles = [
    ['character/character.json', big],
    ['character/icon.png', iconPng],
    ['character/pet.png', petPng],
  ];
  const file = writePack(dir, 'oversized-entry.poppetpack', archiveWithManifest(contentFiles));
  const { result, report } = inspectJson(dir, file);
  assert.equal(result.status, 1);
  assert.equal(report.stage, 'parse');
  assert.equal(report.errorCode, 'POPPET_PACK_INVALID');
  assert.match(report.error, /条目大小超出预算: character\/character\.json/);
  const entry = report.entries.find(row => row.name === 'character/character.json');
  assert.equal(entry.uncompressedBytes, big.length);
  assert.equal(report.usage.totalUncompressedBytes.within, true);
  assert.equal(report.usage.entries.used, 4);
});

test('a file above MAX_ARCHIVE_BYTES is refused at the read stage before any parsing', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'huge.poppetpack');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, PACK_LIMITS.MAX_ARCHIVE_BYTES + 1);
  assert.equal(fs.statSync(file).size, PACK_LIMITS.MAX_ARCHIVE_BYTES + 1);
  const { result, report } = inspectJson(dir, file);
  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'read');
  assert.equal(report.errorCode, 'POPPET_INVALID_INPUT');
  assert.match(report.error, /角色包 大小无效/);
  assert.equal(report.usage, null);
  assert.equal(report.entries, null);
  assert.deepEqual(report.limits, { ...PACK_LIMITS });

  const empty = writePack(dir, 'empty.poppetpack', Buffer.alloc(0));
  const e = inspectJson(dir, empty);
  assert.equal(e.result.status, 1);
  assert.equal(e.report.errorCode, 'POPPET_INVALID_INPUT');
  assert.match(e.report.error, /大小无效/);
});

test('symbolic links, directories, and missing paths are refused at the read stage', (t) => {
  const dir = tempDir(t);
  const target = writePack(dir, 'target.poppetpack', goodArchive());
  const link = path.join(dir, 'link.poppetpack');
  let linked = false;
  try {
    fs.symlinkSync(target, link);
    linked = true;
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.diagnostic('symlink creation is not permitted on this host; symlink case not exercised');
  }
  if (linked) {
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    const { result, report } = inspectJson(dir, link);
    assert.equal(result.status, 1);
    assert.equal(report.ok, false);
    assert.equal(report.stage, 'read');
    assert.equal(report.errorCode, 'POPPET_INVALID_INPUT');
    assert.match(report.error, /角色包 必须是普通文件/);
    assert.equal(report.usage, null);
    assert.equal(report.entries, null);
    // 拒绝的是链接本身而不是内容：同一目标经由真实路径仍然被接受。
    assert.equal(runTool(['--json', target]).status, 0);
  }

  const asDirectory = inspectJson(dir, dir);
  assert.equal(asDirectory.result.status, 1);
  assert.equal(asDirectory.report.stage, 'read');
  assert.equal(asDirectory.report.errorCode, 'POPPET_INVALID_INPUT');
  assert.match(asDirectory.report.error, /必须是普通文件/);

  const missing = inspectJson(dir, path.join(dir, 'does-not-exist.poppetpack'));
  assert.equal(missing.result.status, 1);
  assert.equal(missing.report.stage, 'read');
  assert.equal(missing.report.errorCode, 'POPPET_PACK_INVALID');
  assert.equal(missing.report.cause, 'ENOENT');
});

test('a package that parses but fails Core validation is rejected at the payload stage', (t) => {
  const dir = tempDir(t);
  // 非正方形 icon：parsePoppetpack 不看图片尺寸，validateImportPayload 会拒绝。
  const archive = goodArchive(baseMeta, { 'pet.png': petPng, 'icon.png': makePng(2, 1) });
  const file = writePack(dir, 'bad-icon.poppetpack', archive);
  const { result, report } = inspectJson(dir, file);
  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'payload');
  assert.equal(report.errorCode, 'POPPET_INVALID_INPUT');
  assert.match(report.error, /icon\.png 必须是边长不超过/);
  assert.equal(report.character, null);
  // 归档层与 manifest 层本身是干净的：条目全部可哈希且与 manifest 一致。
  assert.equal(report.entries.length, 4);
  for (const entry of report.entries) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, entry.name);
    if (entry.name !== 'manifest.json') assert.equal(entry.manifest.sha256Match, true, entry.name);
  }
  const text = runTool([file]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /verdict: REJECTED at stage payload/);
});

test('usage errors exit 2 with usage text on stderr and nothing on stdout', () => {
  const none = runTool([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /missing <file\.poppetpack>/);
  assert.match(none.stderr, /usage: node tools\/inspect-pack\.mjs \[--json\] <file\.poppetpack>/);
  assert.equal(none.stdout, '');

  const two = runTool(['a.poppetpack', 'b.poppetpack']);
  assert.equal(two.status, 2);
  assert.match(two.stderr, /expected exactly one <file\.poppetpack>/);
  assert.equal(two.stdout, '');

  const unknown = runTool(['--bogus', 'a.poppetpack']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option: --bogus/);

  const flagOnly = runTool(['--json']);
  assert.equal(flagOnly.status, 2);
  assert.equal(flagOnly.stdout, '');

  const help = runTool(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node tools\/inspect-pack\.mjs/);
});

test('the inspector reuses the bounded reader and the real import chain, with no write or network surface', () => {
  assert.match(toolSource, /readRegularFileLimitedSync\(file, PACK_LIMITS\.MAX_ARCHIVE_BYTES, READ_LABEL\)/);
  assert.match(toolSource, /const READ_LABEL = '角色包'/);
  assert.match(toolSource, /parsePoppetpack\(bytes\)/);
  assert.match(toolSource, /validateImportPayload\(candidate\)/);
  assert.match(toolSource, /zip\.readArchive\(bytes, \{ maxEntries: PACK_LIMITS\.MAX_ENTRIES \}\)/);
  assert.doesNotMatch(toolSource, /require\('electron'\)|from 'electron'/);
  assert.doesNotMatch(
    toolSource,
    /writeFile|createWriteStream|appendFile|mkdir|copyFile|renameSync|rmSync|unlink|truncate|openSync|node:net|node:http|node:https|node:dgram|node:tls|fetch\(/,
  );
  assert.doesNotMatch(toolSource, /process\.exit\(/);
});

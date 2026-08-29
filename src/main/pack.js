'use strict';
// .poppetpack v1 导入/导出（合约见 docs/poppetpack-format.md）。
//
// 这里只做纯字节 <-> 已验证载荷的转换，不做任何磁盘或 Electron 操作：
// 归档的有界读取由调用方用 readRegularFileLimitedSync 完成；解出的载荷
// 走 validateImportPayload -> importCharacter 的既有导入边界完成暂存与
// 原子落库。解压全程在内存里进行——字节在通过既有导入边界之前不落盘，
// 比合约草案的"先解压进 staging 再重读"更强：不存在可被替换的中间文件。
//
// 预算刻意复用 Core 的既有上限（LIMITS），不另造 magic number。

const crypto = require('node:crypto');
const { LIMITS } = require('./security');
const zip = require('./zip');

const PACK_FORMAT = 'poppetpack';
const PACK_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const CHARACTER_PREFIX = 'character/';

const PACK_LIMITS = Object.freeze({
  // 解析前的归档字节上限。
  MAX_ARCHIVE_BYTES: 32 * 1024 * 1024,
  // 含 manifest 在内的条目数上限。
  MAX_ENTRIES: 5,
  // 解压后总字节上限，与 Core 导入总预算一致。
  MAX_TOTAL_UNCOMPRESSED_BYTES: LIMITS.MAX_IMPORT_BYTES,
  MAX_MANIFEST_BYTES: 64 * 1024,
  // 总体与单条目膨胀比上限。
  MAX_EXPANSION_RATIO: 100,
});

// 允许的条目及各自的解压预算。parts.png 是否必须存在由
// metadata.atlas 决定，与 validateCharacterPngFiles 的规则一致。
const ENTRY_BUDGETS = new Map([
  [MANIFEST_NAME, PACK_LIMITS.MAX_MANIFEST_BYTES],
  ['character/character.json', LIMITS.MAX_METADATA_BYTES],
  ['character/pet.png', LIMITS.MAX_GENERATED_FILE_BYTES],
  ['character/icon.png', LIMITS.MAX_GENERATED_FILE_BYTES],
  ['character/parts.png', LIMITS.MAX_GENERATED_FILE_BYTES],
]);
const REQUIRED_ENTRIES = ['character/character.json', 'character/icon.png', 'character/pet.png'];
// 导出时会剥离的本地状态字段：它们描述"这台机器上的这次导入"，
// 不属于可交换的角色内容；导入方会重新生成。
const LOCAL_ONLY_META_KEYS = ['builtin', 'importedAt'];

function fail(message) {
  const error = new Error(message);
  error.code = 'POPPET_PACK_INVALID';
  throw error;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// JSON.parse 对重复键静默取后值；合约要求 fail closed，所以先做一次
// 词法扫描。只跟踪字符串与对象/数组嵌套，不重建值。
function assertNoDuplicateJsonKeys(text, label) {
  const stack = [];
  let i = 0;
  let pendingKeyContext = false; // 位于对象中、下一个字符串应当是键
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let raw = '';
      while (j < n) {
        const c = text[j];
        if (c === '\\') {
          raw += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === '"') break;
        raw += c;
        j += 1;
      }
      if (j >= n) fail(`${label} 字符串未闭合`);
      i = j + 1;
      if (pendingKeyContext) {
        let k = i;
        while (k < n && /\s/.test(text[k])) k += 1;
        if (text[k] === ':') {
          // 键必须是无转义的字面字符串：转义（如 a vs a）可以让两个
          // 写法不同的键在解析后碰撞，绕过基于原文的重复检测。
          if (raw.includes('\\')) fail(`${label} 键不允许转义序列`);
          const top = stack[stack.length - 1];
          if (top.keys.has(raw)) fail(`${label} 存在重复键: ${raw}`);
          top.keys.add(raw);
          pendingKeyContext = false;
        }
      }
      continue;
    }
    if (ch === '{') {
      stack.push({ type: 'object', keys: new Set() });
      pendingKeyContext = true;
    } else if (ch === '}') {
      if (!stack.length || stack[stack.length - 1].type !== 'object') fail(`${label} 括号不匹配`);
      stack.pop();
      pendingKeyContext = false;
    } else if (ch === '[') {
      stack.push({ type: 'array' });
      pendingKeyContext = false;
    } else if (ch === ']') {
      if (!stack.length || stack[stack.length - 1].type !== 'array') fail(`${label} 括号不匹配`);
      stack.pop();
      pendingKeyContext = false;
    } else if (ch === ',') {
      const top = stack[stack.length - 1];
      pendingKeyContext = !!top && top.type === 'object';
    }
    i += 1;
  }
  if (stack.length) fail(`${label} 括号不匹配`);
}

function parseStrictJson(bytes, label) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label} 不允许 BOM`);
  }
  const text = bytes.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') !== bytes.length || text.includes('�')) {
    fail(`${label} 不是有效 UTF-8`);
  }
  assertNoDuplicateJsonKeys(text, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`${label} JSON 解析失败: ${error.message}`);
  }
  return value;
}

function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function validateManifest(manifestBytes, entries) {
  const manifest = parseStrictJson(manifestBytes, 'manifest.json');
  if (!isPlainRecord(manifest)) fail('manifest.json 必须是对象');
  const keys = Object.keys(manifest).sort();
  if (keys.join(',') !== 'files,format,version') fail('manifest.json 字段不符合 v1 定义');
  if (manifest.format !== PACK_FORMAT) fail('manifest.format 必须是 poppetpack');
  if (manifest.version !== PACK_VERSION) fail(`不支持的 poppetpack 版本: ${manifest.version}`);
  if (!Array.isArray(manifest.files)) fail('manifest.files 必须是数组');

  const contentEntries = entries.filter(entry => entry.name !== MANIFEST_NAME);
  if (manifest.files.length !== contentEntries.length) {
    fail('manifest.files 必须恰好覆盖每个非 manifest 条目');
  }
  const expectedPaths = contentEntries.map(entry => entry.name).sort();
  const records = new Map();
  let previousPath = '';
  for (const record of manifest.files) {
    if (!isPlainRecord(record)) fail('manifest.files 记录必须是对象');
    const recordKeys = Object.keys(record).sort();
    if (recordKeys.join(',') !== 'bytes,path,sha256') fail('manifest.files 记录字段不符合 v1 定义');
    const { path: recordPath, bytes, sha256 } = record;
    if (typeof recordPath !== 'string') fail('manifest.files.path 必须是字符串');
    if (recordPath <= previousPath) fail('manifest.files 必须按 path 严格升序且不重复');
    previousPath = recordPath;
    if (!Number.isSafeInteger(bytes) || bytes < 1) fail(`manifest.files.bytes 无效: ${recordPath}`);
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      fail(`manifest.files.sha256 无效: ${recordPath}`);
    }
    records.set(recordPath, { bytes, sha256 });
  }
  if ([...records.keys()].sort().join('\n') !== expectedPaths.join('\n')) {
    fail('manifest.files 与归档条目不一致');
  }
  return records;
}

// 归档字节 -> 经过完整校验的导入载荷。抛错即拒绝，绝不部分接受。
function parsePoppetpack(archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes)) fail('归档必须是 Buffer');
  if (archiveBytes.length < 1 || archiveBytes.length > PACK_LIMITS.MAX_ARCHIVE_BYTES) {
    fail('归档大小超出预算');
  }

  const entries = zip.readArchive(archiveBytes, { maxEntries: PACK_LIMITS.MAX_ENTRIES });

  // 解压之前先按名字与声明大小把全部预算检查完。
  let totalUncompressed = 0;
  for (const entry of entries) {
    const budget = ENTRY_BUDGETS.get(entry.name);
    if (budget === undefined) fail(`不允许的条目: ${entry.name}`);
    if (entry.uncompressedSize < 1 || entry.uncompressedSize > budget) {
      fail(`条目大小超出预算: ${entry.name}`);
    }
    if (entry.uncompressedSize > entry.compressedSize * PACK_LIMITS.MAX_EXPANSION_RATIO) {
      fail(`条目膨胀比超出上限: ${entry.name}`);
    }
    totalUncompressed += entry.uncompressedSize;
  }
  if (totalUncompressed > PACK_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES) {
    fail('归档解压总大小超出预算');
  }
  // 合约要求"总体与单条目"膨胀比都不超过 100:1。每个条目都已单独满足
  // ratio ≤ 100，因此总和必然满足（sum(u_i) ≤ 100·sum(c_i)），无需再检查。

  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const manifestEntry = byName.get(MANIFEST_NAME);
  if (!manifestEntry) fail('归档缺少 manifest.json');
  for (const required of REQUIRED_ENTRIES) {
    if (!byName.has(required)) fail(`归档缺少 ${required}`);
  }

  const manifestBytes = zip.extractEntry(
    archiveBytes, manifestEntry, PACK_LIMITS.MAX_MANIFEST_BYTES,
  );
  const manifestRecords = validateManifest(manifestBytes, entries);

  const contents = new Map();
  for (const entry of entries) {
    if (entry.name === MANIFEST_NAME) continue;
    const record = manifestRecords.get(entry.name);
    if (record.bytes !== entry.uncompressedSize) {
      fail(`manifest 声明大小与条目不符: ${entry.name}`);
    }
    const bytes = zip.extractEntry(archiveBytes, entry, ENTRY_BUDGETS.get(entry.name));
    if (sha256Hex(bytes) !== record.sha256) {
      fail(`manifest 哈希校验失败: ${entry.name}`);
    }
    contents.set(entry.name, bytes);
  }

  const meta = parseStrictJson(
    contents.get('character/character.json'), 'character/character.json',
  );
  if (!isPlainRecord(meta)) fail('character.json 必须是对象');

  const files = { 'pet.png': contents.get('character/pet.png') };
  if (contents.has('character/parts.png')) {
    files['parts.png'] = contents.get('character/parts.png');
  }
  files['icon.png'] = contents.get('character/icon.png');

  // parts.png 与 metadata.atlas 的一致性由 validateCharacterPngFiles 复查；
  // 这里提前给出针对包的错误信息。
  const hasAtlas = meta.atlas !== null && meta.atlas !== undefined;
  if (hasAtlas !== ('parts.png' in files)) {
    fail('parts.png 与 metadata.atlas 不一致');
  }

  const name = typeof meta.name === 'string' ? meta.name : undefined;
  return { name, meta, files };
}

// 已验证的库内角色 -> 归档字节。输入来自 loadCharacter（磁盘上已验证的
// meta 与 PNG 字节），这里再剥离本地状态字段并组装确定性归档。
function buildPoppetpack(character) {
  if (!isPlainRecord(character) || !isPlainRecord(character.meta)
      || !isPlainRecord(character.files)) {
    fail('导出输入无效');
  }
  // 双保险：characterExportBundle 已拒绝内置角色，这里再拒一次，
  // 防止未来出现绕过上层直接组包的调用路径把品牌素材静默洗出去。
  if (character.meta.builtin === true) {
    const error = new Error('内置品牌角色不允许导出为角色包');
    error.code = 'POPPET_PACK_BUILTIN_FORBIDDEN';
    throw error;
  }
  const meta = {};
  for (const [key, value] of Object.entries(character.meta)) {
    if (!LOCAL_ONLY_META_KEYS.includes(key)) meta[key] = value;
  }
  const metaBytes = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  if (metaBytes.length > LIMITS.MAX_METADATA_BYTES) fail('character.json 超出大小预算');

  const hasAtlas = meta.atlas !== null && meta.atlas !== undefined;
  const files = [
    ['character/character.json', metaBytes],
    ['character/icon.png', character.files['icon.png']],
    ['character/pet.png', character.files['pet.png']],
  ];
  if (hasAtlas) files.push(['character/parts.png', character.files['parts.png']]);
  files.sort(([a], [b]) => (a < b ? -1 : 1));

  let total = 0;
  for (const [name, bytes] of files) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1) fail(`导出缺少 ${name}`);
    const budget = ENTRY_BUDGETS.get(name);
    if (bytes.length > budget) fail(`导出条目超出预算: ${name}`);
    total += bytes.length;
  }
  if (total > PACK_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES) fail('导出总大小超出预算');

  const manifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    files: files.map(([name, bytes]) => ({
      path: name,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
    })),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (manifestBytes.length > PACK_LIMITS.MAX_MANIFEST_BYTES) fail('manifest.json 超出大小预算');

  return zip.buildArchive([
    { name: MANIFEST_NAME, bytes: manifestBytes },
    ...files.map(([name, bytes]) => ({ name, bytes })),
  ]);
}

module.exports = { PACK_LIMITS, parsePoppetpack, buildPoppetpack };

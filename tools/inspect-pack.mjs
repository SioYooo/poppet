// .poppetpack 离线诊断器（合约见 docs/poppetpack-format.md）。
//
//   node tools/inspect-pack.mjs [--json] <file.poppetpack>
//
// 只读：不写任何文件、不解包到磁盘、不访问网络。判定链与 src/main/index.js 的
// importPackFromPath 逐段一致，并且直接复用同一批模块，而不是复制它们的逻辑：
//   readRegularFileLimitedSync（O_NOFOLLOW、分配前按 MAX_ARCHIVE_BYTES 限额）
//     -> parsePoppetpack（ZIP 结构、预算、manifest、CRC / SHA-256）
//     -> validateImportPayload（Core 的 metadata / PNG 校验）
// 结论（ok / errorCode）只来自这条链。条目清单、逐条目哈希与预算用量是附加的
// 诊断层：它只调用 zip.readArchive / zip.extractEntry，解压上限只用导出的常量，
// 并对每个条目独立报告解压 / CRC 结果，所以在 parsePoppetpack 于第一个错误处
// 停下之后，维护者仍能看到整包的全貌。
// 退出码：0 接受，1 拒绝（含读取失败），2 用法错误。

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PACK_LIMITS, parsePoppetpack } = require('../src/main/pack.js');
const zip = require('../src/main/zip.js');
const { readRegularFileLimitedSync, validateImportPayload } = require('../src/main/security.js');

const MANIFEST_NAME = 'manifest.json';
// 与 importPackFromPath 使用同一个标签，读取阶段的错误文案逐字一致。
const READ_LABEL = '角色包';
const USAGE = `usage: node tools/inspect-pack.mjs [--json] <file.poppetpack>

Read-only offline diagnosis of one .poppetpack archive. Runs the same
read-limit -> parsePoppetpack -> validateImportPayload chain as the app,
then prints manifest fields, per-entry sizes and SHA-256 digests, and
budget usage versus PACK_LIMITS. Never writes files, never extracts to
disk, never touches the network.

  --json      print one machine-readable JSON object instead of text
  -h, --help  show this message

exit status: 0 accepted, 1 rejected or unreadable, 2 usage error`;

// 与 src/main/index.js 的 stablePoppetCode 同义。那个模块依赖 Electron，
// 普通 Node 下无法引用，所以这条两行规则在此保留一份。
function stablePoppetCode(error, fallback) {
  return typeof error?.code === 'string' && /^POPPET_[A-Z0-9_]+$/.test(error.code)
    ? error.code : fallback;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function budget(used, limit) {
  const within = used === null || limit === null ? null : used <= limit;
  return { used, limit, within };
}

// 声明膨胀比，仅供展示；判定用的是与 parsePoppetpack 同形的整数比较。
function ratioOf(entry) {
  if (entry.compressedSize > 0) {
    return Math.round((entry.uncompressedSize / entry.compressedSize) * 100) / 100;
  }
  return entry.uncompressedSize > 0 ? null : 0;
}

function exceedsRatio(entry) {
  return entry.uncompressedSize > entry.compressedSize * PACK_LIMITS.MAX_EXPANSION_RATIO;
}

function methodName(method) {
  if (method === zip.METHOD_STORE) return 'store';
  if (method === zip.METHOD_DEFLATE) return 'deflate';
  return `method-${method}`;
}

// 诊断层的解压前置条件：只用导出的常量，且与 parsePoppetpack 的预算同向，
// 因此本工具为一份声明尺寸分配的内存不会超过应用自身会分配的量。
function hashSkipReason(entry, runningTotal) {
  if (entry.uncompressedSize < 1) return 'declared uncompressed size is 0';
  if (exceedsRatio(entry)) return 'declared expansion ratio exceeds MAX_EXPANSION_RATIO';
  if (runningTotal > PACK_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES) {
    return 'running uncompressed total exceeds MAX_TOTAL_UNCOMPRESSED_BYTES';
  }
  if (entry.name === MANIFEST_NAME && entry.uncompressedSize > PACK_LIMITS.MAX_MANIFEST_BYTES) {
    return 'declared size exceeds MAX_MANIFEST_BYTES';
  }
  return null;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 宽松地读出 manifest 以供展示；严格校验仍然只由 parsePoppetpack 负责。
function describeManifest(manifestBytes, rows) {
  let parsed;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    return { manifest: null, manifestError: `manifest.json is not parseable JSON: ${error.message}` };
  }
  if (!isRecord(parsed)) return { manifest: null, manifestError: 'manifest.json is not a JSON object' };

  const files = Array.isArray(parsed.files) ? parsed.files : [];
  const manifest = {
    format: parsed.format ?? null,
    version: parsed.version ?? null,
    keys: Object.keys(parsed),
    files: files.map(record => (isRecord(record)
      ? { path: record.path ?? null, bytes: record.bytes ?? null, sha256: record.sha256 ?? null }
      : { path: null, bytes: null, sha256: null })),
    missingEntries: [],
  };
  const declared = new Map();
  for (const record of manifest.files) {
    if (typeof record.path === 'string') declared.set(record.path, record);
  }
  const present = new Set(rows.map(row => row.name));
  for (const record of manifest.files) {
    if (typeof record.path === 'string' && !present.has(record.path)) {
      manifest.missingEntries.push(record.path);
    }
  }
  for (const row of rows) {
    if (row.name === MANIFEST_NAME) continue;
    const record = declared.get(row.name);
    if (!record) {
      row.manifest = {
        declared: false, declaredBytes: null, declaredSha256: null, bytesMatch: null, sha256Match: null,
      };
      continue;
    }
    row.manifest = {
      declared: true,
      declaredBytes: record.bytes,
      declaredSha256: record.sha256,
      bytesMatch: record.bytes === row.uncompressedBytes,
      sha256Match: row.sha256 === null ? null : record.sha256 === row.sha256,
    };
  }
  return { manifest, manifestError: null };
}

function describeArchive(bytes) {
  const entries = zip.readArchive(bytes, { maxEntries: PACK_LIMITS.MAX_ENTRIES });
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let maxEntryRatio = 0;
  let everyRatioWithin = true;
  let manifestBytes = null;
  let manifestDeclared = null;
  const rows = [];
  for (const entry of entries) {
    totalCompressed += entry.compressedSize;
    totalUncompressed += entry.uncompressedSize;
    const ratio = ratioOf(entry);
    if (ratio !== null) maxEntryRatio = Math.max(maxEntryRatio, ratio);
    if (exceedsRatio(entry)) everyRatioWithin = false;
    if (entry.name === MANIFEST_NAME) manifestDeclared = entry.uncompressedSize;
    const row = {
      name: entry.name,
      method: methodName(entry.method),
      compressedBytes: entry.compressedSize,
      uncompressedBytes: entry.uncompressedSize,
      expansionRatio: ratio,
      crc32: entry.crc.toString(16).padStart(8, '0'),
      sha256: null,
      hashSkipped: hashSkipReason(entry, totalUncompressed),
      manifest: null,
    };
    if (row.hashSkipped === null) {
      try {
        const data = zip.extractEntry(bytes, entry, entry.uncompressedSize);
        row.sha256 = sha256Hex(data);
        if (entry.name === MANIFEST_NAME) manifestBytes = data;
      } catch (error) {
        row.hashSkipped = error.message;
      }
    }
    rows.push(row);
  }

  const totalRatio = totalCompressed > 0
    ? Math.round((totalUncompressed / totalCompressed) * 100) / 100
    : (totalUncompressed > 0 ? null : 0);
  // 两个膨胀比的 within 都用与 parsePoppetpack 同形的整数比较，不受四舍五入影响。
  const usage = {
    entries: budget(entries.length, PACK_LIMITS.MAX_ENTRIES),
    totalCompressedBytes: budget(totalCompressed, null),
    totalUncompressedBytes: budget(totalUncompressed, PACK_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES),
    manifestBytes: budget(manifestDeclared, PACK_LIMITS.MAX_MANIFEST_BYTES),
    expansionRatio: {
      used: totalRatio,
      limit: PACK_LIMITS.MAX_EXPANSION_RATIO,
      within: totalUncompressed <= totalCompressed * PACK_LIMITS.MAX_EXPANSION_RATIO,
    },
    maxEntryExpansionRatio: {
      used: maxEntryRatio, limit: PACK_LIMITS.MAX_EXPANSION_RATIO, within: everyRatioWithin,
    },
  };

  const described = manifestBytes
    ? describeManifest(manifestBytes, rows)
    : { manifest: null, manifestError: 'manifest.json is missing or could not be extracted' };
  return { usage, entries: rows, ...described };
}

function inspect(file) {
  const report = {
    ok: false,
    file,
    stage: 'read',
    errorCode: null,
    error: null,
    cause: null,
    limits: { ...PACK_LIMITS },
    usage: null,
    manifest: null,
    manifestError: null,
    entries: null,
    listingError: null,
    character: null,
  };
  // 与 importPackFromPath 相同的回退码；非 POPPET_* 的原始 code（如 ENOENT）
  // 放进 cause，便于维护者区分"包坏了"与"路径给错了"。
  const reject = (error) => {
    report.ok = false;
    report.errorCode = stablePoppetCode(error, 'POPPET_PACK_INVALID');
    report.error = error?.message ?? String(error);
    report.cause = typeof error?.code === 'string' && error.code !== report.errorCode
      ? error.code : null;
    return report;
  };

  let bytes;
  try {
    bytes = readRegularFileLimitedSync(file, PACK_LIMITS.MAX_ARCHIVE_BYTES, READ_LABEL);
  } catch (error) {
    return reject(error);
  }
  report.usage = {
    archiveBytes: budget(bytes.length, PACK_LIMITS.MAX_ARCHIVE_BYTES),
    entries: budget(null, PACK_LIMITS.MAX_ENTRIES),
    totalCompressedBytes: budget(null, null),
    totalUncompressedBytes: budget(null, PACK_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES),
    manifestBytes: budget(null, PACK_LIMITS.MAX_MANIFEST_BYTES),
    expansionRatio: budget(null, PACK_LIMITS.MAX_EXPANSION_RATIO),
    maxEntryExpansionRatio: budget(null, PACK_LIMITS.MAX_EXPANSION_RATIO),
  };

  // 诊断层失败不影响结论；结论仍由下面的真实导入链给出。
  try {
    const described = describeArchive(bytes);
    Object.assign(report.usage, described.usage);
    report.entries = described.entries;
    report.manifest = described.manifest;
    report.manifestError = described.manifestError;
  } catch (error) {
    report.listingError = error.message;
  }

  report.stage = 'parse';
  let parsed;
  try {
    parsed = parsePoppetpack(bytes);
  } catch (error) {
    return reject(error);
  }

  report.stage = 'payload';
  let payload;
  try {
    const candidate = { meta: parsed.meta, files: parsed.files };
    if (parsed.name !== undefined) candidate.name = parsed.name;
    payload = validateImportPayload(candidate);
  } catch (error) {
    return reject(error);
  }

  report.stage = 'accepted';
  report.ok = true;
  report.character = {
    name: payload.name,
    schemaVersion: payload.meta.schemaVersion ?? null,
    hasAtlas: payload.meta.atlas !== null && payload.meta.atlas !== undefined,
    sprite: payload.meta.sprite ?? null,
    frames: payload.meta.frames ?? null,
    files: Object.keys(payload.files).sort(),
  };
  return report;
}

// 文本模式下所有来自包内的字符串都先转义控制字符，避免终端注入。
function printable(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function budgetLine(label, entry) {
  const used = entry.used === null ? '?' : String(entry.used);
  const limit = entry.limit === null ? '-' : String(entry.limit);
  const state = entry.within === null ? '' : (entry.within ? 'ok' : 'OVER');
  return `  ${label.padEnd(26)} ${used.padStart(10)} / ${limit.padEnd(10)} ${state}`.trimEnd();
}

function manifestState(row) {
  if (row.name === MANIFEST_NAME) return '-';
  if (!row.manifest) return 'manifest=unknown';
  if (!row.manifest.declared) return 'manifest=UNDECLARED';
  if (row.manifest.bytesMatch === false) return 'manifest=MISMATCH(bytes)';
  if (row.manifest.sha256Match === false) return 'manifest=MISMATCH(sha256)';
  if (row.manifest.sha256Match === null) return 'manifest=unverified';
  return 'manifest=match';
}

function formatText(report) {
  const lines = [`poppetpack inspection: ${printable(report.file)}`];
  if (report.ok) {
    lines.push('verdict: ACCEPTED');
  } else {
    lines.push(`verdict: REJECTED at stage ${report.stage}`);
    lines.push(`error: ${report.errorCode} ${printable(report.error)}`);
    if (report.cause) lines.push(`cause: ${printable(report.cause)}`);
  }
  if (report.usage) {
    lines.push('budgets (used / limit):');
    lines.push(budgetLine('archiveBytes', report.usage.archiveBytes));
    lines.push(budgetLine('entries', report.usage.entries));
    lines.push(budgetLine('totalUncompressedBytes', report.usage.totalUncompressedBytes));
    lines.push(budgetLine('totalCompressedBytes', report.usage.totalCompressedBytes));
    lines.push(budgetLine('manifestBytes', report.usage.manifestBytes));
    lines.push(budgetLine('expansionRatio', report.usage.expansionRatio));
    lines.push(budgetLine('maxEntryExpansionRatio', report.usage.maxEntryExpansionRatio));
  }
  if (report.listingError) lines.push(`listing: unavailable (${printable(report.listingError)})`);
  if (report.manifest) {
    const { format, version, files, keys, missingEntries } = report.manifest;
    lines.push(`manifest: format=${printable(format)} version=${printable(version)} files=${files.length} keys=${printable(keys.join(','))}`);
    if (missingEntries.length) lines.push(`  declared but absent: ${printable(missingEntries.join(', '))}`);
  } else if (report.manifestError) {
    lines.push(`manifest: ${printable(report.manifestError)}`);
  }
  if (report.entries) {
    lines.push('entries:');
    for (const row of report.entries) {
      const digest = row.sha256 ?? `skipped (${printable(row.hashSkipped)})`;
      lines.push(`  ${printable(row.name)}`);
      lines.push(`    ${row.method} compressed=${row.compressedBytes} uncompressed=${row.uncompressedBytes}`
        + ` ratio=${row.expansionRatio ?? 'inf'} crc32=${row.crc32}`);
      lines.push(`    sha256=${digest} ${manifestState(row)}`);
    }
  }
  if (report.character) {
    const { name, schemaVersion, hasAtlas, files } = report.character;
    lines.push(`character: name=${printable(name)} schemaVersion=${printable(schemaVersion)}`
      + ` atlas=${hasAtlas} files=${printable(files.join(','))}`);
  }
  return lines;
}

function parseArgs(argv) {
  let json = false;
  let help = false;
  const positional = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  if (help) return { help: true };
  if (positional.length === 0) return { error: 'missing <file.poppetpack>' };
  if (positional.length > 1) return { error: 'expected exactly one <file.poppetpack>' };
  return { json, file: positional[0] };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}\n`);
    return 2;
  }
  const report = inspect(args.file);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatText(report).join('\n')}\n`);
  return report.ok ? 0 : 1;
}

// 设置 exitCode 并自然退出，而不是强制终止进程：stdout 接管道时强制终止
// 可能截断尚未刷出的 JSON。
process.exitCode = main(process.argv.slice(2));

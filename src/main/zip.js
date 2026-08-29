'use strict';
// 有界、fail-closed 的 ZIP 读写层，只服务 .poppetpack（docs/poppetpack-format.md）。
// 刻意不支持：zip64、加密、data descriptor、extra 字段、注释、目录条目、
// 多分卷、非 Store/Deflate 方法，以及条目之间的任何空隙或前置/尾随字节。
// 归档是不可信输入；任何解析歧义都直接失败，而不是宽容恢复。

const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_BYTES = 22;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
// general purpose bit 11 是 UTF-8 文件名声明；其余任何 flag（加密 bit0、
// data descriptor bit3 等）都拒绝。
const ALLOWED_FLAGS = 0x0800;
const MAX_NAME_BYTES = 512;
const MAX_VERSION_NEEDED = 20;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
// 固定的导出时间戳：1980-01-01 00:00:00（DOS 纪元），保证字节级可复现。
const DOS_EPOCH_TIME = 0x0000;
const DOS_EPOCH_DATE = 0x0021;

function fail(message) {
  const error = new Error(message);
  error.code = 'POPPET_PACK_INVALID';
  throw error;
}

function crc32(bytes) {
  return zlib.crc32(bytes) >>> 0;
}

function validateEntryName(raw) {
  if (raw.length < 1 || raw.length > MAX_NAME_BYTES) fail('条目名长度无效');
  const name = raw.toString('utf8');
  if (Buffer.byteLength(name, 'utf8') !== raw.length || name.includes('�')) {
    fail('条目名不是有效 UTF-8');
  }
  if (name !== name.normalize('NFC')) fail(`条目名未按 NFC 归一化: ${name}`);
  if (name.endsWith('/')) fail(`不允许目录条目: ${name}`);
  if (name.includes('\\')) fail(`条目名不允许反斜杠: ${name}`);
  if (name.startsWith('/')) fail(`条目名不允许绝对路径: ${name}`);
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      fail(`条目名包含非法路径段: ${name}`);
    }
  }
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) fail('条目名包含控制字符');
  }
  return name;
}

// 解析并完整校验归档结构，返回条目描述（不解压数据）。
function readArchive(bytes, { maxEntries }) {
  if (!Buffer.isBuffer(bytes)) fail('归档必须是 Buffer');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) fail('maxEntries 无效');
  if (bytes.length < EOCD_BYTES + LOCAL_HEADER_BYTES) fail('归档过小');

  // 注释被禁止，所以 EOCD 必须恰好是文件的最后 22 字节；这同时排除了
  // 任何尾随垃圾数据。
  const eocdOffset = bytes.length - EOCD_BYTES;
  if (bytes.readUInt32LE(eocdOffset) !== SIG_EOCD) {
    fail('归档结尾不是无注释的 EOCD 记录');
  }
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralStartDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entriesTotal = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  if (diskNumber !== 0 || centralStartDisk !== 0) fail('不支持多分卷归档');
  if (commentLength !== 0) fail('不允许归档注释');
  if (entriesTotal === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    fail('不支持 zip64 归档');
  }
  if (entriesOnDisk !== entriesTotal) fail('EOCD 条目数不一致');
  if (entriesTotal < 1) fail('归档为空');
  if (entriesTotal > maxEntries) fail(`条目数超过上限 ${maxEntries}`);
  if (centralOffset + centralSize !== eocdOffset) {
    fail('central directory 与 EOCD 不衔接');
  }

  const entries = [];
  const seenNames = new Set();
  let cursor = centralOffset;
  for (let i = 0; i < entriesTotal; i += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > eocdOffset) fail('central directory 被截断');
    if (bytes.readUInt32LE(cursor) !== SIG_CENTRAL) fail('central directory 签名无效');
    const versionNeeded = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);

    if (versionNeeded > MAX_VERSION_NEEDED) fail('条目要求的 ZIP 版本过高');
    if ((flags & ~ALLOWED_FLAGS) !== 0) fail('不允许的条目 flags（加密/data descriptor 等）');
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) fail('只允许 Store 或 Deflate');
    if (extraLength !== 0) fail('不允许 extra 字段');
    if (commentLen !== 0) fail('不允许条目注释');
    if (startDisk !== 0) fail('不支持多分卷条目');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff) fail('不支持 zip64 条目');
    if (((externalAttributes >>> 16) & S_IFMT) === S_IFLNK) fail('不允许符号链接条目');
    if (method === METHOD_STORE && compressedSize !== uncompressedSize) {
      fail('Store 条目的压缩前后大小必须一致');
    }
    if (cursor + CENTRAL_HEADER_BYTES + nameLength > eocdOffset) {
      fail('central directory 被截断');
    }
    const name = validateEntryName(
      bytes.subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength),
    );
    if (seenNames.has(name)) fail(`重复条目: ${name}`);
    seenNames.add(name);

    entries.push({
      name, versionNeeded, flags, method, crc,
      compressedSize, uncompressedSize, localOffset,
    });
    cursor += CENTRAL_HEADER_BYTES + nameLength;
  }
  if (cursor !== eocdOffset) fail('central directory 存在多余字节');

  // 本地段必须从 0 开始、彼此紧邻、恰好在 central directory 处结束。
  // 这让归档里的每一个字节都有归属，杜绝前置数据和条目间隙里的走私内容。
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  let expectedOffset = 0;
  for (const entry of byOffset) {
    if (entry.localOffset !== expectedOffset) fail('条目之间存在未声明的字节');
    const headerEnd = entry.localOffset + LOCAL_HEADER_BYTES;
    if (headerEnd > centralOffset) fail('本地条目越过 central directory');
    if (bytes.readUInt32LE(entry.localOffset) !== SIG_LOCAL) fail('本地条目签名无效');
    const localVersion = bytes.readUInt16LE(entry.localOffset + 4);
    const localFlags = bytes.readUInt16LE(entry.localOffset + 6);
    const localMethod = bytes.readUInt16LE(entry.localOffset + 8);
    const localCrc = bytes.readUInt32LE(entry.localOffset + 14);
    const localCompressed = bytes.readUInt32LE(entry.localOffset + 18);
    const localUncompressed = bytes.readUInt32LE(entry.localOffset + 22);
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    // 经典 smuggling 手法是让 local header 与 central directory 各说各话，
    // 不同解压器读到不同内容；这里要求逐字段一致。
    if (localVersion !== entry.versionNeeded || localFlags !== entry.flags
        || localMethod !== entry.method || localCrc !== entry.crc
        || localCompressed !== entry.compressedSize
        || localUncompressed !== entry.uncompressedSize
        || localNameLength !== Buffer.byteLength(entry.name, 'utf8')
        || localExtraLength !== 0) {
      fail(`本地条目与 central directory 不一致: ${entry.name}`);
    }
    const nameEnd = headerEnd + localNameLength;
    if (nameEnd > centralOffset) fail('本地条目越过 central directory');
    if (bytes.toString('utf8', headerEnd, nameEnd) !== entry.name) {
      fail(`本地条目名与 central directory 不一致: ${entry.name}`);
    }
    entry.dataOffset = nameEnd;
    const dataEnd = nameEnd + entry.compressedSize;
    if (dataEnd > centralOffset) fail('条目数据越过 central directory');
    expectedOffset = dataEnd;
  }
  if (expectedOffset !== centralOffset) fail('条目数据与 central directory 之间存在未声明的字节');

  return entries;
}

// 解压单个条目。maxOutputBytes 让预算在解压中途生效，而不是解压完再量。
function extractEntry(bytes, entry, maxOutputBytes) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) fail('解压预算无效');
  if (entry.uncompressedSize > maxOutputBytes) {
    fail(`条目超出大小预算: ${entry.name}`);
  }
  const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let out;
  if (entry.method === METHOD_STORE) {
    out = Buffer.from(data);
  } else {
    try {
      out = zlib.inflateRawSync(data, { maxOutputLength: maxOutputBytes });
    } catch (error) {
      fail(`条目解压失败: ${entry.name}（${error.message}）`);
    }
  }
  if (out.length !== entry.uncompressedSize) {
    fail(`条目解压后大小与声明不符: ${entry.name}`);
  }
  if (crc32(out) !== entry.crc) fail(`条目 CRC 校验失败: ${entry.name}`);
  return out;
}

// 全 Store、固定时间戳、无 extra/注释的确定性写入：同样的输入永远产生
// 同样的字节。PNG 本身已压缩，Store 没有体积损失。
function buildArchive(files) {
  if (!Array.isArray(files) || files.length < 1) fail('归档必须至少包含一个文件');
  const localParts = [];
  const centralParts = [];
  const seen = new Set();
  let offset = 0;
  for (const file of files) {
    const name = validateEntryName(Buffer.from(file.name, 'utf8'));
    if (seen.has(name)) fail(`重复条目: ${name}`);
    seen.add(name);
    if (!Buffer.isBuffer(file.bytes)) fail(`条目内容必须是 Buffer: ${name}`);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(file.bytes);

    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(MAX_VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(DOS_EPOCH_TIME, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(MAX_VERSION_NEEDED, 4);
    central.writeUInt16LE(MAX_VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(METHOD_STORE, 10);
    central.writeUInt16LE(DOS_EPOCH_TIME, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, file.bytes);
    centralParts.push(central, nameBytes);
    offset += LOCAL_HEADER_BYTES + nameBytes.length + file.bytes.length;
  }

  const centralBytes = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(EOCD_BYTES);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBytes, eocd]);
}

module.exports = {
  readArchive, extractEntry, buildArchive, crc32,
  METHOD_STORE, METHOD_DEFLATE,
};

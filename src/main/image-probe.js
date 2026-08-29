'use strict';
// 只读图片头，不进入解码器就先拿到真实格式与尺寸，用来挡住压缩炸弹式输入。

function invalid(message = '不支持或已损坏的图片') {
  const error = new Error(message);
  error.code = 'POPPET_INVALID_IMAGE';
  throw error;
}

function u16be(bytes, offset) {
  return bytes[offset] * 256 + bytes[offset + 1];
}

function u16le(bytes, offset) {
  return bytes[offset] + bytes[offset + 1] * 256;
}

function u24le(bytes, offset) {
  return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
}

function u32be(bytes, offset) {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function i32le(bytes, offset) {
  const value = bytes[offset] + bytes[offset + 1] * 0x100
    + bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000;
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);
let CRC_TABLE = null;

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  invalid('图片数据无效');
}

function hasBytesAt(bytes, expected, offset = 0) {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (bytes[offset + i] !== expected[i]) return false;
  return true;
}

function crc32(bytes, start, end) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPngChunkCrc(bytes, typeOffset, dataEnd) {
  const expected = u32be(bytes, dataEnd);
  const actual = crc32(bytes, typeOffset, dataEnd);
  if (actual !== expected) invalid('PNG 数据校验失败');
}

// requireComplete=false 只验证完整 IHDR，供读取大文件头时使用；导入生成物必须走
// requireComplete=true，逐块验证边界和 CRC，并确认至少有 IDAT 与最终 IEND。
function probePngDimensions(input, { requireComplete = false } = {}) {
  const bytes = asBytes(input);
  if (bytes.length < 33 || !hasBytesAt(bytes, PNG_SIGNATURE)) invalid('PNG 图片头无效或已截断');
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') invalid('PNG 缺少有效 IHDR');
  assertPngChunkCrc(bytes, 12, 29);

  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (!width || !height) invalid('PNG 尺寸无效');
  if (!PNG_DEPTHS.get(colorType)?.has(bitDepth)) invalid('PNG 色彩格式无效');
  if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) invalid('PNG 编码参数无效');

  if (requireComplete) {
    let offset = 8;
    let chunks = 0;
    let sawHeader = false;
    let sawData = false;
    let sawEnd = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) invalid('PNG 数据块已截断');
      const length = u32be(bytes, offset);
      const typeOffset = offset + 4;
      const type = ascii(bytes, typeOffset, 4);
      if (!/^[A-Za-z]{4}$/.test(type)) invalid('PNG 数据块类型无效');
      if (length > bytes.length - offset - 12) invalid('PNG 数据块已截断');
      const dataEnd = offset + 8 + length;
      assertPngChunkCrc(bytes, typeOffset, dataEnd);
      chunks += 1;
      if (chunks > 100_000) invalid('PNG 数据块过多');

      if (type === 'IHDR') {
        if (sawHeader || offset !== 8 || length !== 13) invalid('PNG IHDR 顺序无效');
        sawHeader = true;
      } else if (type === 'IDAT') {
        if (!sawHeader || sawEnd) invalid('PNG IDAT 顺序无效');
        sawData = true;
      } else if (type === 'IEND') {
        if (length !== 0 || !sawHeader || !sawData) invalid('PNG IEND 无效');
        sawEnd = true;
        offset += 12;
        if (offset !== bytes.length) invalid('PNG IEND 后存在额外数据');
        break;
      }
      offset += 12 + length;
    }
    if (!sawEnd) invalid('PNG 缺少 IEND 或数据已截断');
  }

  return { width, height, mime: 'image/png' };
}

function probeJpeg(bytes) {
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 <= bytes.length) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker)) {
      if (length < 7) invalid('JPEG 尺寸头无效');
      return { width: u16be(bytes, offset + 5), height: u16be(bytes, offset + 3), mime: 'image/jpeg' };
    }
    offset += length;
  }
  invalid('无法在受限图片头内读取 JPEG 尺寸');
}

function probeWebp(bytes) {
  if (bytes.length < 30) invalid('WebP 图片头过短');
  const kind = ascii(bytes, 12, 4);
  if (kind === 'VP8X') {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, mime: 'image/webp' };
  }
  if (kind === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) invalid('WebP VP8 图片头无效');
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff, mime: 'image/webp' };
  }
  if (kind === 'VP8L') {
    if (bytes[20] !== 0x2f) invalid('WebP VP8L 图片头无效');
    const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
      mime: 'image/webp',
    };
  }
  invalid('不支持的 WebP 编码');
}

const GIF_MAX_BLOCKS = 100_000;

function skipGifSubBlocks(bytes, offset, state, label, { requireData = false } = {}) {
  let sawData = false;
  while (true) {
    if (offset >= bytes.length) invalid(`${label} 已截断`);
    const size = bytes[offset++];
    state.blocks += 1;
    if (state.blocks > GIF_MAX_BLOCKS) invalid('GIF 数据块过多');
    if (size === 0) {
      if (requireData && !sawData) invalid(`${label} 为空`);
      return offset;
    }
    if (size > bytes.length - offset) invalid(`${label} 已截断`);
    sawData = true;
    offset += size;
  }
}

function skipGifExtension(bytes, offset, state) {
  if (offset >= bytes.length) invalid('GIF 扩展块已截断');
  const label = bytes[offset++];

  // 图形控制扩展是唯一没有后续数据子块的标准扩展：固定 4 字节后必须
  // 立即终止。应用与纯文本扩展先有固定头，再接普通子块链。
  if (label === 0xf9) {
    if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) {
      invalid('GIF 图形控制扩展无效或已截断');
    }
    state.blocks += 1;
    if (state.blocks > GIF_MAX_BLOCKS) invalid('GIF 数据块过多');
    return offset + 6;
  }

  if (label === 0xff || label === 0x01) {
    const expectedHeaderSize = label === 0xff ? 11 : 12;
    if (offset >= bytes.length || bytes[offset] !== expectedHeaderSize) {
      invalid('GIF 扩展头无效或已截断');
    }
  }
  return skipGifSubBlocks(bytes, offset, state, 'GIF 扩展块');
}

function probeGif(bytes) {
  const version = ascii(bytes, 0, 6);
  if (bytes.length < 14 || (version !== 'GIF87a' && version !== 'GIF89a')) {
    invalid('GIF 图片头无效或已截断');
  }

  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  if (!width || !height) invalid('GIF 尺寸无效');

  const logicalPacked = bytes[10];
  const hasGlobalColorTable = Boolean(logicalPacked & 0x80);
  let offset = 13;
  if (hasGlobalColorTable) {
    const tableBytes = 3 * (1 << ((logicalPacked & 0x07) + 1));
    if (tableBytes > bytes.length - offset) invalid('GIF 全局色表已截断');
    offset += tableBytes;
  }

  let frameCount = 0;
  const state = { blocks: 0 };
  while (offset < bytes.length) {
    const introducer = bytes[offset++];
    state.blocks += 1;
    if (state.blocks > GIF_MAX_BLOCKS) invalid('GIF 数据块过多');

    if (introducer === 0x3b) {
      if (frameCount === 0) invalid('GIF 不含图像帧');
      if (offset !== bytes.length) invalid('GIF 结束标记后存在额外数据');
      return { width, height, mime: 'image/gif', frameCount };
    }

    if (introducer === 0x21) {
      offset = skipGifExtension(bytes, offset, state);
      continue;
    }

    if (introducer !== 0x2c) invalid('GIF 数据块类型无效');
    if (offset + 9 > bytes.length) invalid('GIF 图像描述符已截断');

    const left = u16le(bytes, offset);
    const top = u16le(bytes, offset + 2);
    const frameWidth = u16le(bytes, offset + 4);
    const frameHeight = u16le(bytes, offset + 6);
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (!frameWidth || !frameHeight ||
        left + frameWidth > width || top + frameHeight > height) {
      invalid('GIF 图像帧尺寸或位置无效');
    }

    const hasLocalColorTable = Boolean(imagePacked & 0x80);
    if (!hasGlobalColorTable && !hasLocalColorTable) invalid('GIF 图像帧缺少色表');
    if (hasLocalColorTable) {
      const tableBytes = 3 * (1 << ((imagePacked & 0x07) + 1));
      if (tableBytes > bytes.length - offset) invalid('GIF 局部色表已截断');
      offset += tableBytes;
    }

    if (offset >= bytes.length) invalid('GIF 图像数据已截断');
    const minimumCodeSize = bytes[offset++];
    if (minimumCodeSize < 2 || minimumCodeSize > 8) invalid('GIF LZW 编码参数无效');
    offset = skipGifSubBlocks(bytes, offset, state, 'GIF 图像数据', { requireData: true });
    frameCount += 1;
  }

  invalid('GIF 缺少结束标记或数据已截断');
}

function probeImageDimensions(input) {
  const bytes = asBytes(input);
  if (bytes.length < 10) invalid('图片头过短');

  if (hasBytesAt(bytes, PNG_SIGNATURE)) return probePngDimensions(bytes);
  if (ascii(bytes, 0, 3) === 'GIF') return probeGif(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpeg(bytes);
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return probeWebp(bytes);
  }
  if (bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM') {
    return { width: Math.abs(i32le(bytes, 18)), height: Math.abs(i32le(bytes, 22)), mime: 'image/bmp' };
  }
  invalid();
}

module.exports = { probeImageDimensions, probePngDimensions };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeImageDimensions, probePngDimensions } = require('../../src/main/image-probe');
const { assertImageBudget, LIMITS } = require('../../src/main/security');
const { makePng } = require('./png-fixture.cjs');

function makeGif(width, height, frameCount, { extensions = false } = {}) {
  const header = Buffer.alloc(13);
  header.write('GIF89a');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80; // 两色全局色表
  const chunks = [header, Buffer.alloc(6)];

  if (extensions) {
    chunks.push(Buffer.from([0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0]));
    chunks.push(Buffer.concat([
      Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0', 'ascii'),
      Buffer.from([3, 1, 0, 0, 0]),
    ]));
    chunks.push(Buffer.concat([
      Buffer.from([0x21, 0x01, 12]), Buffer.alloc(12), Buffer.from([1, 0x41, 0]),
    ]));
  }

  for (let index = 0; index < frameCount; index++) {
    if (extensions) chunks.push(Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]));
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    if (index === 0) descriptor[9] = 0x80; // 两色局部色表也必须被跳过
    chunks.push(descriptor);
    if (index === 0) chunks.push(Buffer.alloc(6));
    chunks.push(Buffer.from([2, 1, 0, 0])); // LZW 最小码长、一个数据子块、终止块
  }
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

test('probes supported image headers without decoding pixels', () => {
  const png = makePng(320, 240);
  assert.deepEqual(probeImageDimensions(png), { width: 320, height: 240, mime: 'image/png' });
  assert.deepEqual(probePngDimensions(png, { requireComplete: true }),
    { width: 320, height: 240, mime: 'image/png' });

  const gif = makeGif(64, 48, 2, { extensions: true });
  assert.deepEqual(probeImageDimensions(gif), {
    width: 64, height: 48, mime: 'image/gif', frameCount: 2,
  });

  const bmp = Buffer.alloc(26);
  Buffer.from('BM').copy(bmp);
  bmp.writeInt32LE(20, 18); bmp.writeInt32LE(-30, 22);
  assert.deepEqual(probeImageDimensions(bmp), { width: 20, height: 30, mime: 'image/bmp' });
});

test('GIF frame counts feed the existing frame and aggregate pixel budgets', () => {
  const tooMany = probeImageDimensions(makeGif(1, 1, LIMITS.MAX_FRAMES + 1));
  assert.equal(tooMany.frameCount, LIMITS.MAX_FRAMES + 1);
  assert.throws(
    () => assertImageBudget(tooMany.width, tooMany.height, tooMany.frameCount), /帧数/,
  );

  const tooManyPixels = probeImageDimensions(makeGif(4096, 4096, 2));
  assert.throws(
    () => assertImageBudget(
      tooManyPixels.width, tooManyPixels.height, tooManyPixels.frameCount,
    ),
    /总像素/,
  );
});

test('GIF structural parsing fails closed on malformed or truncated blocks', () => {
  const valid = makeGif(16, 16, 1, { extensions: true });
  assert.throws(() => probeImageDimensions(valid.subarray(0, valid.length - 2)), /截断|结束标记/);
  assert.throws(() => probeImageDimensions(Buffer.concat([valid, Buffer.from([0])])), /额外数据/);

  const header = Buffer.alloc(13);
  header.write('GIF89a');
  header.writeUInt16LE(16, 6);
  header.writeUInt16LE(16, 8);
  const truncatedExtension = Buffer.concat([
    header, Buffer.from([0x21, 0xfe, 4, 0x41]),
  ]);
  assert.throws(() => probeImageDimensions(truncatedExtension), /扩展块.*截断/);

  const malformedControl = Buffer.concat([
    header, Buffer.from([0x21, 0xf9, 3, 0, 0, 0, 0]),
  ]);
  assert.throws(() => probeImageDimensions(malformedControl), /图形控制扩展/);

  const descriptorWithoutPalette = Buffer.alloc(10);
  descriptorWithoutPalette[0] = 0x2c;
  descriptorWithoutPalette.writeUInt16LE(16, 5);
  descriptorWithoutPalette.writeUInt16LE(16, 7);
  assert.throws(() => probeImageDimensions(Buffer.concat([
    header, descriptorWithoutPalette, Buffer.from([2, 1, 0, 0, 0x3b]),
  ])), /缺少色表/);
});

test('rejects unknown, truncated and malformed headers', () => {
  assert.throws(() => probeImageDimensions(Buffer.from('not-image')), /图片/);
  const png = makePng(16, 16);
  assert.throws(() => probePngDimensions(png.subarray(0, png.length - 1), { requireComplete: true }), /截断|IEND/);
  const forged = Buffer.from(png);
  forged.writeUInt32BE(32, 16); // 不重算 IHDR CRC
  assert.throws(() => probePngDimensions(forged, { requireComplete: true }), /校验/);
  const fakeHeader = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fakeHeader);
  assert.throws(() => probeImageDimensions(fakeHeader), /IHDR/);
});

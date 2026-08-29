'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const managerPath = path.resolve(__dirname, '../../src/renderer/manager/manager.js');
const source = fs.readFileSync(managerPath, 'utf8');
const start = source.indexOf('async function decodeFrames(');
const end = source.indexOf('\n}\n\n// 把一张 sprite sheet', start);

test('GIF imports fail closed unless ImageDecoder confirms a single static frame', () => {
  assert.ok(start >= 0 && end > start, 'decodeFrames implementation must remain discoverable');
  const block = source.slice(start, end + 2);
  const catchBlock = block.slice(block.indexOf('} catch (error)'));

  assert.match(block, /if \(mime !== 'image\/gif'\) return null;/);
  assert.match(block,
    /typeof window\.ImageDecoder !== 'function'[\s\S]*POPPET_GIF_DECODE_UNAVAILABLE/);
  assert.match(block, /const count = track\?\.frameCount;/);
  assert.match(block, /if \(count === 1\) return null;/);
  assert.match(block, /decoded\.complete === false/);
  assert.match(catchBlock, /POPPET_GIF_DECODE_FAILED/);
  assert.doesNotMatch(catchBlock, /return null/,
    'decoder failures must not silently fall back to the browser poster frame');
});

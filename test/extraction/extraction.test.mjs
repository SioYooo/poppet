import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  extractSubject,
  validateSubjectExtractionResult,
} from '../../src/shared/extraction/index.js';
import { buildCharacter, removeBackground } from '../../src/shared/pipeline.js';
import { canonicalPortrait } from '../face-detection/fixtures.mjs';
import {
  alphaSubject,
  chromaSubject,
  clone,
  complexBackgroundSubject,
  setPixel,
} from './fixtures.mjs';

const require = createRequire(import.meta.url);
const security = require('../../src/main/security.js');
const { makePng } = require('../security/png-fixture.cjs');

function bytes(image) {
  return Array.from(image.data);
}

function alphaAt(image, x, y) {
  return image.data[(y * image.width + x) * 4 + 3];
}

function maskBytes(result) {
  const value = result.mask?.data ?? result.mask;
  assert.ok(ArrayBuffer.isView(value), 'mask must expose typed binary pixels');
  assert.equal(value.length, result.image.width * result.image.height);
  for (const cell of value) {
    assert.ok(cell === 0 || cell === 1 || cell === 255,
      `mask must be binary, received ${cell}`);
  }
  return value;
}

function assertResultContract(result, source) {
  assert.ok(result && typeof result === 'object');
  assert.notEqual(result.image, source, 'extractSubject must return an owned image');
  assert.notEqual(result.image.data, source.data, 'extractSubject must not alias source pixels');
  assert.equal(result.image.width, source.width);
  assert.equal(result.image.height, source.height);
  assert.ok(['alpha', 'chroma', 'none'].includes(result.mode));
  assert.ok(['ready', 'needs-advanced-extraction'].includes(result.status));
  assert.equal(typeof result.confidence, 'number');
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.diagnostics && typeof result.diagnostics === 'object');
  maskBytes(result);
}

test('default SubjectExtractor is byte-equivalent to the legacy alpha and chroma paths', () => {
  for (const make of [alphaSubject, chromaSubject]) {
    const source = make();
    const original = bytes(source);
    const legacy = clone(source);
    const legacyDecision = removeBackground(legacy);
    const result = extractSubject(source);

    assertResultContract(result, source);
    assert.equal(result.mode, legacyDecision.mode);
    assert.deepEqual(bytes(result.image), bytes(legacy));
    assert.deepEqual(bytes(source), original, 'the new abstraction must not mutate caller input');
  }
});

test('existing alpha is hardened into a binary subject and a matching mask', () => {
  const source = alphaSubject();
  const result = extractSubject(source);
  assertResultContract(result, source);

  assert.equal(result.mode, 'alpha');
  assert.equal(result.status, 'ready');
  assert.equal(alphaAt(result.image, 4, 8), 0, 'alpha below threshold must be removed');
  assert.equal(alphaAt(result.image, 13, 8), 255, 'alpha above threshold must be retained');

  const mask = maskBytes(result);
  for (let p = 0; p < mask.length; p++) {
    assert.equal(Boolean(mask[p]), result.image.data[p * 4 + 3] === 255,
      'mask and output alpha must describe the same subject');
  }
});

test('simple opaque background uses bounded chroma extraction', () => {
  const source = chromaSubject();
  const result = extractSubject(source);
  assertResultContract(result, source);

  assert.equal(result.mode, 'chroma');
  assert.equal(result.status, 'ready');
  assert.equal(alphaAt(result.image, 0, 0), 0);
  assert.equal(alphaAt(result.image, 10, 10), 255);
  assert.ok(result.decision && result.decision.mode === 'chroma',
    'a reusable first-frame decision is required for animations');
});

test('heterogeneous backgrounds explicitly request advanced extraction without destructive guessing', () => {
  const source = complexBackgroundSubject();
  const original = bytes(source);
  const result = extractSubject(source);
  assertResultContract(result, source);

  assert.equal(result.mode, 'none');
  assert.equal(result.status, 'needs-advanced-extraction');
  assert.ok(result.warnings.length > 0, 'the manager needs a user-facing explanation');
  assert.deepEqual(bytes(result.image), original,
    'complex-background fallback must preserve the full image byte-for-byte');
  assert.deepEqual(bytes(source), original, 'fallback must not mutate the draft source');
});

test('subsequent frames reuse the first frame decision instead of reclassifying', () => {
  const first = extractSubject(chromaSubject());
  assert.equal(first.mode, 'chroma');

  const changedCorner = chromaSubject();
  setPixel(changedCorner, changedCorner.width - 1, changedCorner.height - 1, [0, 0, 0, 255]);
  const independently = extractSubject(changedCorner);
  assert.equal(independently.status, 'needs-advanced-extraction');

  const shared = extractSubject(changedCorner, {}, first.decision);
  assert.equal(shared.mode, 'chroma');
  assert.equal(shared.status, 'ready');
  assert.equal(alphaAt(shared.image, 0, 0), 0,
    'the reusable decision should still remove the known background');
  assert.equal(shared.diagnostics.sharedDecision, true);
});

test('SubjectExtractor rejects malformed adapter results before the pipeline consumes them', () => {
  const invalidCases = [
    ['non-finite confidence', result => { result.confidence = Number.NaN; }],
    ['inconsistent status', result => { result.status = 'needs-advanced-extraction'; }],
    ['invalid decision count', result => { result.decision.removed = -1; }],
    ['non-array warnings', result => { result.warnings = 'not-an-array'; }],
    ['invalid diagnostics', result => { result.diagnostics.sharedDecision = 'false'; }],
    ['inconsistent diagnostics', result => { result.diagnostics.reason = 'not-the-decision'; }],
    ['wrong output dimensions', result => { result.image.width -= 1; }],
    ['non-binary output alpha', result => { result.image.data[3] = 128; }],
    ['mask/image mismatch', result => {
      const mask = new Uint8Array(result.mask);
      mask[0] = mask[0] ? 0 : 1;
      result.mask = mask;
    }],
  ];

  for (const [label, mutate] of invalidCases) {
    const source = alphaSubject();
    const result = extractSubject(source);
    mutate(result);
    assert.throws(
      () => validateSubjectExtractionResult(result, result.image, {
        width: source.width,
        height: source.height,
        sharedDecision: false,
      }),
      error => error?.code === 'POPPET_EXTRACTOR_CONTRACT',
      label,
    );
  }
});

test('buildCharacter consumes the extractor image instead of only reporting its decision', () => {
  const chroma = chromaSubject();
  const chromaOriginal = bytes(chroma);
  const chromaResult = buildCharacter(chroma, {
    margin: 0,
    features: { eyes: [], mouth: null },
  });
  assert.equal(chromaResult.meta.source.backgroundMode, 'chroma');
  assert.deepEqual(chromaResult.meta.source.cropBBox, [5, 4, 14, 16]);
  assert.equal(chromaResult.sprite.width, 10);
  assert.equal(chromaResult.sprite.height, 13);
  assert.deepEqual(bytes(chroma), chromaOriginal, 'the build pipeline must not mutate caller input');

  const alpha = alphaSubject();
  const alphaResult = buildCharacter(alpha, {
    margin: 0,
    features: { eyes: [], mouth: null },
  });
  assert.equal(alphaResult.meta.source.backgroundMode, 'alpha');
  assert.deepEqual(alphaResult.meta.source.cropBBox, [5, 3, 13, 14]);
  for (let i = 3; i < alphaResult.sprite.data.length; i += 4) {
    assert.ok(alphaResult.sprite.data[i] === 0 || alphaResult.sprite.data[i] === 255,
      `pipeline alpha must be binary, received ${alphaResult.sprite.data[i]}`);
  }
});

test('pipeline provenance passes the strict new-import boundary', () => {
  const result = buildCharacter(chromaSubject(), {
    margin: 0,
    features: { eyes: [], mouth: null },
    pixelize: { enabled: true, preset: 'tiny', targetHeight: 24, paletteSize: 8 },
  });
  const files = {
    'pet.png': makePng(result.sprite.width, result.sprite.height),
    'icon.png': makePng(result.icon.width, result.icon.height),
  };
  if (result.atlas) files['parts.png'] = makePng(result.atlas.width, result.atlas.height);
  const validated = security.validateImportPayload({ name: 'roundtrip', meta: result.meta, files });
  assert.deepEqual(validated.meta.source, result.meta.source);
});

test('strict new-import metadata accepts real v2 eye and mouth atlas parts', () => {
  const result = buildCharacter(canonicalPortrait().image);
  assert.ok(result.meta.parts.some(part => part.role === 'eye'));
  assert.ok(result.meta.parts.some(part => part.role === 'mouth'));
  const files = {
    'pet.png': makePng(result.sprite.width, result.sprite.height),
    'icon.png': makePng(result.icon.width, result.icon.height),
    'parts.png': makePng(result.atlas.width, result.atlas.height),
  };
  assert.doesNotThrow(() => security.validateImportPayload({
    name: 'face-roundtrip', meta: result.meta, files,
  }));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STUDIO_CONTRACT_VERSION,
  STUDIO_ERROR_CODES,
  validateCreatePoppetRequest,
  validateJobId,
  validateStudioJob,
} = require('../../src/main/studio/contracts');
const { createStudioClient, DISABLED_CAPABILITIES } = require('../../src/main/studio/client');

test('createPoppet runtime contract is strict, bounded and copies caller bytes', () => {
  const input = new Uint8Array([1, 2, 3]);
  const value = validateCreatePoppetRequest({
    schemaVersion: STUDIO_CONTRACT_VERSION,
    requestId: 'request-1',
    source: { mediaType: 'image/png', bytes: input },
    operations: ['subject-extraction', 'rigging'],
  });
  assert.deepEqual([...value.source.bytes], [1, 2, 3]);
  input[0] = 9;
  assert.equal(value.source.bytes[0], 1);
  assert.throws(() => validateCreatePoppetRequest({
    schemaVersion: 2,
    requestId: 'request-1',
    source: { mediaType: 'image/png', bytes: input },
    operations: ['rigging'],
  }), /contract version/);
  assert.throws(() => validateCreatePoppetRequest({
    schemaVersion: 1,
    requestId: '../request',
    source: { mediaType: 'image/gif', bytes: input },
    operations: ['rigging', 'rigging'],
  }), /requestId|mediaType|duplicate/);
});

test('job identifiers and snapshots reject hostile or contradictory states', () => {
  assert.equal(validateJobId('job:abc-123'), 'job:abc-123');
  for (const id of ['', '../job', 'job/name', ' job', 'x'.repeat(129)]) {
    assert.throws(() => validateJobId(id), /job id/);
  }
  assert.deepEqual(validateStudioJob({
    schemaVersion: 1,
    id: 'job-1',
    requestId: 'request-1',
    state: 'running',
    progress: 0.5,
    result: null,
    error: null,
  }), {
    schemaVersion: 1,
    id: 'job-1',
    requestId: 'request-1',
    state: 'running',
    progress: 0.5,
    result: null,
    error: null,
  });
  assert.throws(() => validateStudioJob({
    schemaVersion: 1,
    id: 'job-1',
    requestId: 'request-1',
    state: 'running',
    progress: 1.5,
    result: {},
    error: null,
  }), /progress|non-terminal/);
});

test('Studio client is disabled and rejects configuration and every operation', async () => {
  const client = createStudioClient();
  assert.equal(client.isAvailable(), false);
  assert.equal(client.getCapabilities(), DISABLED_CAPABILITIES);
  assert.deepEqual(client.getCapabilities(), {
    schemaVersion: 1,
    available: false,
    operations: [],
    reason: 'not-configured',
  });
  assert.ok(Object.isFrozen(client));
  assert.ok(Object.isFrozen(client.getCapabilities()));
  assert.throws(() => createStudioClient({ endpoint: 'https://example.invalid' }),
    error => error.code === STUDIO_ERROR_CODES.INVALID_INPUT);

  for (const method of ['createPoppet', 'getJob', 'cancelJob']) {
    await assert.rejects(client[method]({ ignored: true }),
      error => error.code === STUDIO_ERROR_CODES.UNAVAILABLE);
  }
});

test('disabled client contains no network transport or payment implementation', () => {
  const file = path.resolve(__dirname, '../../src/main/studio/client.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:node:)?(?:http|https|net|tls|dns)['"]\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /stripe|paddle|steamworks|api[_-]?key/i);
});

'use strict';

// This is the in-process boundary between Poppet Core and a future Studio client.
// It is deliberately not an HTTP schema: transport, authentication and billing
// do not exist yet and must not leak into Core contracts by accident.

const STUDIO_CONTRACT_VERSION = 1;
const MAX_STUDIO_INPUT_BYTES = 20 * 1024 * 1024;

const STUDIO_OPERATIONS = Object.freeze([
  'subject-extraction',
  'pixel-redraw',
  'pose-normalization',
  'expression-generation',
  'animation-generation',
  'rigging',
]);

const STUDIO_JOB_STATES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

const STUDIO_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'POPPET_STUDIO_INVALID_INPUT',
  UNAVAILABLE: 'POPPET_STUDIO_UNAVAILABLE',
});

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const OPERATION_SET = new Set(STUDIO_OPERATIONS);
const JOB_STATE_SET = new Set(STUDIO_JOB_STATES);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function studioError(message, code = STUDIO_ERROR_CODES.INVALID_INPUT) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fail(message) {
  throw studioError(message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain object`);
  return value;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field: ${key}`);
  }
}

function assertVersion(value) {
  if (value !== STUDIO_CONTRACT_VERSION) {
    fail(`unsupported Studio contract version: ${value}`);
  }
  return value;
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  fail('source.bytes must be an ArrayBuffer or typed-array view');
}

function validateCreatePoppetRequest(value) {
  assertPlainRecord(value, 'createPoppet request');
  assertExactKeys(value, new Set(['schemaVersion', 'requestId', 'source', 'operations']),
    'createPoppet request');
  assertVersion(value.schemaVersion);
  const requestId = assertIdentifier(value.requestId, 'requestId');

  assertPlainRecord(value.source, 'source');
  assertExactKeys(value.source, new Set(['mediaType', 'bytes']), 'source');
  if (!MEDIA_TYPES.has(value.source.mediaType)) fail('source.mediaType is unsupported');
  const bytes = asBytes(value.source.bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_STUDIO_INPUT_BYTES) {
    fail(`source.bytes must contain 1..${MAX_STUDIO_INPUT_BYTES} bytes`);
  }

  if (!Array.isArray(value.operations) || !value.operations.length
      || value.operations.length > STUDIO_OPERATIONS.length) {
    fail('operations must be a non-empty bounded array');
  }
  const operations = [];
  const seen = new Set();
  for (const operation of value.operations) {
    if (!OPERATION_SET.has(operation)) fail(`unsupported Studio operation: ${operation}`);
    if (seen.has(operation)) fail(`duplicate Studio operation: ${operation}`);
    seen.add(operation);
    operations.push(operation);
  }

  return {
    schemaVersion: STUDIO_CONTRACT_VERSION,
    requestId,
    source: { mediaType: value.source.mediaType, bytes },
    operations,
  };
}

function validateJobId(value) {
  return assertIdentifier(value, 'job id');
}

function validateStudioJob(value) {
  assertPlainRecord(value, 'Studio job');
  assertExactKeys(value,
    new Set(['schemaVersion', 'id', 'requestId', 'state', 'progress', 'result', 'error']),
    'Studio job');
  assertVersion(value.schemaVersion);
  const id = validateJobId(value.id);
  const requestId = assertIdentifier(value.requestId, 'requestId');
  if (!JOB_STATE_SET.has(value.state)) fail(`unsupported Studio job state: ${value.state}`);
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress)
      || value.progress < 0 || value.progress > 1) fail('Studio job progress is invalid');

  const terminal = ['succeeded', 'failed', 'cancelled'].includes(value.state);
  if (!terminal && (value.result !== null || value.error !== null)) {
    fail('non-terminal Studio job cannot contain result or error');
  }
  if (value.state === 'succeeded' && (!isPlainRecord(value.result) || value.error !== null)) {
    fail('succeeded Studio job requires a result and no error');
  }
  if (['failed', 'cancelled'].includes(value.state)
      && (!isPlainRecord(value.error) || value.result !== null)) {
    fail(`${value.state} Studio job requires an error and no result`);
  }

  return {
    schemaVersion: STUDIO_CONTRACT_VERSION,
    id,
    requestId,
    state: value.state,
    progress: value.progress,
    result: value.result === null ? null : { ...value.result },
    error: value.error === null ? null : { ...value.error },
  };
}

function unavailableError() {
  return studioError(
    'Poppet Studio is unavailable: no provider, endpoint, credentials, or billing are configured.',
    STUDIO_ERROR_CODES.UNAVAILABLE,
  );
}

module.exports = {
  STUDIO_CONTRACT_VERSION,
  MAX_STUDIO_INPUT_BYTES,
  STUDIO_OPERATIONS,
  STUDIO_JOB_STATES,
  STUDIO_ERROR_CODES,
  isPlainRecord,
  validateCreatePoppetRequest,
  validateJobId,
  validateStudioJob,
  unavailableError,
};

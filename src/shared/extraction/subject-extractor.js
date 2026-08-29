import { cloneImage } from '../imageops.js';
import { extractLocalSubject } from './local-extractor.js';

export const SUBJECT_EXTRACTOR_CONTRACT_VERSION = 1;
export const LOCAL_SUBJECT_EXTRACTOR_ID = 'local-edge-v1';
export const ADVANCED_SUBJECT_EXTRACTOR_ID = 'advanced-model-v1';

export const subjectExtractorCapabilities = Object.freeze({
  [LOCAL_SUBJECT_EXTRACTOR_ID]: Object.freeze({ available: true, local: true, deterministic: true }),
  [ADVANCED_SUBJECT_EXTRACTOR_ID]: Object.freeze({
    available: false,
    local: true,
    reason: 'No redistributable model/runtime has been approved or bundled.',
  }),
});

const EXTRACTION_MODES = new Set(['alpha', 'chroma', 'none']);
const EXTRACTION_STATUSES = new Set(['ready', 'needs-advanced-extraction']);

function contractError(detail) {
  const error = new Error(`主体提取器返回了无效结果：${detail}`);
  error.code = 'POPPET_EXTRACTOR_CONTRACT';
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateDecision(decision, mode, pixels) {
  if (!isPlainRecord(decision) || decision.mode !== mode) {
    throw contractError('decision 与 mode 不一致');
  }
  if (!Number.isSafeInteger(decision.removed) || decision.removed < 0 || decision.removed > pixels) {
    throw contractError('decision.removed 无效');
  }
  if (decision.reason !== undefined && (typeof decision.reason !== 'string' || decision.reason.length > 500)) {
    throw contractError('decision.reason 无效');
  }
  if (mode === 'none' && (typeof decision.reason !== 'string' || !decision.reason.trim())) {
    throw contractError('none decision 必须解释保留原图的原因');
  }
  if (mode === 'chroma') {
    if (!Array.isArray(decision.bg) || decision.bg.length !== 3
        || decision.bg.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)
        || !Number.isFinite(decision.globalTol) || decision.globalTol < 0
        || !Number.isFinite(decision.localTol) || decision.localTol < 0) {
      throw contractError('chroma decision 无效');
    }
  }
}

// Validate every field consumed by the pipeline before a future adapter can cross
// this boundary. Keeping this exported also lets adapter tests qualify a result
// without teaching the pipeline about provider-specific implementation details.
export function validateSubjectExtractionResult(output, ownedImage, expected = null) {
  if (!isPlainRecord(output) || output.image !== ownedImage) {
    throw contractError('image 必须是提取器收到的 owned image');
  }
  const { width, height, data } = output.image;
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || !Number.isSafeInteger(pixels)
      || !(data instanceof Uint8ClampedArray) || data.length < pixels * 4) {
    throw contractError('image 像素形状无效');
  }
  if (expected && (width !== expected.width || height !== expected.height)) {
    throw contractError('image 尺寸不能被提取器改变');
  }
  if (!EXTRACTION_MODES.has(output.mode)) throw contractError('mode 无效');
  if (!EXTRACTION_STATUSES.has(output.status)) throw contractError('status 无效');
  const expectedStatus = output.mode === 'none' ? 'needs-advanced-extraction' : 'ready';
  if (output.status !== expectedStatus) throw contractError('status 与 mode 不一致');
  if (typeof output.confidence !== 'number' || !Number.isFinite(output.confidence)
      || output.confidence < 0 || output.confidence > 1) {
    throw contractError('confidence 无效');
  }
  validateDecision(output.decision, output.mode, pixels);

  const mask = output.mask?.data ?? output.mask;
  if (!(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray)
      || mask.length !== pixels) throw contractError('mask 形状无效');
  for (let p = 0; p < pixels; p++) {
    if (mask[p] !== 0 && mask[p] !== 1 && mask[p] !== 255) throw contractError('mask 不是二值数据');
    const alpha = data[p * 4 + 3];
    if (alpha !== 0 && alpha !== 255) throw contractError('image alpha 不是二值数据');
    if (Boolean(mask[p]) !== (alpha > 0)) throw contractError('mask 与 image alpha 不一致');
  }

  if (!Array.isArray(output.warnings) || output.warnings.length > 32
      || output.warnings.some(message => typeof message !== 'string' || message.length > 500)) {
    throw contractError('warnings 无效');
  }
  if (output.status === 'needs-advanced-extraction' && output.warnings.length === 0) {
    throw contractError('需要高级提取时必须提供用户提示');
  }
  const expectedReason = output.decision.reason || null;
  if (!isPlainRecord(output.diagnostics)
      || typeof output.diagnostics.extractor !== 'string'
      || output.diagnostics.extractor.length < 1 || output.diagnostics.extractor.length > 128
      || output.diagnostics.removedPixels !== output.decision.removed
      || typeof output.diagnostics.sharedDecision !== 'boolean'
      || output.diagnostics.reason !== expectedReason
      || (expected && typeof expected.sharedDecision === 'boolean'
        && output.diagnostics.sharedDecision !== expected.sharedDecision)) {
    throw contractError('diagnostics 无效');
  }
  return output;
}

export function resolveSubjectExtractor(id = LOCAL_SUBJECT_EXTRACTOR_ID) {
  if (id === LOCAL_SUBJECT_EXTRACTOR_ID || id === 'local') return extractLocalSubject;
  if (id === ADVANCED_SUBJECT_EXTRACTOR_ID || id === 'advanced') {
    const error = new Error('高级主体提取器尚未启用；没有已审核并可再分发的模型。');
    error.code = 'POPPET_EXTRACTOR_UNAVAILABLE';
    throw error;
  }
  const error = new Error(`未知主体提取器：${String(id)}`);
  error.code = 'POPPET_EXTRACTOR_UNKNOWN';
  throw error;
}

export function extractSubject(image, options = {}, sharedDecision = null) {
  const extractor = resolveSubjectExtractor(options.subjectExtractor);
  const owned = cloneImage(image);
  const output = extractor(owned, options, sharedDecision);
  return validateSubjectExtractionResult(output, owned, {
    width: image.width,
    height: image.height,
    sharedDecision: sharedDecision !== null && sharedDecision !== undefined,
  });
}

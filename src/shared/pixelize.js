import { cloneImage, createImage, downsampleTo, quantize } from './imageops.js';

export const PIXELIZE_METHOD_VERSION = 'local-box-median-cut-v1';
export const PIXELIZE_PRESETS = Object.freeze({
  original: Object.freeze({ enabled: false, targetHeight: null, paletteSize: null }),
  soft: Object.freeze({ enabled: true, targetHeight: 192, paletteSize: 40 }),
  classic: Object.freeze({ enabled: true, targetHeight: 128, paletteSize: 24 }),
  chunky: Object.freeze({ enabled: true, targetHeight: 80, paletteSize: 16 }),
  tiny: Object.freeze({ enabled: true, targetHeight: 48, paletteSize: 8 }),
});

const MAX_TARGET_HEIGHT = 400;
const MAX_PALETTE_SIZE = 48;
const DEFAULT_MAX_WORKING_PIXELS = 256 * 1024;

function limitError(message) {
  const error = new Error(message);
  error.code = 'POPPET_RESOURCE_LIMIT';
  error.kind = 'POPPET_PIXELIZE_LIMIT';
  return error;
}

export function normalizePixelizeOptions(options = {}) {
  const requested = typeof options === 'string' ? { preset: options } : (options || {});
  if (typeof requested !== 'object' || Array.isArray(requested)) {
    throw limitError('像素化选项必须是对象或预设名');
  }
  if (requested.preset !== undefined
      && (typeof requested.preset !== 'string' || !Object.hasOwn(PIXELIZE_PRESETS, requested.preset))) {
    throw limitError(`未知像素化预设：${String(requested.preset)}`);
  }
  const presetName = requested.preset || (requested.enabled === true ? 'classic' : 'original');
  const preset = PIXELIZE_PRESETS[presetName];
  if (!preset.enabled && requested.enabled === true) {
    throw limitError('保持原图与 enabled:true 互相矛盾');
  }
  if (!preset.enabled || requested.enabled === false) {
    return Object.freeze({
      enabled: false,
      preset: 'original',
      targetHeight: null,
      paletteSize: null,
      methodVersion: PIXELIZE_METHOD_VERSION,
    });
  }
  const targetHeight = Number.isSafeInteger(requested.targetHeight)
    ? requested.targetHeight : preset.targetHeight;
  const paletteSize = Number.isSafeInteger(requested.paletteSize)
    ? requested.paletteSize : preset.paletteSize;
  if (targetHeight < 16 || targetHeight > MAX_TARGET_HEIGHT) {
    throw limitError(`像素化目标高度必须在 16-${MAX_TARGET_HEIGHT} 之间`);
  }
  if (paletteSize < 2 || paletteSize > MAX_PALETTE_SIZE) {
    throw limitError(`像素化调色板色数必须在 2-${MAX_PALETTE_SIZE} 之间`);
  }
  return Object.freeze({
    enabled: true,
    preset: presetName,
    targetHeight,
    paletteSize,
    methodVersion: PIXELIZE_METHOD_VERSION,
  });
}

function assertImage(image, index = 0) {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || image.width < 1 || image.height < 1) {
    throw limitError(`第 ${index + 1} 帧尺寸无效`);
  }
  const pixels = image.width * image.height;
  if (!Number.isSafeInteger(pixels) || !image.data || image.data.length < pixels * 4) {
    throw limitError(`第 ${index + 1} 帧像素数据不完整`);
  }
}

function hardenAlpha(image) {
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = image.data[i] >= 128 ? 255 : 0;
}

function packRow(frames) {
  const width = frames[0].width * frames.length;
  const height = frames[0].height;
  const sheet = createImage(width, height);
  for (let frame = 0; frame < frames.length; frame++) {
    const source = frames[frame];
    for (let y = 0; y < height; y++) {
      const start = y * source.width * 4;
      const target = (y * width + frame * source.width) * 4;
      sheet.data.set(source.data.subarray(start, start + source.width * 4), target);
    }
  }
  return sheet;
}

function unpackRow(sheet, frameWidth, count) {
  const frames = [];
  for (let frame = 0; frame < count; frame++) {
    const image = createImage(frameWidth, sheet.height);
    for (let y = 0; y < sheet.height; y++) {
      const start = (y * sheet.width + frame * frameWidth) * 4;
      image.data.set(sheet.data.subarray(start, start + frameWidth * 4), y * frameWidth * 4);
    }
    frames.push(image);
  }
  return frames;
}

export function pixelizeFrames(images, options = {}, limits = {}) {
  if (!Array.isArray(images) || images.length < 1) throw limitError('没有可像素化的帧');
  const maxFrames = Number.isSafeInteger(options.maxFrames) && options.maxFrames > 0
    ? options.maxFrames : 64;
  if (images.length > maxFrames) throw limitError(`像素化帧数太多（${images.length}），最多 ${maxFrames} 帧`);
  images.forEach(assertImage);
  const first = images[0];
  if (images.some(image => image.width !== first.width || image.height !== first.height)) {
    throw limitError('像素化要求所有帧尺寸一致');
  }
  const config = normalizePixelizeOptions(options);
  if (!config.enabled) {
    const owned = images.map(cloneImage);
    return {
      frames: owned,
      images: owned,
      palette: null,
      metadata: { ...config, width: first.width, height: first.height, colors: null },
    };
  }

  const requestedWorkingPixels = limits.maxWorkingPixels ?? options.maxWorkingPixels;
  const maxWorkingPixels = Number.isSafeInteger(requestedWorkingPixels) && requestedWorkingPixels > 0
    ? Math.min(requestedWorkingPixels, DEFAULT_MAX_WORKING_PIXELS)
    : DEFAULT_MAX_WORKING_PIXELS;
  let targetHeight = Math.min(config.targetHeight, first.height);
  let targetWidth = Math.max(1, Math.round(first.width * (targetHeight / first.height)));
  const desired = targetWidth * targetHeight * images.length;
  if (desired > maxWorkingPixels) {
    const factor = Math.sqrt(maxWorkingPixels / desired);
    targetWidth = Math.max(1, Math.floor(targetWidth * factor));
    targetHeight = Math.max(1, Math.floor(targetHeight * factor));
  }
  // A source that is already smaller than the minimum preset must remain usable:
  // pixelization may preserve that true grid, but must never invent an upscale.
  // The lower bound still applies when a normal-sized source was forced below it
  // by the working-set budget.
  if (targetHeight < 16 && first.height >= 16) {
    throw limitError(`像素化工作预算不足，目标高度将低于 16（预算 ${maxWorkingPixels} 像素）`);
  }
  const workingPixels = targetWidth * targetHeight * images.length;
  if (!Number.isSafeInteger(workingPixels) || workingPixels > maxWorkingPixels) {
    throw limitError(`像素化工作集过大（${workingPixels}），最多 ${maxWorkingPixels} 像素`);
  }

  const scaled = images.map(image => {
    const output = image.width === targetWidth && image.height === targetHeight
      ? cloneImage(image) : downsampleTo(image, targetWidth, targetHeight);
    hardenAlpha(output);
    return output;
  });
  const sheet = packRow(scaled);
  const palette = quantize(sheet, config.paletteSize);
  const frames = unpackRow(sheet, targetWidth, images.length);
  return {
    frames,
    images: frames,
    palette,
    metadata: {
      ...config,
      width: targetWidth,
      height: targetHeight,
      colors: palette.length,
      sharedPalette: images.length > 1,
    },
  };
}

export function pixelizeImage(image, options = {}, limits = {}) {
  const output = pixelizeFrames([image], options, limits);
  return { image: output.frames[0], palette: output.palette, metadata: output.metadata };
}

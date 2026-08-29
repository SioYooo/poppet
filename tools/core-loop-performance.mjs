// Developer-only performance protocol driver.
//
// The default runtime probe is the developer-only Electron adapter next to this
// file; --probe can inject a schema fixture or an alternate local adapter. A
// probe module must export:
//
//   collectPerformanceScenario({ config, emit })
//   collectPerformanceSoak({ config, emit })
//
// `emit(sample)` receives privacy-safe process samples described by
// validatePerformanceSample below. The probe owns Electron startup, isolated
// profile setup, exact pet counts, activity, teardown, and error observation.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  FAILURE_CLASSES,
  HARNESS_VERSION,
  PERFORMANCE_PROTOCOL,
  SCHEMA_VERSION,
  coarseHardwareClass,
  createMilestoneSummary,
  currentGitBranch,
  currentGitDirty,
  currentGitSha,
  emptyFailureCounts,
  PROJECT_ROOT,
  resolveArtifactDirectory,
  validateMilestoneSummary,
} from './core-loop-contract.mjs';

const modulePath = fileURLToPath(import.meta.url);
const DEFAULT_PROBE = path.join(path.dirname(modulePath), 'core-loop-electron-probe.mjs');
const DEFAULT_PROBE_TOKEN = Symbol('default-performance-probe');
export const DEFAULT_PERFORMANCE_PROBE_IDENTITY = 'poppet-core-loop-electron-probe-v4';
export const PERFORMANCE_HARNESS_VERSION = 'core-loop-performance-harness-v3';
export const EXPECTED_PERFORMANCE_COMPARISON_VERSION = 'core-loop-performance-comparison-v2';
export const FRAME_HISTOGRAM_BUCKET_WIDTH_MS = 1;
export const FRAME_HISTOGRAM_MAX_BUCKET_MS = 250;
export const FRAME_HISTOGRAM_BUCKET_COUNT = 251;
const SAMPLE_KEYS = new Set([
  'schemaVersion', 'runId', 'gitSha', 'topology', 'repetition', 'phase',
  'elapsedMs', 'processType', 'processSlot', 'cpuPercent', 'memoryMiB',
  'frameIntervalMs', 'frameIntervalP50Ms', 'frameIntervalP95Ms',
  'frameIntervalP99Ms', 'frameIntervalSampleCount', 'frameIntervalHistogram',
  'renderWorkMs', 'longFrame', 'longFrameCount', 'longFrameRate', 'eventLoopStallMs',
  'crashCount', 'unhandledErrorCount', 'petCount', 'windowCount', 'timerCount',
  'listenerCount', 'skippedFrameCount', 'harnessVersion',
]);
const PHASES = new Set(['idle', 'active', 'recovery', 'soak']);
const PROCESS_TYPES = new Set(['main', 'renderer', 'gpu', 'utility']);
const FRAME_HISTOGRAM_KEYS = new Set([
  'bucketWidthMs', 'maxBucketMs', 'counts', 'overflowCount',
]);

function schemaError(message) {
  const error = new Error(message);
  error.code = 'POPPET_PERFORMANCE_SCHEMA';
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) schemaError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) schemaError(`${label} unknown key: ${key}`);
  for (const key of allowed) if (!(key in value)) schemaError(`${label} missing key: ${key}`);
}

function finite(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < 0) schemaError(`${label} must be non-negative`);
}

function integer(value, label, min = 0, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) schemaError(`${label} is invalid`);
}

function integerOrNull(value, label, min = 0, max = 1_000_000) {
  if (value === null) return;
  integer(value, label, min, max);
}

function validateFrameHistogram(histogram, sample) {
  if (sample.processType !== 'renderer') {
    if (histogram !== null) schemaError('non-renderer frameIntervalHistogram must be null');
    return;
  }
  exactKeys(histogram, FRAME_HISTOGRAM_KEYS, 'frameIntervalHistogram');
  if (histogram.bucketWidthMs !== FRAME_HISTOGRAM_BUCKET_WIDTH_MS
      || histogram.maxBucketMs !== FRAME_HISTOGRAM_MAX_BUCKET_MS) {
    schemaError('frameIntervalHistogram bucket contract is invalid');
  }
  if (!Array.isArray(histogram.counts)
      || histogram.counts.length !== FRAME_HISTOGRAM_BUCKET_COUNT) {
    schemaError('frameIntervalHistogram counts are invalid');
  }
  histogram.counts.forEach((count, index) => integer(count,
    `frameIntervalHistogram.counts[${index}]`, 0, 100_000_000));
  integer(histogram.overflowCount, 'frameIntervalHistogram.overflowCount', 0, 100_000_000);
  const total = histogram.counts.reduce((sum, count) => sum + count, 0)
    + histogram.overflowCount;
  if (total !== sample.frameIntervalSampleCount) {
    schemaError('frameIntervalHistogram count does not match frameIntervalSampleCount');
  }
}

export function validatePerformanceSample(sample) {
  exactKeys(sample, SAMPLE_KEYS, 'performance sample');
  if (sample.schemaVersion !== SCHEMA_VERSION) schemaError('sample schemaVersion is unsupported');
  if (typeof sample.runId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sample.runId)) schemaError('runId is invalid');
  if (typeof sample.gitSha !== 'string' || !/^[0-9a-f]{40}$/.test(sample.gitSha)) schemaError('gitSha is invalid');
  if (!PERFORMANCE_PROTOCOL.petCounts.includes(sample.topology)) schemaError('topology must be 1, 3, or 6');
  integer(sample.repetition, 'repetition', 1, 100);
  if (!PHASES.has(sample.phase)) schemaError('phase is invalid');
  finite(sample.elapsedMs, 'elapsedMs');
  if (!PROCESS_TYPES.has(sample.processType)) schemaError('processType is invalid');
  integer(sample.processSlot, 'processSlot', 0, PERFORMANCE_PROTOCOL.soakPets);
  if (sample.processType !== 'renderer' && sample.processSlot !== 0) {
    schemaError(`${sample.processType} processSlot must be 0`);
  }
  if (sample.processType === 'renderer' && sample.processSlot < 1) schemaError('renderer processSlot must be positive');
  finite(sample.cpuPercent, 'cpuPercent');
  finite(sample.memoryMiB, 'memoryMiB');
  finite(sample.frameIntervalMs, 'frameIntervalMs', { nullable: true });
  finite(sample.frameIntervalP50Ms, 'frameIntervalP50Ms', { nullable: true });
  finite(sample.frameIntervalP95Ms, 'frameIntervalP95Ms', { nullable: true });
  finite(sample.frameIntervalP99Ms, 'frameIntervalP99Ms', { nullable: true });
  integer(sample.frameIntervalSampleCount, 'frameIntervalSampleCount', 0, 100_000_000);
  validateFrameHistogram(sample.frameIntervalHistogram, sample);
  finite(sample.renderWorkMs, 'renderWorkMs', { nullable: true });
  if (typeof sample.longFrame !== 'boolean') schemaError('longFrame must be boolean');
  integer(sample.longFrameCount, 'longFrameCount', 0, 100_000_000);
  finite(sample.longFrameRate, 'longFrameRate', { nullable: true });
  if (sample.longFrameCount > sample.frameIntervalSampleCount) {
    schemaError('longFrameCount exceeds frameIntervalSampleCount');
  }
  const expectedLongFrameRate = sample.frameIntervalSampleCount
    ? sample.longFrameCount / sample.frameIntervalSampleCount : null;
  if ((expectedLongFrameRate === null && sample.longFrameRate !== null)
      || (expectedLongFrameRate !== null
        && Math.abs(sample.longFrameRate - expectedLongFrameRate) > Number.EPSILON * 8)
      || sample.longFrame !== (sample.longFrameCount > 0)) {
    schemaError('long-frame fields are inconsistent');
  }
  finite(sample.eventLoopStallMs, 'eventLoopStallMs');
  integer(sample.crashCount, 'crashCount');
  integer(sample.unhandledErrorCount, 'unhandledErrorCount');
  integer(sample.petCount, 'petCount', 0, PERFORMANCE_PROTOCOL.soakPets);
  integer(sample.windowCount, 'windowCount', 0, PERFORMANCE_PROTOCOL.soakPets + 2);
  integerOrNull(sample.timerCount, 'timerCount');
  integerOrNull(sample.listenerCount, 'listenerCount');
  if (sample.processType === 'main'
      && (sample.timerCount === null || sample.listenerCount === null)) {
    schemaError('main-process resource counts are required');
  }
  integer(sample.skippedFrameCount, 'skippedFrameCount', 0, 100_000_000);
  if (sample.processType !== 'renderer'
      && (sample.frameIntervalMs !== null || sample.frameIntervalP50Ms !== null
        || sample.frameIntervalP95Ms !== null || sample.frameIntervalP99Ms !== null
        || sample.frameIntervalSampleCount !== 0 || sample.longFrameCount !== 0
        || sample.longFrameRate !== null || sample.skippedFrameCount !== 0)) {
    schemaError('non-renderer frame measurements must be empty');
  }
  if (sample.processType === 'renderer') {
    const merged = {
      ...sample.frameIntervalHistogram,
      sampleCount: sample.frameIntervalSampleCount,
      longFrameCount: sample.longFrameCount,
    };
    const expectedQuantiles = [0.5, 0.95, 0.99]
      .map(ratio => frameHistogramQuantile(merged, ratio));
    const recordedQuantiles = [sample.frameIntervalP50Ms, sample.frameIntervalP95Ms,
      sample.frameIntervalP99Ms];
    if (!sameNullableNumbers(recordedQuantiles, expectedQuantiles)
        || sample.frameIntervalMs !== sample.frameIntervalP50Ms) {
      schemaError('renderer frame quantiles disagree with frameIntervalHistogram');
    }
  }
  if (sample.phase !== 'recovery' && sample.petCount !== sample.topology) {
    schemaError('non-recovery petCount must match topology');
  }
  if (sample.phase === 'recovery' && sample.petCount !== 0) schemaError('recovery petCount must be zero');
  if (typeof sample.harnessVersion !== 'string' || sample.harnessVersion !== HARNESS_VERSION) {
    schemaError('harnessVersion is invalid');
  }
  return sample;
}

function sameNullableNumbers(left, right) {
  return left.length === right.length && left.every((value, index) =>
    (value === null && right[index] === null)
      || (Number.isFinite(value) && value === right[index]));
}

export function createPerformanceSample(input) {
  const renderer = input.processType === 'renderer';
  const fallbackFrame = Number.isFinite(input.frameIntervalMs) ? input.frameIntervalMs : null;
  const intervalCount = input.frameIntervalSampleCount
    ?? (renderer && fallbackFrame !== null ? 1 : 0);
  let p50 = input.frameIntervalP50Ms ?? fallbackFrame;
  let p95 = input.frameIntervalP95Ms ?? fallbackFrame;
  let p99 = input.frameIntervalP99Ms ?? fallbackFrame;
  let histogram = input.frameIntervalHistogram ?? null;
  if (renderer && histogram === null) {
    const counts = Array(FRAME_HISTOGRAM_BUCKET_COUNT).fill(0);
    let overflowCount = 0;
    if (intervalCount > 0 && fallbackFrame !== null) {
      if (fallbackFrame >= FRAME_HISTOGRAM_BUCKET_COUNT) overflowCount = intervalCount;
      else counts[Math.max(0, Math.floor(fallbackFrame))] = intervalCount;
    }
    histogram = {
      bucketWidthMs: FRAME_HISTOGRAM_BUCKET_WIDTH_MS,
      maxBucketMs: FRAME_HISTOGRAM_MAX_BUCKET_MS,
      counts,
      overflowCount,
    };
  }
  if (renderer && histogram) {
    const merged = { ...histogram, sampleCount: intervalCount };
    if (input.frameIntervalP50Ms === undefined) p50 = frameHistogramQuantile(merged, 0.5);
    if (input.frameIntervalP95Ms === undefined) p95 = frameHistogramQuantile(merged, 0.95);
    if (input.frameIntervalP99Ms === undefined) p99 = frameHistogramQuantile(merged, 0.99);
  }
  const longFrameCount = input.longFrameCount
    ?? (input.longFrame ? intervalCount : 0);
  const sample = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    gitSha: input.gitSha,
    topology: input.topology,
    repetition: input.repetition,
    phase: input.phase,
    elapsedMs: input.elapsedMs,
    processType: input.processType,
    processSlot: input.processSlot,
    cpuPercent: input.cpuPercent,
    memoryMiB: input.memoryMiB,
    frameIntervalMs: renderer ? p50 : null,
    frameIntervalP50Ms: renderer ? p50 : null,
    frameIntervalP95Ms: renderer ? p95 : null,
    frameIntervalP99Ms: renderer ? p99 : null,
    frameIntervalSampleCount: renderer ? intervalCount : 0,
    frameIntervalHistogram: renderer ? histogram : null,
    renderWorkMs: input.renderWorkMs ?? null,
    longFrame: renderer && longFrameCount > 0,
    longFrameCount: renderer ? longFrameCount : 0,
    longFrameRate: renderer && intervalCount > 0 ? longFrameCount / intervalCount : null,
    eventLoopStallMs: input.eventLoopStallMs ?? 0,
    crashCount: input.crashCount ?? 0,
    unhandledErrorCount: input.unhandledErrorCount ?? 0,
    petCount: input.petCount,
    windowCount: input.windowCount,
    timerCount: input.timerCount ?? null,
    listenerCount: input.listenerCount ?? null,
    skippedFrameCount: renderer ? (input.skippedFrameCount ?? 0) : 0,
    harnessVersion: HARNESS_VERSION,
  };
  return validatePerformanceSample(sample);
}

function quantile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function mergeFrameIntervalHistograms(samples) {
  const selected = samples.filter(sample => sample.processType === 'renderer');
  const counts = Array(FRAME_HISTOGRAM_BUCKET_COUNT).fill(0);
  let overflowCount = 0;
  let sampleCount = 0;
  let longFrameCount = 0;
  for (const sample of selected) {
    validateFrameHistogram(sample.frameIntervalHistogram, sample);
    sample.frameIntervalHistogram.counts.forEach((count, index) => { counts[index] += count; });
    overflowCount += sample.frameIntervalHistogram.overflowCount;
    sampleCount += sample.frameIntervalSampleCount;
    longFrameCount += sample.longFrameCount;
  }
  return {
    bucketWidthMs: FRAME_HISTOGRAM_BUCKET_WIDTH_MS,
    maxBucketMs: FRAME_HISTOGRAM_MAX_BUCKET_MS,
    counts,
    overflowCount,
    sampleCount,
    longFrameCount,
  };
}

export function frameHistogramQuantile(histogram, ratio) {
  if (!histogram || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1
      || !Number.isSafeInteger(histogram.sampleCount) || histogram.sampleCount < 1) return null;
  const wanted = Math.ceil(histogram.sampleCount * ratio);
  let seen = 0;
  for (let index = 0; index < histogram.counts.length; index++) {
    seen += histogram.counts[index];
    // The fixed histogram retains the true one-millisecond bucket containing
    // the quantile. Return the bucket midpoint; overflow is fail-closed below.
    if (seen >= wanted) return index + FRAME_HISTOGRAM_BUCKET_WIDTH_MS / 2;
  }
  return null;
}

function theilSen(points) {
  if (points.length < 2) return null;
  const slopes = [];
  for (let left = 0; left < points.length - 1; left++) {
    for (let right = left + 1; right < points.length; right++) {
      const dx = points[right].x - points[left].x;
      if (dx > 0) slopes.push((points[right].y - points[left].y) / dx);
    }
  }
  return quantile(slopes, 0.5);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function bootstrapTheilSenLower95(points) {
  if (points.length < 2) return null;
  const random = seededRandom(PERFORMANCE_PROTOCOL.bootstrapSeed);
  const estimates = [];
  for (let iteration = 0; iteration < PERFORMANCE_PROTOCOL.bootstrapSamples; iteration++) {
    const resampled = Array.from({ length: points.length }, () =>
      points[Math.floor(random() * points.length)]).sort((left, right) => left.x - right.x);
    const estimate = theilSen(resampled);
    if (Number.isFinite(estimate)) estimates.push(estimate);
  }
  return estimates.length === PERFORMANCE_PROTOCOL.bootstrapSamples
    ? quantile(estimates, 0.025) : null;
}

export function aggregateMemoryByMinute(samples, durationMs = null) {
  const buckets = new Map();
  const maximumMinute = Number.isFinite(durationMs)
    ? Math.max(0, Math.ceil(durationMs / 60_000) - 1) : Number.MAX_SAFE_INTEGER;
  for (const sample of samples.filter(value => value.phase === 'soak')) {
    const minute = Math.min(maximumMinute, Math.floor(sample.elapsedMs / 60_000));
    const slot = `${sample.processType}:${sample.processSlot}`;
    if (!buckets.has(minute)) buckets.set(minute, new Map());
    const processes = buckets.get(minute);
    if (!processes.has(slot)) processes.set(slot, []);
    processes.get(slot).push(sample.memoryMiB);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([minute, processes]) => ({
    x: minute,
    y: [...processes.values()].reduce((sum, values) => sum + (mean(values) || 0), 0),
  }));
}

export function summarizeResourceTrend(samples) {
  const main = samples
    .filter(sample => sample.phase === 'soak' && sample.processType === 'main')
    .sort((left, right) => left.elapsedMs - right.elapsedMs);
  if (main.length < 2
      || main.some(sample => !Number.isInteger(sample.timerCount)
        || !Number.isInteger(sample.listenerCount))) {
    return {
      status: 'UNAVAILABLE',
      timerFirstWindowMedianDelta: null,
      timerLastWindowMedianDelta: null,
      listenerFirstWindowMedianDelta: null,
      listenerLastWindowMedianDelta: null,
      timerTheilSenDeltaPerMinute: null,
      listenerTheilSenDeltaPerMinute: null,
      sustainedGrowthDetected: null,
    };
  }
  const windowSize = Math.max(1, Math.ceil(main.length * 0.1));
  const first = main.slice(0, windowSize);
  const last = main.slice(-windowSize);
  const timerFirst = quantile(first.map(sample => sample.timerCount), 0.5);
  const timerLast = quantile(last.map(sample => sample.timerCount), 0.5);
  const listenerFirst = quantile(first.map(sample => sample.listenerCount), 0.5);
  const listenerLast = quantile(last.map(sample => sample.listenerCount), 0.5);
  const timerSlope = theilSen(main.map(sample => ({
    x: sample.elapsedMs / 60_000,
    y: sample.timerCount,
  })));
  const listenerSlope = theilSen(main.map(sample => ({
    x: sample.elapsedMs / 60_000,
    y: sample.listenerCount,
  })));
  const timerGrowth = timerLast > timerFirst && timerSlope > 0;
  const listenerGrowth = listenerLast > listenerFirst && listenerSlope > 0;
  return {
    status: 'AVAILABLE',
    timerFirstWindowMedianDelta: timerFirst,
    timerLastWindowMedianDelta: timerLast,
    listenerFirstWindowMedianDelta: listenerFirst,
    listenerLastWindowMedianDelta: listenerLast,
    timerTheilSenDeltaPerMinute: timerSlope,
    listenerTheilSenDeltaPerMinute: listenerSlope,
    sustainedGrowthDetected: timerGrowth || listenerGrowth,
  };
}

export function summarizeMemoryTrend(memoryMinutes, config) {
  // A ten-minute leading and trailing window must not overlap. Short duration
  // overrides are schema smoke only and cannot answer the preregistered soak
  // question.
  if (config.soakMs < 20 * 60_000 || memoryMinutes.length < 20) {
    return {
      status: 'UNAVAILABLE',
      combinedMemoryTheilSenMiBPerMinute: null,
      combinedMemoryTheilSenLower95MiBPerMinute: null,
      firstTenMinuteMedianMiB: null,
      lastTenMinuteMedianMiB: null,
      lastMinusFirstMedianMiB: null,
      bootstrapSamples: PERFORMANCE_PROTOCOL.bootstrapSamples,
      bootstrapSeed: PERFORMANCE_PROTOCOL.bootstrapSeed,
      regressionDetected: null,
    };
  }
  const slope = theilSen(memoryMinutes);
  const lower95 = bootstrapTheilSenLower95(memoryMinutes);
  const firstMedian = quantile(memoryMinutes.slice(0, 10).map(point => point.y), 0.5);
  const lastMedian = quantile(memoryMinutes.slice(-10).map(point => point.y), 0.5);
  if (![slope, lower95, firstMedian, lastMedian].every(Number.isFinite)) {
    return {
      status: 'UNAVAILABLE',
      combinedMemoryTheilSenMiBPerMinute: null,
      combinedMemoryTheilSenLower95MiBPerMinute: null,
      firstTenMinuteMedianMiB: null,
      lastTenMinuteMedianMiB: null,
      lastMinusFirstMedianMiB: null,
      bootstrapSamples: PERFORMANCE_PROTOCOL.bootstrapSamples,
      bootstrapSeed: PERFORMANCE_PROTOCOL.bootstrapSeed,
      regressionDetected: null,
    };
  }
  const delta = lastMedian - firstMedian;
  return {
    status: 'AVAILABLE',
    combinedMemoryTheilSenMiBPerMinute: slope,
    combinedMemoryTheilSenLower95MiBPerMinute: lower95,
    firstTenMinuteMedianMiB: firstMedian,
    lastTenMinuteMedianMiB: lastMedian,
    lastMinusFirstMedianMiB: delta,
    bootstrapSamples: PERFORMANCE_PROTOCOL.bootstrapSamples,
    bootstrapSeed: PERFORMANCE_PROTOCOL.bootstrapSeed,
    regressionDetected: lower95 > 1 && delta > 20,
  };
}

export function recomputePerformanceSoak(samples, config) {
  const soak = samples.filter(sample => sample.phase === 'soak');
  const memoryMinutes = aggregateMemoryByMinute(soak, config.soakMs);
  return {
    samples: soak.length,
    durationMs: config.soakMs,
    memoryTrend: summarizeMemoryTrend(memoryMinutes, config),
    crashes: soak.reduce((sum, sample) => sum + sample.crashCount, 0),
    unhandledErrors: soak.reduce((sum, sample) => sum + sample.unhandledErrorCount, 0),
    resourceTrend: summarizeResourceTrend(soak),
  };
}

function summarizeSamples(samples, config) {
  const byTopology = {};
  for (const topology of PERFORMANCE_PROTOCOL.petCounts) {
    const selected = samples.filter(sample => sample.topology === topology && sample.phase !== 'soak');
    const main = selected.filter(sample => sample.processType === 'main');
    const renderers = selected.filter(sample => sample.processType === 'renderer');
    const frameHistogram = mergeFrameIntervalHistograms(renderers);
    const renderWork = renderers.map(sample => sample.renderWorkMs).filter(Number.isFinite);
    const activeRenderer = renderers.filter(sample => sample.phase === 'active');
    byTopology[topology] = {
      samples: selected.length,
      meanMainCpuPercent: mean(main.map(sample => sample.cpuPercent)),
      meanRendererCpuPercent: mean(renderers.map(sample => sample.cpuPercent)),
      peakMainMemoryMiB: main.length ? Math.max(...main.map(sample => sample.memoryMiB)) : null,
      peakRendererMemoryMiB: renderers.length ? Math.max(...renderers.map(sample => sample.memoryMiB)) : null,
      frameIntervalP50Ms: frameHistogramQuantile(frameHistogram, 0.5),
      frameIntervalP95Ms: frameHistogramQuantile(frameHistogram, 0.95),
      frameIntervalP99Ms: frameHistogramQuantile(frameHistogram, 0.99),
      frameIntervalSampleCount: frameHistogram.sampleCount,
      frameIntervalOverflowCount: frameHistogram.overflowCount,
      renderWorkP95Ms: quantile(renderWork, 0.95),
      activeLongFrameRate: activeRenderer.reduce((sum, sample) => sum + sample.frameIntervalSampleCount, 0)
        ? activeRenderer.reduce((sum, sample) => sum + sample.longFrameCount, 0)
          / activeRenderer.reduce((sum, sample) => sum + sample.frameIntervalSampleCount, 0)
        : null,
      eventLoopStalls: selected.filter(sample => sample.eventLoopStallMs >= PERFORMANCE_PROTOCOL.eventLoopStallMs).length,
      crashes: selected.reduce((sum, sample) => sum + sample.crashCount, 0),
      unhandledErrors: selected.reduce((sum, sample) => sum + sample.unhandledErrorCount, 0),
      postDestroyPetCountMax: Math.max(0, ...selected.filter(sample => sample.phase === 'recovery').map(sample => sample.petCount)),
      postDestroyWindowCountMax: Math.max(0, ...selected.filter(sample => sample.phase === 'recovery').map(sample => sample.windowCount)),
      postDestroyTimerDeltaMax: Math.max(0, ...selected.filter(sample => sample.phase === 'recovery')
        .map(sample => sample.timerCount).filter(Number.isInteger)),
      postDestroyListenerDeltaMax: Math.max(0, ...selected.filter(sample => sample.phase === 'recovery')
        .map(sample => sample.listenerCount).filter(Number.isInteger)),
    };
  }
  const soakSummary = recomputePerformanceSoak(samples, config);
  return {
    protocolQualified: config.protocolQualified,
    protocol: {
      petCounts: PERFORMANCE_PROTOCOL.petCounts,
      repetitions: config.repetitions,
      warmupMs: config.warmupMs,
      idleMs: config.idleMs,
      activeMs: config.activeMs,
      recoveryMs: config.recoveryMs,
      soakPets: PERFORMANCE_PROTOCOL.soakPets,
      soakWarmupMs: config.soakWarmupMs,
      soakMs: config.soakMs,
      sampleIntervalMs: config.sampleIntervalMs,
    },
    byTopology,
    soak: {
      ...soakSummary,
      comparisonToPreChange: null,
    },
  };
}

function temporalBucket(elapsedMs, durationMs, bucketMs) {
  const count = Math.ceil(durationMs / bucketMs);
  return Math.min(count - 1, Math.max(0, Math.ceil(Math.min(elapsedMs, durationMs) / bucketMs) - 1));
}

function assertQualifiedSeriesCoverage(samples, {
  durationMs, sampleIntervalMs, label, bucketMs = 10_000, minimumPerBucket = 8,
}) {
  const ordered = samples.slice().sort((left, right) => left.elapsedMs - right.elapsedMs);
  if (ordered[0]?.processType === 'renderer'
      && ordered.some(sample => sample.frameIntervalSampleCount < 1
        || sample.frameIntervalHistogram.overflowCount > 0
        || !Number.isFinite(sample.frameIntervalP50Ms)
        || !Number.isFinite(sample.frameIntervalP95Ms)
        || !Number.isFinite(sample.frameIntervalP99Ms))) {
    schemaError(`${label} lacks bounded real frame-interval evidence`);
  }
  const tolerance = Math.max(250, sampleIntervalMs * 0.35);
  const minimumSamples = Math.max(1, Math.floor(durationMs / sampleIntervalMs) - 1);
  if (ordered.length < minimumSamples) schemaError(`${label} misses the 1-second sample density`);
  if (ordered[0].elapsedMs > sampleIntervalMs + tolerance) {
    schemaError(`${label} starts too late for the 1-second cadence`);
  }
  if (ordered.at(-1).elapsedMs < durationMs - sampleIntervalMs - tolerance) {
    schemaError(`${label} ends too early for temporal coverage`);
  }
  for (let index = 1; index < ordered.length; index++) {
    const gap = ordered[index].elapsedMs - ordered[index - 1].elapsedMs;
    if (gap <= 0 || gap > sampleIntervalMs + tolerance) {
      schemaError(`${label} violates the 1-second cadence`);
    }
  }
  const bucketCount = Math.ceil(durationMs / bucketMs);
  for (let position = 0; position < bucketCount; position++) {
    const selected = ordered.filter(sample =>
      temporalBucket(sample.elapsedMs, durationMs, bucketMs) === position);
    const bucketDuration = Math.min(bucketMs, durationMs - position * bucketMs);
    const expected = Math.floor(bucketDuration / sampleIntervalMs);
    const required = Math.max(1, Math.min(minimumPerBucket, expected - 2));
    if (selected.length < required) schemaError(`${label} is sparse in time bucket ${position}`);
    const start = position * bucketMs;
    const end = Math.min(durationMs, start + bucketMs);
    if (selected[0].elapsedMs > start + sampleIntervalMs + tolerance
        || selected.at(-1).elapsedMs < end - sampleIntervalMs - tolerance) {
      schemaError(`${label} lacks temporal coverage in time bucket ${position}`);
    }
  }
}

function assertCompleteTickSets(samples, topology, phase, label) {
  const expected = new Set(['main:0']);
  if (phase !== 'recovery') {
    for (let slot = 1; slot <= topology; slot++) expected.add(`renderer:${slot}`);
  }
  // gpu/utility 行是同一 tick 快照里的可选成员：GPU/工具进程可能在进程
  // 重启间隙缺席一个 tick，这不构成快照不完整；但 main 与全部 renderer
  // 槽位仍然每 tick 必须到齐，重复身份仍然是错误。
  const optional = new Set(['gpu:0', 'utility:0']);
  const moments = new Map();
  for (const sample of samples) {
    const key = String(sample.elapsedMs);
    if (!moments.has(key)) moments.set(key, new Set());
    const identity = `${sample.processType}:${sample.processSlot}`;
    if (moments.get(key).has(identity)) schemaError(`${label} duplicates a process at one sampling tick`);
    moments.get(key).add(identity);
  }
  for (const identities of moments.values()) {
    for (const identity of identities) {
      if (!expected.has(identity) && !optional.has(identity)) {
        schemaError(`${label} contains an unexpected process at one sampling tick (${identity})`);
      }
    }
    if ([...expected].some(identity => !identities.has(identity))) {
      schemaError(`${label} does not contain a complete same-tick process snapshot`);
    }
  }
}

function assertScenarioCoverage(samples, topology, repetition, config, qualified) {
  if (!samples.length) schemaError(`probe emitted no samples for ${topology} pets repetition ${repetition}`);
  if (samples.some(sample => sample.topology !== topology || sample.repetition !== repetition
      || !['idle', 'active', 'recovery'].includes(sample.phase))) {
    schemaError(`${topology}-pet repetition ${repetition} emitted samples outside its scenario`);
  }
  for (const phase of ['idle', 'active']) {
    const selected = samples.filter(sample => sample.phase === phase);
    if (!selected.some(sample => sample.processType === 'main')) {
      schemaError(`${topology}-pet ${phase} phase is missing main-process samples`);
    }
    for (let slot = 1; slot <= topology; slot++) {
      if (!selected.some(sample => sample.processType === 'renderer' && sample.processSlot === slot)) {
        schemaError(`${topology}-pet ${phase} phase is missing renderer slot ${slot}`);
      }
    }
    if (qualified) {
      assertCompleteTickSets(selected, topology, phase, `${topology}-pet ${phase}`);
      for (const identity of processIdentitiesFor(topology, phase)) {
        assertQualifiedSeriesCoverage(selected.filter(sample => sample.processType === identity.processType
          && sample.processSlot === identity.processSlot), {
          durationMs: config[`${phase}Ms`],
          sampleIntervalMs: config.sampleIntervalMs,
          label: `${topology}-pet ${phase} ${identity.processType}:${identity.processSlot}`,
        });
      }
    }
  }
  const recovery = samples.filter(sample => sample.phase === 'recovery');
  if (!recovery.some(sample => sample.processType === 'main')) {
    schemaError(`${topology}-pet recovery phase is missing its main-process sample`);
  }
  if (qualified) {
    assertCompleteTickSets(recovery, topology, 'recovery', `${topology}-pet recovery`);
    assertQualifiedSeriesCoverage(recovery, {
      durationMs: config.recoveryMs,
      sampleIntervalMs: config.sampleIntervalMs,
      label: `${topology}-pet recovery main:0`,
    });
  }
}

function processIdentitiesFor(topology, phase) {
  const identities = [{ processType: 'main', processSlot: 0 }];
  if (phase !== 'recovery') {
    for (let processSlot = 1; processSlot <= topology; processSlot++) {
      identities.push({ processType: 'renderer', processSlot });
    }
  }
  return identities;
}

function assertSoakCoverage(samples, config, qualified) {
  if (samples.some(sample => sample.phase !== 'soak'
      || sample.topology !== PERFORMANCE_PROTOCOL.soakPets || sample.repetition !== 1)) {
    schemaError('soak emitted samples outside the six-pet soak scenario');
  }
  const main = samples.filter(sample => sample.phase === 'soak' && sample.processType === 'main');
  if (main.length < 2) {
    schemaError('soak requires at least two main-process samples for resource-trend detection');
  }
  for (let slot = 1; slot <= PERFORMANCE_PROTOCOL.soakPets; slot++) {
    if (!samples.some(sample => sample.phase === 'soak'
        && sample.processType === 'renderer' && sample.processSlot === slot)) {
      schemaError(`soak is missing renderer slot ${slot}`);
    }
  }
  if (qualified) {
    assertCompleteTickSets(samples, PERFORMANCE_PROTOCOL.soakPets, 'soak', 'six-pet soak');
    for (const identity of processIdentitiesFor(PERFORMANCE_PROTOCOL.soakPets, 'soak')) {
      const series = samples.filter(sample => sample.processType === identity.processType
        && sample.processSlot === identity.processSlot);
      assertQualifiedSeriesCoverage(series, {
        durationMs: config.soakMs,
        sampleIntervalMs: config.sampleIntervalMs,
        label: `six-pet soak ${identity.processType}:${identity.processSlot}`,
        bucketMs: 60_000,
        minimumPerBucket: 55,
      });
    }
  }
}

function numericArg(args, flag, fallback, { min = 1, max = 24 * 60 * 60_000 } = {}) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${flag} is out of range`);
  return value;
}

function stringArg(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parsePerformanceArgs(args = process.argv.slice(2)) {
  const valueFlags = new Set([
    '--probe', '--output', '--app-root', '--repetitions', '--warmup-ms', '--idle-ms', '--active-ms',
    '--recovery-ms', '--soak-warmup-ms', '--soak-ms', '--sample-interval-ms',
  ]);
  const booleanFlags = new Set(['--allow-smoke']);
  for (let index = 0; index < args.length; index++) {
    if (booleanFlags.has(args[index])) continue;
    if (!valueFlags.has(args[index])) throw new Error(`Unknown performance option: ${args[index]}`);
    if (args[index + 1] === undefined || args[index + 1].startsWith('--')) {
      throw new Error(`${args[index]} requires a value`);
    }
    index++;
  }
  const config = {
    probe: stringArg(args, '--probe'),
    output: stringArg(args, '--output'),
    appRoot: stringArg(args, '--app-root'),
    repetitions: numericArg(args, '--repetitions', PERFORMANCE_PROTOCOL.repetitions, { min: 1, max: 20 }),
    warmupMs: numericArg(args, '--warmup-ms', PERFORMANCE_PROTOCOL.warmupMs),
    idleMs: numericArg(args, '--idle-ms', PERFORMANCE_PROTOCOL.idleMs),
    activeMs: numericArg(args, '--active-ms', PERFORMANCE_PROTOCOL.activeMs),
    recoveryMs: numericArg(args, '--recovery-ms', PERFORMANCE_PROTOCOL.recoveryMs),
    soakWarmupMs: numericArg(args, '--soak-warmup-ms', PERFORMANCE_PROTOCOL.soakWarmupMs),
    soakMs: numericArg(args, '--soak-ms', PERFORMANCE_PROTOCOL.soakMs),
    sampleIntervalMs: numericArg(args, '--sample-interval-ms', PERFORMANCE_PROTOCOL.sampleIntervalMs),
    allowSmoke: args.includes('--allow-smoke'),
  };
  config.protocolQualified = config.repetitions === PERFORMANCE_PROTOCOL.repetitions
    && config.warmupMs === PERFORMANCE_PROTOCOL.warmupMs
    && config.idleMs === PERFORMANCE_PROTOCOL.idleMs
    && config.activeMs === PERFORMANCE_PROTOCOL.activeMs
    && config.recoveryMs === PERFORMANCE_PROTOCOL.recoveryMs
    && config.soakWarmupMs === PERFORMANCE_PROTOCOL.soakWarmupMs
    && config.soakMs === PERFORMANCE_PROTOCOL.soakMs
    && config.sampleIntervalMs === PERFORMANCE_PROTOCOL.sampleIntervalMs
    && config.probe === null;
  return config;
}

export async function loadPerformanceProbe(file) {
  const resolved = path.resolve(file || DEFAULT_PROBE);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Performance probe must be a regular non-symlink module');
  const probe = await import(`${pathToFileURL(resolved).href}?run=${crypto.randomUUID()}`);
  if (typeof probe.collectPerformanceScenario !== 'function'
      || typeof probe.collectPerformanceSoak !== 'function') {
    throw new Error('Performance probe does not implement collectPerformanceScenario and collectPerformanceSoak');
  }
  return Object.freeze({
    collectPerformanceScenario: probe.collectPerformanceScenario,
    collectPerformanceSoak: probe.collectPerformanceSoak,
    performanceProbeIdentity: probe.performanceProbeIdentity || 'custom-unverified-probe',
    [DEFAULT_PROBE_TOKEN]: resolved === path.resolve(DEFAULT_PROBE),
  });
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function validateProbeMetadata(value) {
  const keys = new Set([
    'probeIdentity', 'fixtureIdentity', 'settingsIdentity', 'electronVersion',
    'environmentIdentity', 'electronNodeVersion', 'probeSourceSha256', 'driverNodeVersion',
  ]);
  exactKeys(value, keys, 'performance probe metadata');
  if (value.probeIdentity !== DEFAULT_PERFORMANCE_PROBE_IDENTITY) {
    schemaError('default performance probe identity is invalid');
  }
  for (const key of ['fixtureIdentity', 'settingsIdentity', 'environmentIdentity', 'probeSourceSha256']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key])) {
      schemaError(`performance probe ${key} is invalid`);
    }
  }
  for (const key of ['electronVersion', 'electronNodeVersion', 'driverNodeVersion']) {
    if (typeof value[key] !== 'string' || !/^\d+\.\d+\.\d+/.test(value[key])) {
      schemaError(`performance probe ${key} is invalid`);
    }
  }
  return value;
}

export function performanceProtocolIdentity(config) {
  return sha256Json({
    petCounts: PERFORMANCE_PROTOCOL.petCounts,
    repetitions: config.repetitions,
    warmupMs: config.warmupMs,
    idleMs: config.idleMs,
    activeMs: config.activeMs,
    recoveryMs: config.recoveryMs,
    soakPets: PERFORMANCE_PROTOCOL.soakPets,
    soakWarmupMs: config.soakWarmupMs,
    soakMs: config.soakMs,
    sampleIntervalMs: config.sampleIntervalMs,
  });
}

export async function runPerformanceProtocol({
  probe,
  config = parsePerformanceArgs([]),
  runId = `performance-${crypto.randomUUID()}`,
  gitSha = null,
  branch = null,
  sourceDirty = null,
  harnessGitSha = null,
  harnessSourceDirty = null,
  now = new Date(),
} = {}) {
  if (!probe || typeof probe.collectPerformanceScenario !== 'function'
      || typeof probe.collectPerformanceSoak !== 'function') {
    throw new Error('A valid performance probe object is required');
  }
  const sourceRoot = config.appRoot ? path.resolve(config.appRoot) : PROJECT_ROOT;
  gitSha = gitSha || currentGitSha(sourceRoot);
  branch = branch ?? currentGitBranch(sourceRoot);
  sourceDirty = sourceDirty ?? currentGitDirty(sourceRoot);
  harnessGitSha = harnessGitSha || currentGitSha(PROJECT_ROOT);
  harnessSourceDirty = harnessSourceDirty ?? currentGitDirty(PROJECT_ROOT);
  if (!gitSha) throw new Error('A Git SHA is required for a performance run');
  if (!harnessGitSha) throw new Error('A committed harness Git SHA is required for a performance run');
  const samples = [];
  const probeMetadata = [];
  const defaultProbe = probe[DEFAULT_PROBE_TOKEN] === true
    && probe.performanceProbeIdentity === DEFAULT_PERFORMANCE_PROBE_IDENTITY;
  const strictLockedProtocol = config.protocolQualified === true && defaultProbe;
  const emit = input => {
    const sample = createPerformanceSample({ ...input, runId, gitSha });
    samples.push(sample);
  };
  for (const topology of PERFORMANCE_PROTOCOL.petCounts) {
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      const before = samples.length;
      const metadata = await probe.collectPerformanceScenario({
        config: {
          topology,
          repetition,
          warmupMs: config.warmupMs,
          idleMs: config.idleMs,
          activeMs: config.activeMs,
          recoveryMs: config.recoveryMs,
          sampleIntervalMs: config.sampleIntervalMs,
          appRoot: config.appRoot,
        },
        emit,
      });
      if (metadata !== undefined) probeMetadata.push(metadata);
      assertScenarioCoverage(samples.slice(before), topology, repetition, config, strictLockedProtocol);
    }
  }
  const beforeSoak = samples.length;
  const soakMetadata = await probe.collectPerformanceSoak({
    config: {
      topology: PERFORMANCE_PROTOCOL.soakPets,
      repetition: 1,
      warmupMs: config.soakWarmupMs,
      soakMs: config.soakMs,
      sampleIntervalMs: config.sampleIntervalMs,
      appRoot: config.appRoot,
    },
    emit,
  });
  if (soakMetadata !== undefined) probeMetadata.push(soakMetadata);
  assertSoakCoverage(samples.slice(beforeSoak), config, strictLockedProtocol);
  if (!samples.length) throw new Error('Performance probe emitted no samples');

  let verifiedProbeMetadata = null;
  if (defaultProbe) {
    if (probeMetadata.length !== PERFORMANCE_PROTOCOL.petCounts.length * config.repetitions + 1) {
      schemaError('default performance probe omitted required provenance metadata');
    }
    probeMetadata.forEach(validateProbeMetadata);
    const canonical = JSON.stringify(probeMetadata[0]);
    if (probeMetadata.some(value => JSON.stringify(value) !== canonical)) {
      schemaError('performance probe provenance changed within the run');
    }
    verifiedProbeMetadata = probeMetadata[0];
  }
  const protocolQualified = strictLockedProtocol
    && verifiedProbeMetadata !== null
    && verifiedProbeMetadata.environmentIdentity !== null
    && sourceDirty === false
    && harnessSourceDirty === false;
  const effectiveConfig = { ...config, protocolQualified };

  const performanceSummary = {
    hardwareClass: coarseHardwareClass(),
    sourceDirty,
    provenance: {
      identityVersion: 'core-loop-performance-run-identity-v1',
      appGitSha: gitSha,
      harnessGitSha,
      harnessSourceClean: harnessSourceDirty === false,
      harnessVersion: HARNESS_VERSION,
      performanceHarnessVersion: PERFORMANCE_HARNESS_VERSION,
      comparisonVersion: EXPECTED_PERFORMANCE_COMPARISON_VERSION,
      probeIdentity: verifiedProbeMetadata?.probeIdentity || 'custom-unverified-probe',
      probeSourceSha256: verifiedProbeMetadata?.probeSourceSha256 || null,
      fixtureIdentity: verifiedProbeMetadata?.fixtureIdentity || null,
      settingsIdentity: verifiedProbeMetadata?.settingsIdentity || null,
      environmentIdentity: verifiedProbeMetadata?.environmentIdentity || null,
      protocolIdentity: performanceProtocolIdentity(config),
      driverNodeVersion: verifiedProbeMetadata?.driverNodeVersion || process.versions.node,
      electronVersion: verifiedProbeMetadata?.electronVersion || null,
      electronNodeVersion: verifiedProbeMetadata?.electronNodeVersion || null,
    },
    ...summarizeSamples(samples, effectiveConfig),
  };
  const failureCounts = emptyFailureCounts();
  // A developer performance run has no human participants and no rights-cleared
  // product corpus. Preserve those unexecuted product gates as explicit
  // failures; engineering telemetry must never silently turn them into zeroes.
  failureCounts.HUMAN_EVIDENCE_UNAVAILABLE = 1;
  failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED = 1;
  const anyRuntimeError = samples.some(sample => sample.crashCount > 0 || sample.unhandledErrorCount > 0);
  const anyRecoveryLeak = samples.some(sample => sample.phase === 'recovery'
    && (sample.petCount !== 0 || sample.windowCount !== 0
      || (sample.timerCount !== null && sample.timerCount > 0)
      || (sample.listenerCount !== null && sample.listenerCount > 0)));
  const soakResourceTrend = performanceSummary.soak.resourceTrend;
  const anySoakResourceRegression = soakResourceTrend.status !== 'AVAILABLE'
    || soakResourceTrend.sustainedGrowthDetected;
  const soakMemoryTrend = performanceSummary.soak.memoryTrend;
  const qualifiedMemoryUnavailable = protocolQualified
    && soakMemoryTrend.status !== 'AVAILABLE';
  const requestedQualifiedEnvironmentInvalid = strictLockedProtocol
    && (!verifiedProbeMetadata || sourceDirty !== false || harnessSourceDirty !== false);
  if (qualifiedMemoryUnavailable || requestedQualifiedEnvironmentInvalid) {
    failureCounts.ENVIRONMENT_FAILURE++;
  }
  if (anyRuntimeError || anyRecoveryLeak || anySoakResourceRegression
      || soakMemoryTrend.regressionDetected === true) {
    failureCounts.PERFORMANCE_REGRESSION++;
  }
  const summary = createMilestoneSummary({
    generatedAt: now.toISOString(),
    gitSha,
    branch,
    engineeringVerdict: 'PARTIAL_VERIFIED',
    productVerdict: 'HUMAN_REQUIRED',
    evidenceBoundaries: [
      protocolQualified ? 'LOCAL_PREREGISTERED_PERFORMANCE_BASELINE' : 'LOCAL_PERFORMANCE_SMOKE_ONLY',
      defaultProbe ? 'DEFAULT_ELECTRON_PROBE' : 'CUSTOM_PROBE_NON_CLAIMABLE',
      harnessSourceDirty === false ? 'CLEAN_COMMITTED_HARNESS_SOURCE' : 'DIRTY_OR_UNKNOWN_HARNESS_SOURCE',
      'NOT_NATIVE_INSTALLER_OR_HUMAN_EVIDENCE',
      'NO_BEFORE_AFTER_COMPARISON_RECORDED',
      ...(soakMemoryTrend.status === 'UNAVAILABLE' ? ['SOAK_MEMORY_ANALYSIS_UNAVAILABLE'] : []),
      ...(sourceDirty === true ? ['DIRTY_WORKTREE_SOURCE'] : []),
      ...(sourceDirty === false ? ['CLEAN_WORKTREE_SOURCE'] : []),
      ...(sourceDirty === null ? ['SOURCE_CLEANLINESS_UNAVAILABLE'] : []),
    ],
    testCommands: ['npm run measure:performance'],
    performanceSummary,
    failureCounts,
    rightsStatus: 'RIGHTS_OR_PROVENANCE_BLOCKED',
    remainingGates: [
      'Compare the final source against the locked same-machine pre-change baseline.',
      'Native installation, signed/notarized execution, and human residency remain separate gates.',
    ],
    nextAction: 'Capture and compare the locked same-machine pre-change and final-source runs.',
  });
  return { samples, summary, hardwareClass: coarseHardwareClass() };
}

function renderPerformanceMarkdown(summary) {
  const performance = summary.performanceSummary;
  const lines = [
    '# Poppet Core Loop local performance run',
    '',
    `Generated: ${summary.generatedAt}`,
    `Git SHA: ${summary.gitSha}`,
    `Protocol qualified: ${performance.protocolQualified}`,
    '',
    '## Evidence boundary',
    '',
    ...summary.evidenceBoundaries.map(value => `- ${value}`),
    '',
    '## 1/3/6 pets',
    '',
    '| Pets | Samples | Main CPU | Renderer CPU | Main MiB peak | Renderer MiB peak | Frame p95 ms | Long-frame rate | Crashes/errors |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const topology of PERFORMANCE_PROTOCOL.petCounts) {
    const row = performance.byTopology[topology];
    const number = value => Number.isFinite(value) ? value.toFixed(2) : 'N/A';
    lines.push(`| ${topology} | ${row.samples} | ${number(row.meanMainCpuPercent)} | ${number(row.meanRendererCpuPercent)} | ${number(row.peakMainMemoryMiB)} | ${number(row.peakRendererMemoryMiB)} | ${number(row.frameIntervalP95Ms)} | ${number(row.activeLongFrameRate)} | ${row.crashes}/${row.unhandledErrors} |`);
  }
  lines.push(
    '',
    '## Soak',
    '',
    `- Duration: ${performance.soak.durationMs} ms`,
    `- Samples: ${performance.soak.samples}`,
    `- Memory trend: ${performance.soak.memoryTrend.status}`,
    `- Memory slope: ${performance.soak.memoryTrend.combinedMemoryTheilSenMiBPerMinute ?? 'N/A'} MiB/min`,
    `- Memory slope 95% lower bound: ${performance.soak.memoryTrend.combinedMemoryTheilSenLower95MiBPerMinute ?? 'N/A'} MiB/min`,
    `- Last-minus-first ten-minute median: ${performance.soak.memoryTrend.lastMinusFirstMedianMiB ?? 'N/A'} MiB`,
    `- Memory regression: ${performance.soak.memoryTrend.regressionDetected ?? 'N/A'}`,
    `- Resource trend: ${performance.soak.resourceTrend.status}`,
    `- Sustained timer/listener growth: ${performance.soak.resourceTrend.sustainedGrowthDetected ?? 'N/A'}`,
    `- Crashes/unhandled: ${performance.soak.crashes}/${performance.soak.unhandledErrors}`,
    '- Before/after comparison: NOT_RUN',
  );
  return `${lines.join('\n')}\n`;
}

export function writePerformanceRun({ directory, samples, summary }) {
  const { root, target } = resolveArtifactDirectory(directory, { label: 'performance' });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(target, { recursive: false });
  samples.forEach(validatePerformanceSample);
  validateMilestoneSummary(summary);
  fs.writeFileSync(path.join(target, 'samples.jsonl'), `${samples.map(sample => JSON.stringify(sample)).join('\n')}\n`);
  fs.writeFileSync(path.join(target, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'report.md'), renderPerformanceMarkdown(summary));
  return path.relative(PROJECT_ROOT, target).split(path.sep).join('/');
}

export function performanceRunExitCode(summary, { allowSmoke = false } = {}) {
  validateMilestoneSummary(summary);
  if (summary.failureCounts.PERFORMANCE_REGRESSION
      || summary.failureCounts.ENVIRONMENT_FAILURE) return 1;
  if (!summary.performanceSummary?.protocolQualified && !allowSmoke) return 1;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  try {
    const config = parsePerformanceArgs();
    const probe = await loadPerformanceProbe(config.probe);
    const { samples, summary } = await runPerformanceProtocol({ probe, config });
    const { target } = resolveArtifactDirectory(config.output, { label: 'performance' });
    const relative = writePerformanceRun({ directory: target, samples, summary });
    console.log(`[core-loop-performance] ${samples.length} samples`);
    console.log(`[core-loop-performance] protocol qualified: ${summary.performanceSummary.protocolQualified}`);
    console.log(`[core-loop-performance] local artifacts: ${relative}`);
    const smokeNotAllowed = !summary.performanceSummary.protocolQualified && !config.allowSmoke;
    if (smokeNotAllowed) {
      console.error('[core-loop-performance] SMOKE_ONLY: pass --allow-smoke to accept a non-claimable smoke result');
    }
    process.exit(performanceRunExitCode(summary, { allowSmoke: config.allowSmoke }));
  } catch (error) {
    const failure = FAILURE_CLASSES.includes(error?.code) ? error.code : 'ENVIRONMENT_FAILURE';
    console.error(`[core-loop-performance] ${failure}: ${error?.stack || error}`);
    process.exit(1);
  }
}

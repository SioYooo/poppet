// Developer-only before/after comparator for the locked Core-loop performance
// protocol. Raw run inputs and aggregate outputs stay under
// .artifacts/core-loop and are never reached by production entry points.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERFORMANCE_PROTOCOL,
  PROJECT_ROOT,
  performanceEvidenceBindingDigest,
  resolveArtifactDirectory,
  validateMilestoneSummary,
} from './core-loop-contract.mjs';
import {
  EXPECTED_PERFORMANCE_COMPARISON_VERSION,
  PERFORMANCE_HARNESS_VERSION,
  frameHistogramQuantile,
  mergeFrameIntervalHistograms,
  performanceProtocolIdentity,
  recomputePerformanceSoak,
  validatePerformanceSample,
} from './core-loop-performance.mjs';

export const PERFORMANCE_COMPARISON_VERSION = EXPECTED_PERFORMANCE_COMPARISON_VERSION;
export const PERFORMANCE_BLOCK_MS = 10_000;
export const PERFORMANCE_EVIDENCE_BINDING_VERSION =
  'core-loop-performance-evidence-binding-v2';

const modulePath = fileURLToPath(import.meta.url);
const RUN_SAMPLES_BYTES = Symbol('runSamplesBytes');
const COMPARISON_ARTIFACT_BYTES = Symbol('comparisonArtifactBytes');
const VERIFIED_PERFORMANCE_EVIDENCE = new WeakMap();
const PHASE_ORDER = Object.freeze(['idle', 'active', 'recovery', 'soak']);
const PROTOCOL_KEYS = new Set([
  'petCounts', 'repetitions', 'warmupMs', 'idleMs', 'activeMs', 'recoveryMs',
  'soakPets', 'soakWarmupMs', 'soakMs', 'sampleIntervalMs',
]);
const HARDWARE_KEYS = new Set(['logicalCpuBucket', 'memoryGiBBucket']);
const COMPARISON_KEYS = new Set([
  'schemaVersion', 'comparisonVersion', 'generatedAt', 'before', 'after',
  'hardwareClass', 'protocol', 'pairing', 'metricResults', 'hardChecks',
  'statisticalRegressionCount', 'hardRegressionCount', 'regressionDetected',
  'runIdentity', 'sameMachineAttested', 'claimEligible', 'status', 'evidenceBoundaries',
  'milestoneProjection',
]);
const ENDPOINT_KEYS = new Set([
  'gitSha', 'protocolQualified', 'sourceClean', 'harnessSourceClean', 'environmentValid',
]);
const RUN_PROVENANCE_KEYS = new Set([
  'identityVersion', 'appGitSha', 'harnessGitSha', 'harnessSourceClean',
  'harnessVersion', 'performanceHarnessVersion', 'comparisonVersion', 'probeIdentity',
  'probeSourceSha256', 'fixtureIdentity', 'settingsIdentity', 'protocolIdentity',
  'environmentIdentity', 'driverNodeVersion', 'electronVersion', 'electronNodeVersion',
]);
const COMMON_RUN_IDENTITY_KEYS = new Set([
  'identityVersion', 'harnessGitSha', 'harnessVersion', 'performanceHarnessVersion',
  'comparisonVersion', 'probeIdentity', 'probeSourceSha256', 'fixtureIdentity',
  'settingsIdentity', 'protocolIdentity', 'driverNodeVersion', 'electronVersion',
  'electronNodeVersion', 'environmentIdentity',
]);
const PAIRING_KEYS = new Set([
  'blockMs', 'pairedBlocks', 'bootstrapSamples', 'bootstrapSeed',
]);
const METRIC_RESULT_KEYS = new Set([
  'metric', 'unit', 'topology', 'phase', 'processType', 'processSlot',
  'pairCount', 'beforeMedian', 'afterMedian', 'changeKind', 'noiseFloor',
  'medianChange', 'confidenceLower95', 'confidenceUpper95', 'threshold',
  'regression',
]);
const HARD_CHECK_KEYS = new Set([
  'rule', 'beforeValue', 'afterValue', 'limit', 'regression',
]);
const MILESTONE_PROJECTION_KEYS = new Set([
  'comparisonVersion', 'status', 'claimEligible', 'regressionDetected',
  'sameMachineAttested', 'beforeGitSha', 'afterGitSha',
]);
const METRIC_DEFINITIONS = Object.freeze([
  Object.freeze({
    metric: 'cpuPercent', unit: 'percentage_points', noiseFloor: 1,
    changeKind: 'relative', threshold: PERFORMANCE_PROTOCOL.relativeRegression,
    applies: () => true,
    aggregate: samples => mean(samples.map(sample => sample.cpuPercent)),
  }),
  Object.freeze({
    metric: 'memoryMiB', unit: 'MiB', noiseFloor: 1,
    changeKind: 'relative', threshold: PERFORMANCE_PROTOCOL.relativeRegression,
    applies: () => true,
    aggregate: samples => mean(samples.map(sample => sample.memoryMiB)),
  }),
  Object.freeze({
    metric: 'frameIntervalP95Ms', unit: 'ms', noiseFloor: 0.1,
    changeKind: 'relative', threshold: PERFORMANCE_PROTOCOL.relativeRegression,
    applies: block => block.processType === 'renderer',
    aggregate: samples => frameHistogramQuantile(mergeFrameIntervalHistograms(samples), 0.95),
  }),
  Object.freeze({
    metric: 'renderWorkMs', unit: 'ms', noiseFloor: 0.1,
    changeKind: 'relative', threshold: PERFORMANCE_PROTOCOL.relativeRegression,
    applies: block => block.processType === 'renderer',
    aggregate: samples => mean(samples.map(sample => sample.renderWorkMs)
      .filter(Number.isFinite)),
  }),
  Object.freeze({
    metric: 'eventLoopStallRatePoints', unit: 'percentage_points', noiseFloor: 0.1,
    changeKind: 'relative', threshold: PERFORMANCE_PROTOCOL.relativeRegression,
    applies: () => true,
    aggregate: samples => percentage(samples.filter(sample =>
      sample.eventLoopStallMs >= PERFORMANCE_PROTOCOL.eventLoopStallMs).length, samples.length),
  }),
  Object.freeze({
    metric: 'longFrameRatePoints', unit: 'percentage_points', noiseFloor: 0.1,
    changeKind: 'absolute_points', threshold: PERFORMANCE_PROTOCOL.longFrameRatePoints,
    applies: block => block.processType === 'renderer',
    aggregate: samples => {
      const intervals = samples.reduce((sum, sample) => sum + sample.frameIntervalSampleCount, 0);
      const longFrames = samples.reduce((sum, sample) => sum + sample.longFrameCount, 0);
      return percentage(longFrames, intervals);
    },
  }),
]);

function comparisonError(message) {
  const error = new Error(message);
  error.code = 'POPPET_PERFORMANCE_COMPARISON';
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) comparisonError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) comparisonError(`${label} unknown key: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) comparisonError(`${label} missing key: ${key}`);
  }
}

function finite(value, label) {
  if (!Number.isFinite(value)) comparisonError(`${label} must be finite`);
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) comparisonError(`${label} must be a non-negative integer`);
}

function sameJson(left, right) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical(value[key])]));
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function percentage(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function quantile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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

function swap(values, left, right) {
  const temporary = values[left];
  values[left] = values[right];
  values[right] = temporary;
}

function select(values, wanted) {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = values[(left + right) >>> 1];
    let low = left;
    let high = right;
    while (low <= high) {
      while (values[low] < pivot) low++;
      while (values[high] > pivot) high--;
      if (low <= high) {
        swap(values, low, high);
        low++;
        high--;
      }
    }
    if (wanted <= high) right = high;
    else if (wanted >= low) left = low;
    else return values[wanted];
  }
  return values[wanted];
}

function medianInPlace(values) {
  const upperIndex = values.length >>> 1;
  const upper = select(values, upperIndex);
  if (values.length % 2) return upper;
  const lower = select(values, upperIndex - 1);
  return (lower + upper) / 2;
}

function pairedBootstrapMedian95(changes) {
  if (!changes.length) comparisonError('paired bootstrap requires at least one pair');
  const random = seededRandom(PERFORMANCE_PROTOCOL.bootstrapSeed);
  const working = new Float64Array(changes.length);
  const estimates = new Array(PERFORMANCE_PROTOCOL.bootstrapSamples);
  for (let iteration = 0; iteration < PERFORMANCE_PROTOCOL.bootstrapSamples; iteration++) {
    for (let index = 0; index < working.length; index++) {
      working[index] = changes[Math.floor(random() * changes.length)];
    }
    estimates[iteration] = medianInPlace(working);
  }
  return {
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
  };
}

function protocolMatchesLocked(protocol) {
  return sameJson(protocol.petCounts, PERFORMANCE_PROTOCOL.petCounts)
    && protocol.repetitions === PERFORMANCE_PROTOCOL.repetitions
    && protocol.warmupMs === PERFORMANCE_PROTOCOL.warmupMs
    && protocol.idleMs === PERFORMANCE_PROTOCOL.idleMs
    && protocol.activeMs === PERFORMANCE_PROTOCOL.activeMs
    && protocol.recoveryMs === PERFORMANCE_PROTOCOL.recoveryMs
    && protocol.soakPets === PERFORMANCE_PROTOCOL.soakPets
    && protocol.soakWarmupMs === PERFORMANCE_PROTOCOL.soakWarmupMs
    && protocol.soakMs === PERFORMANCE_PROTOCOL.soakMs
    && protocol.sampleIntervalMs === PERFORMANCE_PROTOCOL.sampleIntervalMs;
}

function validateProtocol(protocol, qualified, label) {
  exactKeys(protocol, PROTOCOL_KEYS, `${label} protocol`);
  if (!sameJson(protocol.petCounts, PERFORMANCE_PROTOCOL.petCounts)) {
    comparisonError(`${label} protocol petCounts are not the locked 1/3/6 matrix`);
  }
  for (const key of [
    'repetitions', 'warmupMs', 'idleMs', 'activeMs', 'recoveryMs',
    'soakPets', 'soakWarmupMs', 'soakMs', 'sampleIntervalMs',
  ]) {
    if (!Number.isSafeInteger(protocol[key]) || protocol[key] < 1) {
      comparisonError(`${label} protocol ${key} is invalid`);
    }
  }
  if (protocol.soakPets !== PERFORMANCE_PROTOCOL.soakPets) {
    comparisonError(`${label} protocol soakPets is not locked at 6`);
  }
  if (typeof qualified !== 'boolean') comparisonError(`${label} protocolQualified is invalid`);
  if (qualified && !protocolMatchesLocked(protocol)) {
    comparisonError(`${label} claims qualification for an unlocked protocol`);
  }
}

function validateHardwareClass(hardwareClass, label) {
  exactKeys(hardwareClass, HARDWARE_KEYS, `${label} hardwareClass`);
  for (const key of HARDWARE_KEYS) {
    if (typeof hardwareClass[key] !== 'string' || !/^[0-9>-]+$/.test(hardwareClass[key])) {
      comparisonError(`${label} hardwareClass ${key} is invalid`);
    }
  }
}

function versionString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+/.test(value)) {
    comparisonError(`${label} is invalid`);
  }
}

function digestString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    comparisonError(`${label} is invalid`);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    comparisonError(`${label} is not valid UTF-8`);
  }
}

function parseJsonLines(bytes, label = 'samples.jsonl') {
  const text = decodeUtf8(bytes, label);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) comparisonError(`${label} is empty`);
  return lines.map((rawLine, index) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) comparisonError(`${label} line ${index + 1} is blank`);
    try {
      return JSON.parse(line);
    } catch {
      comparisonError(`${label} line ${index + 1} is invalid JSON`);
    }
  });
}

function validateRunProvenance(provenance, summary, performance, label) {
  exactKeys(provenance, RUN_PROVENANCE_KEYS, `${label} provenance`);
  if (provenance.identityVersion !== 'core-loop-performance-run-identity-v1'
      || provenance.appGitSha !== summary.gitSha
      || !/^[0-9a-f]{40}$/.test(provenance.harnessGitSha)
      || typeof provenance.harnessSourceClean !== 'boolean'
      || provenance.harnessVersion !== 'core-loop-harness-v1'
      || provenance.performanceHarnessVersion !== PERFORMANCE_HARNESS_VERSION
      || provenance.comparisonVersion !== PERFORMANCE_COMPARISON_VERSION
      || typeof provenance.probeIdentity !== 'string'
      || provenance.probeIdentity.length < 1 || provenance.probeIdentity.length > 80) {
    comparisonError(`${label} provenance identity is invalid`);
  }
  digestString(provenance.probeSourceSha256, `${label} probeSourceSha256`, { nullable: true });
  digestString(provenance.fixtureIdentity, `${label} fixtureIdentity`, { nullable: true });
  digestString(provenance.settingsIdentity, `${label} settingsIdentity`, { nullable: true });
  digestString(provenance.environmentIdentity, `${label} environmentIdentity`, { nullable: true });
  digestString(provenance.protocolIdentity, `${label} protocolIdentity`);
  versionString(provenance.driverNodeVersion, `${label} driverNodeVersion`);
  versionString(provenance.electronVersion, `${label} electronVersion`, { nullable: true });
  versionString(provenance.electronNodeVersion, `${label} electronNodeVersion`, { nullable: true });
  if (provenance.protocolIdentity !== performanceProtocolIdentity(performance.protocol)) {
    comparisonError(`${label} protocol identity does not match its recorded configuration`);
  }
  if (performance.protocolQualified
      && (!provenance.harnessSourceClean
        || provenance.probeIdentity !== 'poppet-core-loop-electron-probe-v3'
        || provenance.probeSourceSha256 === null || provenance.fixtureIdentity === null
        || provenance.settingsIdentity === null || provenance.environmentIdentity === null
        || provenance.electronVersion === null
        || provenance.electronNodeVersion === null)) {
    comparisonError(`${label} qualified summary lacks complete clean default-probe provenance`);
  }
  return provenance;
}

function validateRunSummary(summary, label) {
  validateMilestoneSummary(summary);
  if (!summary.gitSha || !/^[0-9a-f]{40}$/.test(summary.gitSha)) {
    comparisonError(`${label} summary is missing a Git SHA`);
  }
  const performance = summary.performanceSummary;
  if (!isPlainObject(performance)) comparisonError(`${label} summary is missing performanceSummary`);
  validateHardwareClass(performance.hardwareClass, label);
  validateProtocol(performance.protocol, performance.protocolQualified, label);
  if (!isPlainObject(performance.provenance)) {
    comparisonError(`${label} summary is missing performance provenance`);
  }
  validateRunProvenance(performance.provenance, summary, performance, label);
  if (performance.sourceDirty !== null && typeof performance.sourceDirty !== 'boolean') {
    comparisonError(`${label} sourceDirty is invalid`);
  }
  if (!isPlainObject(performance.soak)
      || !isPlainObject(performance.soak.memoryTrend)
      || !isPlainObject(performance.soak.resourceTrend)) {
    comparisonError(`${label} summary is missing soak trend evidence`);
  }
  const memory = performance.soak.memoryTrend;
  const resources = performance.soak.resourceTrend;
  if (!['AVAILABLE', 'UNAVAILABLE'].includes(memory.status)
      || !['AVAILABLE', 'UNAVAILABLE'].includes(resources.status)) {
    comparisonError(`${label} soak trend status is invalid`);
  }
  if (memory.regressionDetected !== null && typeof memory.regressionDetected !== 'boolean') {
    comparisonError(`${label} soak memory regression result is invalid`);
  }
  if (resources.sustainedGrowthDetected !== null
      && typeof resources.sustainedGrowthDetected !== 'boolean') {
    comparisonError(`${label} soak resource result is invalid`);
  }
  if (performance.protocolQualified
      && (memory.status !== 'AVAILABLE' || resources.status !== 'AVAILABLE'
        || typeof memory.regressionDetected !== 'boolean'
        || typeof resources.sustainedGrowthDetected !== 'boolean')) {
    comparisonError(`${label} qualified summary has unavailable soak evidence`);
  }
  return performance;
}

function phaseDuration(protocol, phase) {
  if (phase === 'idle') return protocol.idleMs;
  if (phase === 'active') return protocol.activeMs;
  if (phase === 'recovery') return protocol.recoveryMs;
  if (phase === 'soak') return protocol.soakMs;
  comparisonError(`Unknown phase: ${phase}`);
}

function blockPosition(elapsedMs, durationMs) {
  const bounded = Math.min(elapsedMs, durationMs);
  return Math.max(0, Math.ceil(bounded / PERFORMANCE_BLOCK_MS) - 1);
}

function processIdentities(topology, phase) {
  const identities = [{ processType: 'main', processSlot: 0 }];
  if (phase !== 'recovery') {
    for (let processSlot = 1; processSlot <= topology; processSlot++) {
      identities.push({ processType: 'renderer', processSlot });
    }
  }
  return identities;
}

function blockKey(block) {
  return [block.topology, block.phase, block.repetition, block.processType,
    block.processSlot, block.position].join('|');
}

function seriesKey(block) {
  return [block.topology, block.phase, block.processType, block.processSlot].join('|');
}

function expectedBlocks(protocol) {
  const expected = new Map();
  const add = (topology, phase, repetition) => {
    const count = Math.ceil(phaseDuration(protocol, phase) / PERFORMANCE_BLOCK_MS);
    for (const identity of processIdentities(topology, phase)) {
      for (let position = 0; position < count; position++) {
        const block = { topology, phase, repetition, ...identity, position };
        expected.set(blockKey(block), block);
      }
    }
  };
  for (const topology of protocol.petCounts) {
    for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
      for (const phase of ['idle', 'active', 'recovery']) add(topology, phase, repetition);
    }
  }
  add(protocol.soakPets, 'soak', 1);
  return expected;
}

function temporalPosition(elapsedMs, durationMs, bucketMs) {
  const count = Math.ceil(durationMs / bucketMs);
  return Math.min(count - 1,
    Math.max(0, Math.ceil(Math.min(elapsedMs, durationMs) / bucketMs) - 1));
}

function assertRawTemporalCoverage(samples, protocol, qualified, label) {
  const scenarios = [];
  for (const topology of protocol.petCounts) {
    for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
      for (const phase of ['idle', 'active', 'recovery']) {
        for (const identity of processIdentities(topology, phase)) {
          scenarios.push({ topology, repetition, phase, ...identity });
        }
      }
    }
  }
  for (const identity of processIdentities(protocol.soakPets, 'soak')) {
    scenarios.push({ topology: protocol.soakPets, repetition: 1, phase: 'soak', ...identity });
  }

  for (const scenario of scenarios) {
    const durationMs = phaseDuration(protocol, scenario.phase);
    const selected = samples.filter(sample => sample.topology === scenario.topology
      && sample.repetition === scenario.repetition && sample.phase === scenario.phase
      && sample.processType === scenario.processType && sample.processSlot === scenario.processSlot)
      .sort((left, right) => left.elapsedMs - right.elapsedMs);
    const seriesLabel = `${label} ${seriesKey(scenario)} repetition ${scenario.repetition}`;
    if (!selected.length) comparisonError(`${seriesLabel} is missing`);
    const tolerance = Math.max(250, protocol.sampleIntervalMs * (qualified ? 0.35 : 1.25));
    if (selected[0].elapsedMs > protocol.sampleIntervalMs + tolerance
        || selected.at(-1).elapsedMs < durationMs - protocol.sampleIntervalMs - tolerance) {
      comparisonError(`${seriesLabel} lacks start/end temporal coverage`);
    }
    for (let index = 1; index < selected.length; index++) {
      const gap = selected[index].elapsedMs - selected[index - 1].elapsedMs;
      if (gap <= 0 || (qualified && gap > protocol.sampleIntervalMs + tolerance)) {
        comparisonError(`${seriesLabel} violates the recorded cadence`);
      }
    }
    if (qualified && scenario.processType === 'renderer'
        && selected.some(sample => sample.frameIntervalSampleCount < 1
          || sample.frameIntervalHistogram.overflowCount > 0
          || !Number.isFinite(sample.frameIntervalP50Ms)
          || !Number.isFinite(sample.frameIntervalP95Ms)
          || !Number.isFinite(sample.frameIntervalP99Ms))) {
      comparisonError(`${seriesLabel} lacks bounded frame-interval evidence`);
    }

    const blockCount = Math.ceil(durationMs / PERFORMANCE_BLOCK_MS);
    for (let position = 0; position < blockCount; position++) {
      const inBlock = selected.filter(sample =>
        temporalPosition(sample.elapsedMs, durationMs, PERFORMANCE_BLOCK_MS) === position);
      const blockDuration = Math.min(PERFORMANCE_BLOCK_MS,
        durationMs - position * PERFORMANCE_BLOCK_MS);
      const expected = Math.max(1, Math.floor(blockDuration / protocol.sampleIntervalMs));
      const required = qualified ? Math.max(1, expected - 2) : 1;
      if (inBlock.length < required) {
        comparisonError(`${seriesLabel} is sparse in 10-second block ${position}`);
      }
    }
  }

  if (qualified) {
    const groups = [];
    for (const topology of protocol.petCounts) {
      for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
        for (const phase of ['idle', 'active', 'recovery']) {
          groups.push({ topology, repetition, phase });
        }
      }
    }
    groups.push({ topology: protocol.soakPets, repetition: 1, phase: 'soak' });
    for (const group of groups) {
      const momentsFor = identity => samples.filter(sample => sample.topology === group.topology
        && sample.repetition === group.repetition && sample.phase === group.phase
        && sample.processType === identity.processType && sample.processSlot === identity.processSlot)
        .map(sample => sample.elapsedMs).sort((left, right) => left - right);
      const expectedMoments = momentsFor({ processType: 'main', processSlot: 0 });
      for (const identity of processIdentities(group.topology, group.phase)) {
        if (!sameJson(momentsFor(identity), expectedMoments)) {
          comparisonError(`${label} ${group.topology}|${group.phase}|${group.repetition} lacks complete same-tick process snapshots`);
        }
      }
    }
  }

  // A memory/resource trend is only meaningful when every configured soak
  // minute contains every process slot with start/end coverage. Apply this to
  // smoke inputs too; shorter smoke durations simply have one partial minute.
  const minuteCount = Math.ceil(protocol.soakMs / 60_000);
  for (let minute = 0; minute < minuteCount; minute++) {
    const start = minute * 60_000;
    const end = Math.min(protocol.soakMs, start + 60_000);
    const minuteDuration = end - start;
    for (const identity of processIdentities(protocol.soakPets, 'soak')) {
      const selected = samples.filter(sample => sample.phase === 'soak'
        && sample.processType === identity.processType && sample.processSlot === identity.processSlot
        && temporalPosition(sample.elapsedMs, protocol.soakMs, 60_000) === minute)
        .sort((left, right) => left.elapsedMs - right.elapsedMs);
      if (!selected.length) {
        comparisonError(`${label} soak minute ${minute} is missing ${identity.processType}:${identity.processSlot}`);
      }
      const expected = Math.max(1, Math.floor(minuteDuration / protocol.sampleIntervalMs));
      const required = qualified ? Math.max(1, expected - 5) : 1;
      const tolerance = Math.max(250, protocol.sampleIntervalMs * (qualified ? 0.35 : 1.25));
      if (selected.length < required
          || selected[0].elapsedMs > start + protocol.sampleIntervalMs + tolerance
          || selected.at(-1).elapsedMs < end - protocol.sampleIntervalMs - tolerance) {
        comparisonError(`${label} soak minute ${minute} lacks dense temporal coverage for ${identity.processType}:${identity.processSlot}`);
      }
    }
  }
}

function assertRecordedSoakMatchesRaw(recorded, recomputed, label) {
  const check = (actual, expected, location) => {
    if (isPlainObject(expected)) {
      if (!isPlainObject(actual)) comparisonError(`${label} ${location} is missing`);
      for (const [key, value] of Object.entries(expected)) check(actual[key], value, `${location}.${key}`);
      return;
    }
    if (typeof expected === 'number' && typeof actual === 'number') {
      if (Math.abs(actual - expected) > 1e-9) comparisonError(`${label} ${location} disagrees with raw samples`);
      return;
    }
    if (!sameJson(actual, expected)) comparisonError(`${label} ${location} disagrees with raw samples`);
  };
  check(recorded, recomputed, 'soak');
}

function validateAndAggregateRun(samples, summary, performance, label) {
  if (!Array.isArray(samples) || !samples.length) comparisonError(`${label} samples are empty`);
  const protocol = performance.protocol;
  const expected = expectedBlocks(protocol);
  const grouped = new Map();
  const runIds = new Set();
  const seenMoments = new Set();
  for (const sample of samples) {
    validatePerformanceSample(sample);
    if (sample.gitSha !== summary.gitSha) comparisonError(`${label} sample Git SHA does not match summary`);
    runIds.add(sample.runId);
    const scenarioPhase = sample.phase !== 'soak';
    const validScenario = scenarioPhase
      && protocol.petCounts.includes(sample.topology)
      && sample.repetition >= 1 && sample.repetition <= protocol.repetitions;
    const validSoak = sample.phase === 'soak'
      && sample.topology === protocol.soakPets && sample.repetition === 1;
    if (!validScenario && !validSoak) comparisonError(`${label} sample is outside the recorded protocol`);
    const allowedIdentity = processIdentities(sample.topology, sample.phase)
      .some(value => value.processType === sample.processType && value.processSlot === sample.processSlot);
    if (!allowedIdentity) comparisonError(`${label} sample has an unexpected process identity`);
    const durationMs = phaseDuration(protocol, sample.phase);
    const jitterLimit = durationMs + Math.max(250, protocol.sampleIntervalMs * 2);
    if (sample.elapsedMs > jitterLimit) comparisonError(`${label} sample elapsedMs exceeds its phase`);
    const position = blockPosition(sample.elapsedMs, durationMs);
    const block = {
      topology: sample.topology,
      phase: sample.phase,
      repetition: sample.repetition,
      processType: sample.processType,
      processSlot: sample.processSlot,
      position,
    };
    const key = blockKey(block);
    if (!expected.has(key)) comparisonError(`${label} sample has an unexpected 10-second position`);
    const moment = `${key}|${sample.elapsedMs}`;
    if (seenMoments.has(moment)) comparisonError(`${label} contains a duplicate process sample`);
    seenMoments.add(moment);
    if (!grouped.has(key)) grouped.set(key, { ...block, samples: [] });
    grouped.get(key).samples.push(sample);
  }
  if (runIds.size !== 1) comparisonError(`${label} samples must belong to exactly one runId`);
  assertRawTemporalCoverage(samples, protocol, performance.protocolQualified, label);
  for (const [key] of expected) {
    if (!grouped.has(key)) comparisonError(`${label} is missing required 10-second block ${key}`);
  }
  if (grouped.size !== expected.size) comparisonError(`${label} contains unexpected 10-second blocks`);

  const recomputedSoak = recomputePerformanceSoak(samples, protocol);
  assertRecordedSoakMatchesRaw(performance.soak, recomputedSoak, label);

  const blocks = new Map();
  for (const [key, block] of grouped) {
    const metrics = {};
    for (const definition of METRIC_DEFINITIONS) {
      if (!definition.applies(block)) continue;
      const value = definition.aggregate(block.samples);
      if (!Number.isFinite(value)) {
        comparisonError(`${label} block ${key} cannot produce ${definition.metric}`);
      }
      metrics[definition.metric] = value;
    }
    blocks.set(key, { ...block, metrics });
  }
  return { blocks, recomputedSoak };
}

function assertSameBlocks(beforeBlocks, afterBlocks) {
  if (beforeBlocks.size !== afterBlocks.size) comparisonError('before/after block counts differ');
  for (const key of beforeBlocks.keys()) {
    if (!afterBlocks.has(key)) comparisonError(`after run is missing paired block ${key}`);
  }
  for (const key of afterBlocks.keys()) {
    if (!beforeBlocks.has(key)) comparisonError(`before run is missing paired block ${key}`);
  }
}

function metricSort(left, right) {
  return left.topology - right.topology
    || PHASE_ORDER.indexOf(left.phase) - PHASE_ORDER.indexOf(right.phase)
    || left.processType.localeCompare(right.processType)
    || left.processSlot - right.processSlot
    || left.metric.localeCompare(right.metric);
}

function compareMetrics(beforeBlocks, afterBlocks) {
  const groups = new Map();
  for (const [key, before] of beforeBlocks) {
    const after = afterBlocks.get(key);
    for (const definition of METRIC_DEFINITIONS) {
      if (!(definition.metric in before.metrics) || !(definition.metric in after.metrics)) continue;
      const groupKey = `${seriesKey(before)}|${definition.metric}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { definition, before, pairs: [] });
      groups.get(groupKey).pairs.push({
        repetition: before.repetition,
        position: before.position,
        before: before.metrics[definition.metric],
        after: after.metrics[definition.metric],
      });
    }
  }
  const results = [];
  for (const group of groups.values()) {
    group.pairs.sort((left, right) => left.repetition - right.repetition
      || left.position - right.position);
    const { definition, before } = group;
    const changes = group.pairs.map(pair => definition.changeKind === 'absolute_points'
      ? pair.after - pair.before
      : (pair.after - pair.before) / Math.max(Math.abs(pair.before), definition.noiseFloor));
    const medianChange = median(changes);
    const confidence = pairedBootstrapMedian95(changes);
    results.push({
      metric: definition.metric,
      unit: definition.unit,
      topology: before.topology,
      phase: before.phase,
      processType: before.processType,
      processSlot: before.processSlot,
      pairCount: group.pairs.length,
      beforeMedian: median(group.pairs.map(pair => pair.before)),
      afterMedian: median(group.pairs.map(pair => pair.after)),
      changeKind: definition.changeKind,
      noiseFloor: definition.noiseFloor,
      medianChange,
      confidenceLower95: confidence.lower,
      confidenceUpper95: confidence.upper,
      threshold: definition.threshold,
      regression: medianChange > definition.threshold && confidence.lower > 0,
    });
  }
  return results.sort(metricSort);
}

function hardObservations(samples, recomputedSoak) {
  const recovery = samples.filter(sample => sample.phase === 'recovery');
  const wrongPets = samples.filter(sample => sample.petCount
    !== (sample.phase === 'recovery' ? 0 : sample.topology)).length;
  const wrongWindows = samples.filter(sample => sample.windowCount
    !== (sample.phase === 'recovery' ? 0 : sample.topology)).length;
  const valueOrZero = values => values.length ? Math.max(...values) : 0;
  return {
    crashes: samples.reduce((sum, sample) => sum + sample.crashCount, 0),
    unhandledErrors: samples.reduce((sum, sample) => sum + sample.unhandledErrorCount, 0),
    wrongPetObservations: wrongPets,
    wrongWindowObservations: wrongWindows,
    recoveryTimerDeltaMax: valueOrZero(recovery.map(sample => sample.timerCount)
      .filter(Number.isInteger)),
    recoveryListenerDeltaMax: valueOrZero(recovery.map(sample => sample.listenerCount)
      .filter(Number.isInteger)),
    soakMemoryRegression: recomputedSoak.memoryTrend.regressionDetected === true ? 1 : 0,
    soakResourceGrowth: recomputedSoak.resourceTrend.sustainedGrowthDetected === true ? 1 : 0,
  };
}

function compareHardRules(beforeSamples, afterSamples, beforeSoak, afterSoak) {
  const before = hardObservations(beforeSamples, beforeSoak);
  const after = hardObservations(afterSamples, afterSoak);
  const rules = [
    ['CRASH_COUNT', 'crashes'],
    ['UNHANDLED_ERROR_COUNT', 'unhandledErrors'],
    ['PET_COUNT_MISMATCH_OBSERVATIONS', 'wrongPetObservations'],
    ['WINDOW_COUNT_MISMATCH_OBSERVATIONS', 'wrongWindowObservations'],
    ['RECOVERY_TIMER_DELTA_MAX', 'recoveryTimerDeltaMax'],
    ['RECOVERY_LISTENER_DELTA_MAX', 'recoveryListenerDeltaMax'],
    ['SOAK_MEMORY_REGRESSION', 'soakMemoryRegression'],
    ['SOAK_RESOURCE_GROWTH', 'soakResourceGrowth'],
  ];
  return rules.map(([rule, key]) => ({
    rule,
    beforeValue: before[key],
    afterValue: after[key],
    limit: 0,
    regression: after[key] > 0,
  }));
}

function assertComparisonPrivacySafe(value, label = 'comparison') {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    comparisonError(`${label} contains binary data`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertComparisonPrivacySafe(entry, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:path|filename|runId|pid|url)$/i.test(key)) {
        comparisonError(`${label} contains a forbidden identifying key`);
      }
      assertComparisonPrivacySafe(entry, `${label}.${key}`);
    }
    return;
  }
  if (typeof value === 'string'
      && /(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|\\\\[^\s\\]+\\|(?:^|\s)\/(?:Users|home|private|tmp|var)\/)/i.test(value)) {
    comparisonError(`${label} contains a path or network address`);
  }
}

export function validatePerformanceComparison(comparison) {
  assertComparisonPrivacySafe(comparison);
  exactKeys(comparison, COMPARISON_KEYS, 'performance comparison');
  if (comparison.schemaVersion !== '1.0.0'
      || comparison.comparisonVersion !== PERFORMANCE_COMPARISON_VERSION) {
    comparisonError('performance comparison version is invalid');
  }
  if (!Number.isFinite(Date.parse(comparison.generatedAt))) comparisonError('generatedAt is invalid');
  for (const endpoint of ['before', 'after']) {
    exactKeys(comparison[endpoint], ENDPOINT_KEYS, endpoint);
    if (!/^[0-9a-f]{40}$/.test(comparison[endpoint].gitSha)) comparisonError(`${endpoint} Git SHA is invalid`);
    if (typeof comparison[endpoint].protocolQualified !== 'boolean'
        || typeof comparison[endpoint].sourceClean !== 'boolean'
        || typeof comparison[endpoint].harnessSourceClean !== 'boolean'
        || typeof comparison[endpoint].environmentValid !== 'boolean') {
      comparisonError(`${endpoint} flags are invalid`);
    }
  }
  exactKeys(comparison.runIdentity, COMMON_RUN_IDENTITY_KEYS, 'runIdentity');
  if (comparison.runIdentity.identityVersion !== 'core-loop-performance-run-identity-v1'
      || !/^[0-9a-f]{40}$/.test(comparison.runIdentity.harnessGitSha)
      || comparison.runIdentity.harnessVersion !== 'core-loop-harness-v1'
      || comparison.runIdentity.performanceHarnessVersion !== PERFORMANCE_HARNESS_VERSION
      || comparison.runIdentity.comparisonVersion !== PERFORMANCE_COMPARISON_VERSION
      || typeof comparison.runIdentity.probeIdentity !== 'string'
      || comparison.runIdentity.probeIdentity.length < 1
      || comparison.runIdentity.probeIdentity.length > 80) {
    comparisonError('comparison runIdentity is invalid');
  }
  for (const key of ['probeSourceSha256', 'fixtureIdentity', 'settingsIdentity', 'environmentIdentity']) {
    digestString(comparison.runIdentity[key], `runIdentity.${key}`, { nullable: true });
  }
  digestString(comparison.runIdentity.protocolIdentity, 'runIdentity.protocolIdentity');
  if (comparison.runIdentity.protocolIdentity !== performanceProtocolIdentity(comparison.protocol)) {
    comparisonError('runIdentity protocolIdentity does not match comparison protocol');
  }
  versionString(comparison.runIdentity.driverNodeVersion, 'runIdentity.driverNodeVersion');
  versionString(comparison.runIdentity.electronVersion, 'runIdentity.electronVersion', { nullable: true });
  versionString(comparison.runIdentity.electronNodeVersion,
    'runIdentity.electronNodeVersion', { nullable: true });
  if (typeof comparison.sameMachineAttested !== 'boolean') {
    comparisonError('sameMachineAttested must be boolean');
  }
  if (comparison.before.protocolQualified !== comparison.after.protocolQualified) {
    comparisonError('comparison endpoint protocol qualification differs');
  }
  validateHardwareClass(comparison.hardwareClass, 'comparison');
  validateProtocol(comparison.protocol,
    comparison.before.protocolQualified && comparison.after.protocolQualified, 'comparison');
  exactKeys(comparison.pairing, PAIRING_KEYS, 'pairing');
  if (comparison.pairing.blockMs !== PERFORMANCE_BLOCK_MS
      || comparison.pairing.bootstrapSamples !== PERFORMANCE_PROTOCOL.bootstrapSamples
      || comparison.pairing.bootstrapSeed !== PERFORMANCE_PROTOCOL.bootstrapSeed) {
    comparisonError('comparison statistical constants are invalid');
  }
  nonNegativeInteger(comparison.pairing.pairedBlocks, 'pairedBlocks');
  if (!Array.isArray(comparison.metricResults) || !comparison.metricResults.length) {
    comparisonError('metricResults must be non-empty');
  }
  for (const [index, result] of comparison.metricResults.entries()) {
    exactKeys(result, METRIC_RESULT_KEYS, `metricResults[${index}]`);
    for (const key of [
      'topology', 'processSlot', 'pairCount', 'beforeMedian', 'afterMedian',
      'noiseFloor', 'medianChange', 'confidenceLower95', 'confidenceUpper95', 'threshold',
    ]) finite(result[key], `metricResults[${index}].${key}`);
    if (typeof result.regression !== 'boolean') comparisonError('metric regression flag is invalid');
  }
  if (!Array.isArray(comparison.hardChecks)) comparisonError('hardChecks must be an array');
  for (const [index, check] of comparison.hardChecks.entries()) {
    exactKeys(check, HARD_CHECK_KEYS, `hardChecks[${index}]`);
    for (const key of ['beforeValue', 'afterValue', 'limit']) finite(check[key], `hardChecks[${index}].${key}`);
    if (typeof check.regression !== 'boolean') comparisonError('hard regression flag is invalid');
  }
  nonNegativeInteger(comparison.statisticalRegressionCount, 'statisticalRegressionCount');
  nonNegativeInteger(comparison.hardRegressionCount, 'hardRegressionCount');
  if (typeof comparison.regressionDetected !== 'boolean'
      || typeof comparison.claimEligible !== 'boolean'
      || !Array.isArray(comparison.evidenceBoundaries)) comparisonError('comparison aggregate flags are invalid');
  if (!['REGRESSION', 'NO_REGRESSION_DETECTED', 'SMOKE_ONLY'].includes(comparison.status)) {
    comparisonError('comparison status is invalid');
  }
  exactKeys(comparison.milestoneProjection, MILESTONE_PROJECTION_KEYS, 'milestoneProjection');
  const expectedProjection = {
    comparisonVersion: comparison.comparisonVersion,
    status: comparison.status,
    claimEligible: comparison.claimEligible,
    regressionDetected: comparison.regressionDetected,
    sameMachineAttested: comparison.sameMachineAttested,
    beforeGitSha: comparison.before.gitSha,
    afterGitSha: comparison.after.gitSha,
  };
  if (!sameJson(comparison.milestoneProjection, expectedProjection)) {
    comparisonError('milestoneProjection disagrees with the comparison result');
  }
  const statisticalCount = comparison.metricResults.filter(result => result.regression).length;
  const hardCount = comparison.hardChecks.filter(check => check.regression).length;
  const regressionDetected = statisticalCount > 0 || hardCount > 0;
  const claimEligible = comparison.before.protocolQualified
    && comparison.before.sourceClean && comparison.after.sourceClean
    && comparison.before.harnessSourceClean && comparison.after.harnessSourceClean
    && comparison.before.environmentValid && comparison.after.environmentValid
    && comparison.sameMachineAttested;
  const expectedStatus = regressionDetected
    ? 'REGRESSION'
    : (claimEligible ? 'NO_REGRESSION_DETECTED' : 'SMOKE_ONLY');
  if (comparison.statisticalRegressionCount !== statisticalCount
      || comparison.hardRegressionCount !== hardCount
      || comparison.regressionDetected !== regressionDetected
      || comparison.claimEligible !== claimEligible
      || comparison.status !== expectedStatus) {
    comparisonError('comparison aggregate verdict is inconsistent');
  }
  return comparison;
}

export function comparePerformanceRuns({
  beforeSamples,
  beforeSummary,
  afterSamples,
  afterSummary,
  sameMachineAttested = false,
  now = new Date(),
} = {}) {
  const beforePerformance = validateRunSummary(beforeSummary, 'before');
  const afterPerformance = validateRunSummary(afterSummary, 'after');
  if (!sameJson(beforePerformance.hardwareClass, afterPerformance.hardwareClass)) {
    comparisonError('before/after hardwareClass differs');
  }
  if (!sameJson(beforePerformance.protocol, afterPerformance.protocol)
      || beforePerformance.protocolQualified !== afterPerformance.protocolQualified) {
    comparisonError('before/after protocol differs');
  }
  const commonIdentity = provenance => Object.fromEntries([...COMMON_RUN_IDENTITY_KEYS]
    .map(key => [key, provenance[key]]));
  const beforeIdentity = commonIdentity(beforePerformance.provenance);
  const afterIdentity = commonIdentity(afterPerformance.provenance);
  if (!sameJson(beforeIdentity, afterIdentity)) {
    comparisonError('before/after Node, Electron, harness, probe, fixture, settings, config, or display/power identity differs');
  }
  if (!beforePerformance.provenance.harnessSourceClean
      || !afterPerformance.provenance.harnessSourceClean) {
    comparisonError('before/after require the same clean committed harness source');
  }
  if (typeof sameMachineAttested !== 'boolean') {
    comparisonError('sameMachineAttested must be boolean');
  }
  const beforeRun = validateAndAggregateRun(
    beforeSamples, beforeSummary, beforePerformance, 'before');
  const afterRun = validateAndAggregateRun(
    afterSamples, afterSummary, afterPerformance, 'after');
  assertSameBlocks(beforeRun.blocks, afterRun.blocks);
  const metricResults = compareMetrics(beforeRun.blocks, afterRun.blocks);
  const hardChecks = compareHardRules(
    beforeSamples, afterSamples, beforeRun.recomputedSoak, afterRun.recomputedSoak);
  const statisticalRegressionCount = metricResults.filter(result => result.regression).length;
  const hardRegressionCount = hardChecks.filter(check => check.regression).length;
  const regressionDetected = statisticalRegressionCount > 0 || hardRegressionCount > 0;
  const protocolQualified = beforePerformance.protocolQualified
    && afterPerformance.protocolQualified;
  const sourceClean = beforePerformance.sourceDirty === false
    && afterPerformance.sourceDirty === false;
  const beforeEnvironmentValid = beforeSummary.failureCounts.ENVIRONMENT_FAILURE === 0;
  const afterEnvironmentValid = afterSummary.failureCounts.ENVIRONMENT_FAILURE === 0;
  const claimEligible = protocolQualified && sourceClean
    && beforeEnvironmentValid && afterEnvironmentValid && sameMachineAttested;
  const status = regressionDetected
    ? 'REGRESSION'
    : (claimEligible ? 'NO_REGRESSION_DETECTED' : 'SMOKE_ONLY');
  const comparison = {
    schemaVersion: '1.0.0',
    comparisonVersion: PERFORMANCE_COMPARISON_VERSION,
    generatedAt: now.toISOString(),
    before: {
      gitSha: beforeSummary.gitSha,
      protocolQualified: beforePerformance.protocolQualified,
      sourceClean: beforePerformance.sourceDirty === false,
      harnessSourceClean: beforePerformance.provenance.harnessSourceClean,
      environmentValid: beforeEnvironmentValid,
    },
    after: {
      gitSha: afterSummary.gitSha,
      protocolQualified: afterPerformance.protocolQualified,
      sourceClean: afterPerformance.sourceDirty === false,
      harnessSourceClean: afterPerformance.provenance.harnessSourceClean,
      environmentValid: afterEnvironmentValid,
    },
    hardwareClass: { ...beforePerformance.hardwareClass },
    protocol: {
      ...beforePerformance.protocol,
      petCounts: [...beforePerformance.protocol.petCounts],
    },
    pairing: {
      blockMs: PERFORMANCE_BLOCK_MS,
      pairedBlocks: beforeRun.blocks.size,
      bootstrapSamples: PERFORMANCE_PROTOCOL.bootstrapSamples,
      bootstrapSeed: PERFORMANCE_PROTOCOL.bootstrapSeed,
    },
    metricResults,
    hardChecks,
    statisticalRegressionCount,
    hardRegressionCount,
    regressionDetected,
    runIdentity: beforeIdentity,
    sameMachineAttested,
    claimEligible,
    status,
    milestoneProjection: {
      comparisonVersion: PERFORMANCE_COMPARISON_VERSION,
      status,
      claimEligible,
      regressionDetected,
      sameMachineAttested,
      beforeGitSha: beforeSummary.gitSha,
      afterGitSha: afterSummary.gitSha,
    },
    evidenceBoundaries: [
      'LOCAL_DEVELOPER_ONLY_AGGREGATE',
      'COARSE_HARDWARE_CLASS_MATCH_ONLY',
      ...(sameMachineAttested
        ? ['SAME_MACHINE_OPERATOR_ATTESTED'] : ['SAME_MACHINE_NOT_ATTESTED']),
      'SAME_CLEAN_COMMITTED_HARNESS_SHA',
      'NODE_ELECTRON_PROBE_FIXTURE_SETTINGS_CONFIG_DISPLAY_POWER_IDENTITY_MATCHED',
      ...(protocolQualified ? ['LOCKED_PROTOCOL'] : ['DURATION_OVERRIDE_SMOKE_ONLY']),
      ...(sourceClean ? ['CLEAN_SOURCE_PAIR'] : ['DIRTY_OR_UNKNOWN_SOURCE_PAIR']),
      ...(beforeEnvironmentValid && afterEnvironmentValid
        ? ['ENVIRONMENT_VALID_PAIR'] : ['ENVIRONMENT_FAILURE_RECORDED']),
      'NO_RAW_SAMPLE_OR_INPUT_IDENTIFIER_INCLUDED',
    ],
  };
  return validatePerformanceComparison(comparison);
}

function readRegularBytes(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) comparisonError(`${label} must be a regular file`);
  return fs.readFileSync(file);
}

function readRegularText(file, label) {
  return decodeUtf8(readRegularBytes(file, label), label);
}

function parseJsonArtifact(bytes, label) {
  try {
    return JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    if (error?.code === 'POPPET_PERFORMANCE_COMPARISON') throw error;
    comparisonError(`${label} is invalid JSON`);
  }
}

function runSampleEvidence(run, label) {
  if (!isPlainObject(run) || !Array.isArray(run.samples) || !isPlainObject(run.summary)) {
    comparisonError(`${label} run evidence is invalid`);
  }
  digestString(run.samplesSha256, `${label} samplesSha256`);
  if (!Number.isSafeInteger(run.sampleCount) || run.sampleCount < 1) {
    comparisonError(`${label} sampleCount must be a positive integer`);
  }
  if (run.sampleCount !== run.samples.length) {
    comparisonError(`${label} sampleCount disagrees with parsed samples`);
  }
  const bytes = run[RUN_SAMPLES_BYTES];
  if (!Buffer.isBuffer(bytes)) {
    comparisonError(`${label} run lacks exact samples.jsonl bytes`);
  }
  if (sha256(bytes) !== run.samplesSha256) {
    comparisonError(`${label} samples.jsonl digest disagrees with its exact bytes`);
  }
  const reparsed = parseJsonLines(bytes);
  if (reparsed.length !== run.sampleCount || !sameJson(reparsed, run.samples)) {
    comparisonError(`${label} parsed samples were changed after reading samples.jsonl`);
  }
  return {
    samplesSha256: run.samplesSha256,
    sampleCount: run.sampleCount,
  };
}

export function readPerformanceRun(directory) {
  const { target } = resolveArtifactDirectory(directory, { label: 'performance-input' });
  const samplesFile = path.join(target, 'samples.jsonl');
  const summaryFile = path.join(target, 'summary.json');
  const samplesBytes = readRegularBytes(samplesFile, 'samples.jsonl');
  const samples = parseJsonLines(samplesBytes);
  let summary;
  try {
    summary = JSON.parse(readRegularText(summaryFile, 'summary.json'));
  } catch (error) {
    if (error?.code === 'POPPET_PERFORMANCE_COMPARISON') throw error;
    comparisonError('summary.json is invalid JSON');
  }
  const run = {
    samples,
    summary,
    samplesSha256: sha256(samplesBytes),
    sampleCount: samples.length,
  };
  Object.defineProperty(run, RUN_SAMPLES_BYTES, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: samplesBytes,
  });
  return run;
}

export function createPerformanceEvidenceBinding({
  beforeRun,
  afterRun,
  comparison,
  comparisonArtifactBytes,
} = {}) {
  validatePerformanceComparison(comparison);
  const beforeEvidence = runSampleEvidence(beforeRun, 'before');
  const afterEvidence = runSampleEvidence(afterRun, 'after');
  if (!Buffer.isBuffer(comparisonArtifactBytes)) {
    comparisonError('comparisonArtifactBytes must be the exact comparison.json bytes');
  }
  const artifactComparison = parseJsonArtifact(comparisonArtifactBytes, 'comparison.json');
  validatePerformanceComparison(artifactComparison);
  if (!sameJson(artifactComparison, comparison)) {
    comparisonError('comparison.json bytes disagree with the comparison result');
  }
  if (comparison.before.gitSha !== beforeRun.summary.gitSha
      || comparison.after.gitSha !== afterRun.summary.gitSha) {
    comparisonError('comparison endpoints disagree with the bound performance runs');
  }
  const binding = {
    bindingVersion: PERFORMANCE_EVIDENCE_BINDING_VERSION,
    samplesSha256: afterEvidence.samplesSha256,
    sampleCount: afterEvidence.sampleCount,
    beforeSamplesSha256: beforeEvidence.samplesSha256,
    beforeSampleCount: beforeEvidence.sampleCount,
    afterSamplesSha256: afterEvidence.samplesSha256,
    afterSampleCount: afterEvidence.sampleCount,
    comparisonArtifactSha256: sha256(comparisonArtifactBytes),
    pairedBlockCount: comparison.pairing.pairedBlocks,
    metricResultCount: comparison.metricResults.length,
    hardCheckCount: comparison.hardChecks.length,
  };
  // The contract helper is also the single authoritative shape validator. Its
  // digest is intentionally not stored in this file: hashing a binding that
  // contains its own digest would create a self-reference.
  performanceEvidenceBindingDigest(binding);

  const boundSummary = structuredClone(afterRun.summary);
  boundSummary.performanceSummary.evidenceBinding = structuredClone(binding);
  boundSummary.performanceSummary.soak.comparisonToPreChange =
    structuredClone(comparison.milestoneProjection);
  validateMilestoneSummary(boundSummary);
  return binding;
}

function assertBindingMatchesComparison(binding, comparison, comparisonArtifactBytes) {
  performanceEvidenceBindingDigest(binding);
  const expected = {
    comparisonArtifactSha256: sha256(comparisonArtifactBytes),
    pairedBlockCount: comparison.pairing.pairedBlocks,
    metricResultCount: comparison.metricResults.length,
    hardCheckCount: comparison.hardChecks.length,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (binding[key] !== value) {
      comparisonError(`performance evidence binding ${key} disagrees with comparison.json`);
    }
  }
  if (binding.samplesSha256 !== binding.afterSamplesSha256
      || binding.sampleCount !== binding.afterSampleCount) {
    comparisonError('performance evidence binding final-sample aliases disagree');
  }
  if (binding.beforeSamplesSha256 === binding.afterSamplesSha256) {
    comparisonError('performance evidence binding requires distinct before/after sample digests');
  }
}

export function readPerformanceComparisonBundle(directory) {
  const { target } = resolveArtifactDirectory(directory, { label: 'performance-comparison-input' });
  const comparisonBytes = readRegularBytes(
    path.join(target, 'comparison.json'), 'comparison.json');
  const bindingBytes = readRegularBytes(
    path.join(target, 'evidence-binding.json'), 'evidence-binding.json');
  const comparison = parseJsonArtifact(comparisonBytes, 'comparison.json');
  const evidenceBinding = parseJsonArtifact(bindingBytes, 'evidence-binding.json');
  validatePerformanceComparison(comparison);
  assertBindingMatchesComparison(evidenceBinding, comparison, comparisonBytes);
  const bundle = { comparison, evidenceBinding };
  Object.defineProperty(bundle, COMPARISON_ARTIFACT_BYTES, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: comparisonBytes,
  });
  return bundle;
}

export function verifyPerformanceEvidenceBinding({
  beforeDirectory,
  afterDirectory,
  comparisonDirectory,
} = {}) {
  const beforeRun = readPerformanceRun(beforeDirectory);
  const afterRun = readPerformanceRun(afterDirectory);
  const bundle = readPerformanceComparisonBundle(comparisonDirectory);
  const expectedComparison = comparePerformanceRuns({
    beforeSamples: beforeRun.samples,
    beforeSummary: beforeRun.summary,
    afterSamples: afterRun.samples,
    afterSummary: afterRun.summary,
    sameMachineAttested: bundle.comparison.sameMachineAttested,
    now: new Date(bundle.comparison.generatedAt),
  });
  if (!sameJson(expectedComparison, bundle.comparison)) {
    comparisonError('comparison.json does not match the bound before/after samples');
  }
  const expectedBinding = createPerformanceEvidenceBinding({
    beforeRun,
    afterRun,
    comparison: bundle.comparison,
    comparisonArtifactBytes: bundle[COMPARISON_ARTIFACT_BYTES],
  });
  if (!sameJson(expectedBinding, bundle.evidenceBinding)) {
    comparisonError('evidence-binding.json does not match the bound artifacts');
  }
  const verified = {
    comparison: bundle.comparison,
    evidenceBinding: bundle.evidenceBinding,
    afterSummary: structuredClone(afterRun.summary),
  };
  VERIFIED_PERFORMANCE_EVIDENCE.set(verified, {
    comparison: structuredClone(bundle.comparison),
    evidenceBinding: structuredClone(bundle.evidenceBinding),
    afterSummary: structuredClone(afterRun.summary),
  });
  return verified;
}

export function projectVerifiedPerformanceEvidence(verified) {
  const proof = isPlainObject(verified)
    ? VERIFIED_PERFORMANCE_EVIDENCE.get(verified)
    : null;
  if (!proof) {
    comparisonError('performance evidence must come from raw artifact verification');
  }
  return {
    comparisonProjection: structuredClone(proof.comparison.milestoneProjection),
    evidenceBinding: structuredClone(proof.evidenceBinding),
    afterRunSummary: structuredClone(proof.afterSummary),
  };
}

function renderNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)).toString() : 'N/A';
}

export function renderPerformanceComparisonMarkdown(comparison) {
  validatePerformanceComparison(comparison);
  const lines = [
    '# Poppet Core Loop performance comparison',
    '',
    `Status: \`${comparison.status}\``,
    `Regression detected: ${comparison.regressionDetected}`,
    `Claim eligible: ${comparison.claimEligible}`,
    `Same-machine operator attestation: ${comparison.sameMachineAttested}`,
    `Before SHA: \`${comparison.before.gitSha}\``,
    `After SHA: \`${comparison.after.gitSha}\``,
    `Harness SHA: \`${comparison.runIdentity.harnessGitSha}\``,
    '',
    '## Evidence boundary',
    '',
    ...comparison.evidenceBoundaries.map(value => `- ${value}`),
    '',
    '## Locked pairing and bootstrap',
    '',
    `- 10-second paired blocks: ${comparison.pairing.pairedBlocks}`,
    `- Bootstrap resamples: ${comparison.pairing.bootstrapSamples}`,
    `- Bootstrap seed: ${comparison.pairing.bootstrapSeed}`,
    '',
    '## Statistical results',
    '',
    '| Pets | Phase | Process | Slot | Metric | Pairs | Before | After | Median change | 95% CI | Regression |',
    '| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const result of comparison.metricResults) {
    lines.push(`| ${result.topology} | ${result.phase} | ${result.processType} | ${result.processSlot} | ${result.metric} | ${result.pairCount} | ${renderNumber(result.beforeMedian)} | ${renderNumber(result.afterMedian)} | ${renderNumber(result.medianChange)} | ${renderNumber(result.confidenceLower95)} .. ${renderNumber(result.confidenceUpper95)} | ${result.regression} |`);
  }
  lines.push(
    '',
    '## Non-waivable checks',
    '',
    '| Rule | Before | After | Limit | Regression |',
    '| --- | ---: | ---: | ---: | --- |',
    ...comparison.hardChecks.map(check =>
      `| ${check.rule} | ${check.beforeValue} | ${check.afterValue} | ${check.limit} | ${check.regression} |`),
    '',
    'This aggregate contains no raw samples, run IDs, paths, filenames, image data, or network addresses.',
  );
  return `${lines.join('\n')}\n`;
}

export function writePerformanceComparison({ directory, comparison, beforeRun, afterRun }) {
  validatePerformanceComparison(comparison);
  const { root, target } = resolveArtifactDirectory(directory, { label: 'performance-comparison' });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(target, { recursive: false });
  const comparisonFile = path.join(target, 'comparison.json');
  fs.writeFileSync(comparisonFile, `${JSON.stringify(comparison, null, 2)}\n`);
  // Hash the persisted bytes, not a pre-write serialization and not a binding
  // containing its own digest. This makes comparisonArtifactSha256 a direct
  // statement about the actual comparison.json artifact.
  const comparisonArtifactBytes = readRegularBytes(comparisonFile, 'comparison.json');
  const evidenceBinding = createPerformanceEvidenceBinding({
    beforeRun,
    afterRun,
    comparison,
    comparisonArtifactBytes,
  });
  fs.writeFileSync(path.join(target, 'comparison.md'),
    renderPerformanceComparisonMarkdown(comparison));
  fs.writeFileSync(path.join(target, 'evidence-binding.json'),
    `${JSON.stringify(evidenceBinding, null, 2)}\n`);
  readPerformanceComparisonBundle(target);
  return path.relative(PROJECT_ROOT, target).split(path.sep).join('/');
}

export function performanceComparisonExitCode(comparison, { allowSmoke = false } = {}) {
  validatePerformanceComparison(comparison);
  if (comparison.regressionDetected) return 1;
  if (comparison.status === 'SMOKE_ONLY' && !allowSmoke) return 1;
  return 0;
}

function stringArg(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) comparisonError(`${flag} requires a value`);
  return value;
}

export function parsePerformanceComparisonArgs(args = process.argv.slice(2)) {
  const valueFlags = new Set(['--before', '--after', '--output']);
  const booleanFlags = new Set(['--same-machine', '--allow-smoke']);
  for (let index = 0; index < args.length; index++) {
    if (booleanFlags.has(args[index])) continue;
    if (!valueFlags.has(args[index])) comparisonError(`Unknown comparison option: ${args[index]}`);
    if (args[index + 1] === undefined || args[index + 1].startsWith('--')) {
      comparisonError(`${args[index]} requires a value`);
    }
    index++;
  }
  const before = stringArg(args, '--before');
  const after = stringArg(args, '--after');
  const output = stringArg(args, '--output');
  if (!before || !after) comparisonError('--before and --after run directories are required');
  return {
    before,
    after,
    output,
    sameMachineAttested: args.includes('--same-machine'),
    allowSmoke: args.includes('--allow-smoke'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  try {
    const args = parsePerformanceComparisonArgs();
    const before = readPerformanceRun(args.before);
    const after = readPerformanceRun(args.after);
    const comparison = comparePerformanceRuns({
      beforeSamples: before.samples,
      beforeSummary: before.summary,
      afterSamples: after.samples,
      afterSummary: after.summary,
      sameMachineAttested: args.sameMachineAttested,
    });
    const { target } = resolveArtifactDirectory(args.output, { label: 'performance-comparison' });
    const relative = writePerformanceComparison({
      directory: target,
      comparison,
      beforeRun: before,
      afterRun: after,
    });
    console.log(`[core-loop-performance-compare] ${comparison.pairing.pairedBlocks} paired blocks`);
    console.log(`[core-loop-performance-compare] status: ${comparison.status}`);
    console.log(`[core-loop-performance-compare] aggregate artifacts: ${relative}`);
    const smokeNotAllowed = comparison.status === 'SMOKE_ONLY' && !args.allowSmoke;
    if (smokeNotAllowed) {
      console.error('[core-loop-performance-compare] SMOKE_ONLY: pass --allow-smoke to accept a non-claimable comparison');
    }
    process.exit(performanceComparisonExitCode(comparison, { allowSmoke: args.allowSmoke }));
  } catch (error) {
    console.error(`[core-loop-performance-compare] ${error?.code || 'ENVIRONMENT_FAILURE'}: ${error?.message || error}`);
    process.exit(1);
  }
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ARTIFACTS_ROOT,
  PERFORMANCE_PROTOCOL,
  acceptanceEvidenceDigest,
  createMilestoneSummary,
  validateMilestoneSummary,
} from '../../tools/core-loop-contract.mjs';
import {
  EXPECTED_PERFORMANCE_COMPARISON_VERSION,
  PERFORMANCE_HARNESS_VERSION,
  createPerformanceSample,
  performanceProtocolIdentity,
  validatePerformanceSample,
  writePerformanceRun,
} from '../../tools/core-loop-performance.mjs';
import {
  PERFORMANCE_BLOCK_MS,
  comparePerformanceRuns,
  readPerformanceComparisonBundle,
  readPerformanceRun,
  parsePerformanceComparisonArgs,
  performanceComparisonExitCode,
  renderPerformanceComparisonMarkdown,
  validatePerformanceComparison,
  verifyPerformanceEvidenceBinding,
  writePerformanceComparison,
} from '../../tools/core-loop-performance-compare.mjs';
import {
  finalizeCoreLoopAcceptance,
  finalizeCoreLoopAcceptanceFromFiles,
  writeCoreLoopAcceptanceArtifacts,
} from '../../tools/core-loop-acceptance-finalize.mjs';

const BEFORE_SHA = 'a'.repeat(40);
const AFTER_SHA = 'b'.repeat(40);
const HARDWARE_CLASS = {
  logicalCpuBucket: '9-16',
  memoryGiBBucket: '17-32',
};

function smokeProtocol() {
  return {
    petCounts: [1, 3, 6],
    repetitions: 1,
    warmupMs: 1,
    idleMs: 20_000,
    activeMs: 20_000,
    recoveryMs: 20_000,
    soakPets: 6,
    soakWarmupMs: 1,
    soakMs: 20_000,
    sampleIntervalMs: 10_000,
  };
}

function performanceSummary(gitSha, overrides = {}) {
  const protocol = overrides.protocol || smokeProtocol();
  const topologyRow = topology => ({
    samples: 4 * topology + 6,
    meanMainCpuPercent: 10,
    meanRendererCpuPercent: 10,
    peakMainMemoryMiB: 100,
    peakRendererMemoryMiB: 50,
    frameIntervalP50Ms: 10.5,
    frameIntervalP95Ms: 10.5,
    frameIntervalP99Ms: 10.5,
    frameIntervalSampleCount: 4 * topology,
    frameIntervalOverflowCount: 0,
    renderWorkP95Ms: 1,
    activeLongFrameRate: 0,
    eventLoopStalls: 0,
    crashes: 0,
    unhandledErrors: 0,
    postDestroyPetCountMax: 0,
    postDestroyWindowCountMax: 0,
    postDestroyTimerDeltaMax: 0,
    postDestroyListenerDeltaMax: 0,
  });
  return createMilestoneSummary({
    gitSha,
    branch: 'main',
    performanceSummary: {
      hardwareClass: { ...HARDWARE_CLASS },
      sourceDirty: false,
      provenance: {
        identityVersion: 'core-loop-performance-run-identity-v1',
        appGitSha: gitSha,
        harnessGitSha: 'c'.repeat(40),
        harnessSourceClean: true,
        harnessVersion: 'core-loop-harness-v1',
        performanceHarnessVersion: PERFORMANCE_HARNESS_VERSION,
        comparisonVersion: EXPECTED_PERFORMANCE_COMPARISON_VERSION,
        probeIdentity: 'poppet-core-loop-electron-probe-v4',
        probeSourceSha256: 'd'.repeat(64),
        fixtureIdentity: 'e'.repeat(64),
        settingsIdentity: 'f'.repeat(64),
        environmentIdentity: '1'.repeat(64),
        protocolIdentity: performanceProtocolIdentity(protocol),
        driverNodeVersion: '22.23.2',
        electronVersion: '43.4.1',
        electronNodeVersion: '24.1.0',
        ...(overrides.provenance || {}),
      },
      protocolQualified: false,
      protocol,
      byTopology: {
        1: topologyRow(1),
        3: topologyRow(3),
        6: topologyRow(6),
      },
      soak: {
        samples: 14,
        durationMs: 20_000,
        memoryTrend: {
          status: 'UNAVAILABLE',
          combinedMemoryTheilSenMiBPerMinute: null,
          combinedMemoryTheilSenLower95MiBPerMinute: null,
          firstTenMinuteMedianMiB: null,
          lastTenMinuteMedianMiB: null,
          lastMinusFirstMedianMiB: null,
          bootstrapSamples: 10_000,
          bootstrapSeed: 0x4b5454,
          regressionDetected: null,
        },
        crashes: 0,
        unhandledErrors: 0,
        resourceTrend: {
          status: 'AVAILABLE',
          timerFirstWindowMedianDelta: 0,
          timerLastWindowMedianDelta: 0,
          listenerFirstWindowMedianDelta: 0,
          listenerLastWindowMedianDelta: 0,
          timerTheilSenDeltaPerMinute: 0,
          listenerTheilSenDeltaPerMinute: 0,
          sustainedGrowthDetected: false,
        },
        comparisonToPreChange: null,
      },
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'provenance')),
    },
  });
}

function identities(topology, phase) {
  const result = [{ processType: 'main', processSlot: 0 }];
  if (phase !== 'recovery') {
    for (let processSlot = 1; processSlot <= topology; processSlot++) {
      result.push({ processType: 'renderer', processSlot });
    }
  }
  return result;
}

function buildSamples({ gitSha, runId, mutate = sample => sample }) {
  const samples = [];
  const addPhase = (topology, repetition, phase) => {
    for (const elapsedMs of [5_000, 15_000]) {
      for (const identity of identities(topology, phase)) {
        const input = {
          topology,
          repetition,
          phase,
          elapsedMs,
          ...identity,
          cpuPercent: 10,
          memoryMiB: identity.processType === 'main' ? 100 : 50,
          frameIntervalMs: identity.processType === 'renderer' ? 10 : null,
          renderWorkMs: identity.processType === 'renderer' ? 1 : null,
          longFrame: false,
          eventLoopStallMs: 0,
          crashCount: 0,
          unhandledErrorCount: 0,
          petCount: phase === 'recovery' ? 0 : topology,
          windowCount: phase === 'recovery' ? 0 : topology,
          timerCount: identity.processType === 'main' ? 0 : null,
          listenerCount: identity.processType === 'main' ? 0 : null,
        };
        samples.push(createPerformanceSample({
          runId,
          gitSha,
          ...mutate({ ...input }),
        }));
      }
    }
  };
  for (const topology of PERFORMANCE_PROTOCOL.petCounts) {
    for (const phase of ['idle', 'active', 'recovery']) addPhase(topology, 1, phase);
  }
  addPhase(6, 1, 'soak');
  return samples;
}

test('performance comparison applies locked paired bootstrap, cadence, and non-waivable gates', () => {
  const beforeSamples = buildSamples({ gitSha: BEFORE_SHA, runId: 'before-run' });
  const afterSamples = buildSamples({
    gitSha: AFTER_SHA,
    runId: 'after-run',
    mutate(sample) {
      if (sample.topology === 1 && sample.phase === 'active'
          && sample.processType === 'main') sample.cpuPercent = 13;
      if (sample.topology === 3 && sample.phase === 'active'
          && sample.processType === 'renderer' && sample.processSlot === 1) {
        sample.frameIntervalMs = 13;
        sample.longFrame = true;
      }
      if (sample.topology === 6 && sample.phase === 'recovery') {
        sample.timerCount = 1;
      }
      if (sample.phase === 'soak' && sample.processType === 'main'
          && sample.elapsedMs === 5_000) sample.crashCount = 1;
      return sample;
    },
  });
  const afterSummary = performanceSummary(AFTER_SHA);
  afterSummary.performanceSummary.soak.crashes = 1;
  const comparison = comparePerformanceRuns({
    beforeSamples,
    beforeSummary: performanceSummary(BEFORE_SHA),
    afterSamples,
    afterSummary,
    now: new Date('2026-08-20T00:00:00.000Z'),
  });

  assert.equal(comparison.pairing.blockMs, PERFORMANCE_BLOCK_MS);
  assert.equal(comparison.pairing.bootstrapSamples, 10_000);
  assert.equal(comparison.pairing.bootstrapSeed, 0x4b5454);
  const cpu = comparison.metricResults.find(result => result.metric === 'cpuPercent'
    && result.topology === 1 && result.phase === 'active'
    && result.processType === 'main');
  assert.equal(cpu.pairCount, 2);
  assert.ok(cpu.medianChange > 0.20);
  assert.ok(cpu.confidenceLower95 > 0);
  assert.equal(cpu.regression, true);

  const cadence = comparison.metricResults.find(result => result.metric === 'frameIntervalP95Ms'
    && result.topology === 3 && result.phase === 'active'
    && result.processSlot === 1);
  assert.ok(cadence.medianChange > 0.20);
  assert.ok(cadence.confidenceLower95 > 0);
  assert.equal(cadence.regression, true);

  const longFrames = comparison.metricResults.find(result => result.metric === 'longFrameRatePoints'
    && result.topology === 3 && result.phase === 'active'
    && result.processSlot === 1);
  assert.ok(longFrames.medianChange > 1);
  assert.equal(longFrames.changeKind, 'absolute_points');
  assert.equal(longFrames.regression, true);

  assert.equal(comparison.hardChecks.find(check => check.rule === 'CRASH_COUNT').regression, true);
  assert.equal(comparison.hardChecks.find(check =>
    check.rule === 'PET_COUNT_MISMATCH_OBSERVATIONS').regression, false);
  assert.equal(comparison.hardChecks.find(check =>
    check.rule === 'RECOVERY_TIMER_DELTA_MAX').regression, true);
  assert.equal(comparison.regressionDetected, true);
  assert.equal(comparison.status, 'REGRESSION');
});

test('identical smoke runs remain explicitly non-claimable and aggregate-only', () => {
  const beforeSamples = buildSamples({ gitSha: BEFORE_SHA, runId: 'before-private-id' });
  const afterSamples = buildSamples({ gitSha: AFTER_SHA, runId: 'after-private-id' });
  const comparison = comparePerformanceRuns({
    beforeSamples,
    beforeSummary: performanceSummary(BEFORE_SHA),
    afterSamples,
    afterSummary: performanceSummary(AFTER_SHA),
    now: new Date('2026-08-20T00:00:00.000Z'),
  });
  assert.equal(validatePerformanceComparison(comparison), comparison);
  assert.equal(comparison.regressionDetected, false);
  assert.equal(comparison.claimEligible, false);
  assert.equal(comparison.status, 'SMOKE_ONLY');
  assert.equal(comparison.sameMachineAttested, false);
  assert.deepEqual(comparison.milestoneProjection, {
    comparisonVersion: EXPECTED_PERFORMANCE_COMPARISON_VERSION,
    status: 'SMOKE_ONLY',
    claimEligible: false,
    regressionDetected: false,
    sameMachineAttested: false,
    beforeGitSha: BEFORE_SHA,
    afterGitSha: AFTER_SHA,
  });
  assert.equal(performanceComparisonExitCode(comparison), 1);
  assert.equal(performanceComparisonExitCode(comparison, { allowSmoke: true }), 0);
  const serialized = JSON.stringify(comparison);
  assert.doesNotMatch(serialized, /before-private-id|after-private-id|samples\.jsonl/);
  assert.doesNotMatch(renderPerformanceComparisonMarkdown(comparison),
    /before-private-id|after-private-id|samples\.jsonl/);
  assert.throws(() => validatePerformanceComparison({
    ...comparison,
    path: 'C:\\Users\\person\\raw-samples.jsonl',
  }), /forbidden identifying key|path or network address/);
  const divergentProjection = structuredClone(comparison);
  divergentProjection.milestoneProjection.afterGitSha = BEFORE_SHA;
  assert.throws(() => validatePerformanceComparison(divergentProjection),
    /milestoneProjection disagrees/);
});

test('comparison rejects hardware, protocol, and exact block-pair mismatches', () => {
  const beforeSamples = buildSamples({ gitSha: BEFORE_SHA, runId: 'before-run' });
  const afterSamples = buildSamples({ gitSha: AFTER_SHA, runId: 'after-run' });
  const beforeSummary = performanceSummary(BEFORE_SHA);

  const hardware = performanceSummary(AFTER_SHA, {
    hardwareClass: { logicalCpuBucket: '17-32', memoryGiBBucket: '17-32' },
  });
  assert.throws(() => comparePerformanceRuns({
    beforeSamples, beforeSummary, afterSamples, afterSummary: hardware,
  }), /hardwareClass differs/);

  const changedProtocol = smokeProtocol();
  changedProtocol.idleMs += 1;
  const protocol = performanceSummary(AFTER_SHA, { protocol: changedProtocol });
  assert.throws(() => comparePerformanceRuns({
    beforeSamples, beforeSummary, afterSamples, afterSummary: protocol,
  }), /protocol differs/);

  const nodeMismatch = performanceSummary(AFTER_SHA, {
    provenance: { driverNodeVersion: '23.0.0' },
  });
  assert.throws(() => comparePerformanceRuns({
    beforeSamples, beforeSummary, afterSamples, afterSummary: nodeMismatch,
  }), /Node, Electron, harness, probe, fixture, settings, config, or display\/power identity differs/);

  const powerDisplayMismatch = performanceSummary(AFTER_SHA, {
    provenance: { environmentIdentity: '2'.repeat(64) },
  });
  assert.throws(() => comparePerformanceRuns({
    beforeSamples, beforeSummary, afterSamples, afterSummary: powerDisplayMismatch,
  }), /Node, Electron, harness, probe, fixture, settings, config, or display\/power identity differs/);

  const dirtyHarness = performanceSummary(AFTER_SHA, {
    provenance: { harnessSourceClean: false },
  });
  assert.throws(() => comparePerformanceRuns({
    beforeSamples, beforeSummary, afterSamples, afterSummary: dirtyHarness,
  }), /same clean committed harness source/);

  assert.throws(() => comparePerformanceRuns({
    beforeSamples,
    beforeSummary,
    afterSamples: afterSamples.slice(0, -1),
    afterSummary: performanceSummary(AFTER_SHA),
  }), /missing required 10-second block|sparse in 10-second block/);

  const petLeak = structuredClone(afterSamples);
  petLeak.find(sample => sample.phase === 'recovery').petCount = 1;
  assert.throws(() => comparePerformanceRuns({
    beforeSamples,
    beforeSummary,
    afterSamples: petLeak,
    afterSummary: performanceSummary(AFTER_SHA),
  }), /recovery petCount must be zero/);

  const inconsistentSummary = performanceSummary(AFTER_SHA);
  inconsistentSummary.performanceSummary.soak.resourceTrend.timerLastWindowMedianDelta = 1;
  assert.throws(() => comparePerformanceRuns({
    beforeSamples,
    beforeSummary,
    afterSamples,
    afterSummary: inconsistentSummary,
  }), /disagrees with raw samples/);

  const malformedHistogram = structuredClone(afterSamples.find(sample => sample.processType === 'renderer'));
  malformedHistogram.frameIntervalHistogram.counts[10]++;
  assert.throws(() => validatePerformanceSample(malformedHistogram),
    /count does not match frameIntervalSampleCount/);
});

test('comparison artifacts bind exact sample lines and persisted comparison bytes', t => {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const beforeDirectory = path.join(ARTIFACTS_ROOT, `binding-before-${suffix}`);
  const afterDirectory = path.join(ARTIFACTS_ROOT, `binding-after-${suffix}`);
  const comparisonDirectory = path.join(ARTIFACTS_ROOT, `binding-comparison-${suffix}`);
  const acceptanceDirectory = path.join(ARTIFACTS_ROOT, `binding-acceptance-${suffix}`);
  const targets = [
    beforeDirectory, afterDirectory, comparisonDirectory, acceptanceDirectory,
  ];
  t.after(() => {
    for (const target of targets) {
      const resolved = path.resolve(target);
      assert.equal(path.dirname(resolved), path.resolve(ARTIFACTS_ROOT));
      if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: false });
    }
  });

  writePerformanceRun({
    directory: beforeDirectory,
    samples: buildSamples({ gitSha: BEFORE_SHA, runId: 'before-bound-private-id' }),
    summary: performanceSummary(BEFORE_SHA),
  });
  writePerformanceRun({
    directory: afterDirectory,
    samples: buildSamples({ gitSha: AFTER_SHA, runId: 'after-bound-private-id' }),
    summary: performanceSummary(AFTER_SHA),
  });
  const beforeRun = readPerformanceRun(beforeDirectory);
  const afterRun = readPerformanceRun(afterDirectory);
  const comparison = comparePerformanceRuns({
    beforeSamples: beforeRun.samples,
    beforeSummary: beforeRun.summary,
    afterSamples: afterRun.samples,
    afterSummary: afterRun.summary,
    now: new Date('2026-08-20T00:00:00.000Z'),
  });
  writePerformanceComparison({
    directory: comparisonDirectory,
    comparison,
    beforeRun,
    afterRun,
  });

  const comparisonFile = path.join(comparisonDirectory, 'comparison.json');
  const bindingFile = path.join(comparisonDirectory, 'evidence-binding.json');
  const comparisonBytes = fs.readFileSync(comparisonFile);
  const bindingBytes = fs.readFileSync(bindingFile);
  const physicalLineCount = file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.length;
  };
  const bundle = readPerformanceComparisonBundle(comparisonDirectory);
  const binding = bundle.evidenceBinding;
  assert.equal(binding.comparisonArtifactSha256,
    crypto.createHash('sha256').update(comparisonBytes).digest('hex'));
  assert.equal(binding.beforeSamplesSha256, beforeRun.samplesSha256);
  assert.equal(binding.afterSamplesSha256, afterRun.samplesSha256);
  assert.equal(binding.samplesSha256, afterRun.samplesSha256);
  assert.equal(binding.beforeSampleCount, beforeRun.sampleCount);
  assert.equal(binding.afterSampleCount, afterRun.sampleCount);
  assert.equal(binding.sampleCount, afterRun.sampleCount);
  assert.equal(binding.beforeSampleCount,
    physicalLineCount(path.join(beforeDirectory, 'samples.jsonl')));
  assert.equal(binding.afterSampleCount,
    physicalLineCount(path.join(afterDirectory, 'samples.jsonl')));
  assert.equal(binding.pairedBlockCount, comparison.pairing.pairedBlocks);
  assert.equal(binding.metricResultCount, comparison.metricResults.length);
  assert.equal(binding.hardCheckCount, comparison.hardChecks.length);
  assert.doesNotMatch(bindingBytes.toString('utf8'),
    /bound-private-id|[A-Za-z]:[\\/]|samples\.jsonl/);

  const projectedSummary = structuredClone(afterRun.summary);
  projectedSummary.performanceSummary.evidenceBinding = structuredClone(binding);
  projectedSummary.performanceSummary.soak.comparisonToPreChange =
    structuredClone(comparison.milestoneProjection);
  assert.doesNotThrow(() => validateMilestoneSummary(projectedSummary));
  const verifiedPerformanceEvidence = verifyPerformanceEvidenceBinding({
    beforeDirectory,
    afterDirectory,
    comparisonDirectory,
  });
  const ciBundle = {
    ciRun: {
      url: 'https://github.com/SioYooo/poppet/actions/runs/123456',
      gitSha: AFTER_SHA,
      jobs: [],
    },
  };
  const finalized = finalizeCoreLoopAcceptance({
    afterSummary: afterRun.summary,
    verifiedPerformanceEvidence,
    ciBundle,
  });
  assert.deepEqual(Object.keys(finalized.acceptanceEvidence).sort(),
    ['ciBundle', 'performanceBundle']);
  assert.deepEqual(Object.keys(finalized.acceptanceEvidence.performanceBundle).sort(),
    ['comparisonProjection', 'evidenceBinding']);
  assert.equal(finalized.summary.acceptanceBinding.ciEvidenceDigest,
    acceptanceEvidenceDigest('ci', finalized.acceptanceEvidence.ciBundle));
  assert.equal(finalized.summary.acceptanceBinding.performanceEvidenceDigest,
    acceptanceEvidenceDigest('performance', finalized.acceptanceEvidence.performanceBundle));
  assert.doesNotThrow(() => validateMilestoneSummary(finalized.summary, {
    acceptanceEvidence: finalized.acceptanceEvidence,
  }));
  writeCoreLoopAcceptanceArtifacts({ directory: acceptanceDirectory, ...finalized });
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(acceptanceDirectory, 'acceptance-evidence.json'), 'utf8')),
    finalized.acceptanceEvidence);

  const ciBundleFile = path.join(comparisonDirectory, 'ci-bundle.json');
  fs.writeFileSync(ciBundleFile, `${JSON.stringify(ciBundle, null, 2)}\n`);
  const fromFiles = () => finalizeCoreLoopAcceptanceFromFiles({
    afterSummaryFile: path.join(afterDirectory, 'summary.json'),
    beforeRunDirectory: beforeDirectory,
    afterRunDirectory: afterDirectory,
    comparisonDirectory,
    ciBundleFile,
  });
  assert.doesNotThrow(fromFiles);

  const afterSamplesFile = path.join(afterDirectory, 'samples.jsonl');
  const originalAfterSamples = fs.readFileSync(afterSamplesFile);
  const tamperedSamples = originalAfterSamples.toString('utf8')
    .replace('"cpuPercent":10', '"cpuPercent":11');
  assert.notEqual(tamperedSamples, originalAfterSamples.toString('utf8'));
  fs.writeFileSync(afterSamplesFile, tamperedSamples);
  assert.throws(fromFiles, /does not match|disagrees/);
  fs.writeFileSync(afterSamplesFile, originalAfterSamples);

  fs.writeFileSync(comparisonFile, Buffer.concat([comparisonBytes, Buffer.from(' ')]));
  assert.throws(fromFiles,
    /comparisonArtifactSha256 disagrees/);
  fs.writeFileSync(comparisonFile, comparisonBytes);

  const forgedComparison = JSON.parse(comparisonBytes.toString('utf8'));
  forgedComparison.metricResults[0].beforeMedian++;
  const forgedComparisonBytes = Buffer.from(`${JSON.stringify(forgedComparison, null, 2)}\n`);
  const forgedBinding = JSON.parse(bindingBytes.toString('utf8'));
  forgedBinding.comparisonArtifactSha256 = crypto.createHash('sha256')
    .update(forgedComparisonBytes).digest('hex');
  fs.writeFileSync(comparisonFile, forgedComparisonBytes);
  fs.writeFileSync(bindingFile, `${JSON.stringify(forgedBinding, null, 2)}\n`);
  assert.throws(fromFiles, /does not match the bound before\/after samples/);
  fs.writeFileSync(comparisonFile, comparisonBytes);
  fs.writeFileSync(bindingFile, bindingBytes);

  const tamperedBinding = JSON.parse(bindingBytes.toString('utf8'));
  tamperedBinding.pairedBlockCount++;
  fs.writeFileSync(bindingFile, `${JSON.stringify(tamperedBinding, null, 2)}\n`);
  assert.throws(() => readPerformanceComparisonBundle(comparisonDirectory),
    /pairedBlockCount disagrees/);
  fs.writeFileSync(bindingFile, bindingBytes);

  const divergentSummary = structuredClone(afterRun.summary);
  divergentSummary.performanceSummary.byTopology['1'].meanMainCpuPercent++;
  const divergentSummaryFile = path.join(comparisonDirectory, 'divergent-summary.json');
  fs.writeFileSync(divergentSummaryFile, `${JSON.stringify(divergentSummary, null, 2)}\n`);
  assert.throws(() => finalizeCoreLoopAcceptanceFromFiles({
    afterSummaryFile: divergentSummaryFile,
    beforeRunDirectory: beforeDirectory,
    afterRunDirectory: afterDirectory,
    comparisonDirectory,
    ciBundleFile,
  }), /performance evidence disagrees with the verified after run/);
});

test('comparison CLI requires two run directories and is production-excluded', () => {
  assert.deepEqual(parsePerformanceComparisonArgs([
    '--before', '.artifacts/core-loop/pre',
    '--after', '.artifacts/core-loop/final',
    '--output', '.artifacts/core-loop/comparison',
  ]), {
    before: '.artifacts/core-loop/pre',
    after: '.artifacts/core-loop/final',
    output: '.artifacts/core-loop/comparison',
    sameMachineAttested: false,
    allowSmoke: false,
  });
  assert.deepEqual(parsePerformanceComparisonArgs([
    '--before', 'pre', '--after', 'post', '--same-machine', '--allow-smoke',
  ]), {
    before: 'pre', after: 'post', output: null,
    sameMachineAttested: true, allowSmoke: true,
  });
  assert.throws(() => parsePerformanceComparisonArgs(['--before', 'pre']),
    /--before and --after/);

  const packageJson = JSON.parse(fs.readFileSync(
    new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['compare:performance'],
    'node tools/core-loop-performance-compare.mjs');
  assert.ok(packageJson.build.files.includes('!tools/**/*'));

  const contract = fs.readFileSync(
    new URL('../../docs/core-loop-excellence.md', import.meta.url), 'utf8');
  assert.match(contract, /npm run compare:performance/);
  assert.match(contract, /10,000 paired bootstrap resamples/);
});

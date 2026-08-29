import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_PERFORMANCE_PROBE_IDENTITY,
  FRAME_HISTOGRAM_BUCKET_COUNT,
  createPerformanceSample,
  parsePerformanceArgs,
  performanceRunExitCode,
  runPerformanceProtocol,
  validatePerformanceSample,
} from '../../tools/core-loop-performance.mjs';

const APP_SHA = 'a'.repeat(40);
const HARNESS_SHA = 'b'.repeat(40);

function input({ topology, repetition, phase, processType, processSlot, elapsedMs = 1 }) {
  return {
    topology,
    repetition,
    phase,
    elapsedMs,
    processType,
    processSlot,
    cpuPercent: 1,
    memoryMiB: processType === 'main' ? 100 : 50,
    frameIntervalMs: processType === 'renderer' ? 16.5 : null,
    renderWorkMs: processType === 'renderer' ? 1 : null,
    longFrame: false,
    eventLoopStallMs: 0,
    crashCount: 0,
    unhandledErrorCount: 0,
    petCount: phase === 'recovery' ? 0 : topology,
    windowCount: phase === 'recovery' ? 0 : topology,
    timerCount: processType === 'main' ? 0 : null,
    listenerCount: processType === 'main' ? 0 : null,
  };
}

test('frame interval histogram, quantiles, and long-frame counts fail closed together', () => {
  const sample = createPerformanceSample({
    runId: 'histogram-test',
    gitSha: APP_SHA,
    ...input({
      topology: 1, repetition: 1, phase: 'active', processType: 'renderer', processSlot: 1,
    }),
  });
  assert.equal(sample.frameIntervalHistogram.counts.length, FRAME_HISTOGRAM_BUCKET_COUNT);
  assert.equal(sample.frameIntervalSampleCount, 1);
  assert.equal(sample.frameIntervalP50Ms, 16.5);
  assert.equal(validatePerformanceSample(sample), sample);

  const wrongCount = structuredClone(sample);
  wrongCount.frameIntervalHistogram.counts[16]++;
  assert.throws(() => validatePerformanceSample(wrongCount), /count does not match/);

  const wrongRate = structuredClone(sample);
  wrongRate.longFrameCount = 1;
  wrongRate.longFrame = true;
  assert.throws(() => validatePerformanceSample(wrongRate), /long-frame fields are inconsistent/);

  const wrongOrder = structuredClone(sample);
  wrongOrder.frameIntervalP50Ms = 20;
  wrongOrder.frameIntervalP95Ms = 10;
  assert.throws(() => validatePerformanceSample(wrongOrder), /quantiles disagree/);
});

test('duration-equivalent custom probes remain non-claimable and smoke exits nonzero by default', async () => {
  const config = parsePerformanceArgs([]);
  const forgedCustomProbe = {
    performanceProbeIdentity: DEFAULT_PERFORMANCE_PROBE_IDENTITY,
    async collectPerformanceScenario({ config: scenario, emit }) {
      for (const phase of ['idle', 'active']) {
        emit(input({ ...scenario, phase, processType: 'main', processSlot: 0 }));
        for (let slot = 1; slot <= scenario.topology; slot++) {
          emit(input({ ...scenario, phase, processType: 'renderer', processSlot: slot }));
        }
      }
      emit(input({ ...scenario, phase: 'recovery', processType: 'main', processSlot: 0 }));
    },
    async collectPerformanceSoak({ config: soak, emit }) {
      emit(input({ ...soak, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs: 1 }));
      emit(input({ ...soak, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs: 2 }));
      for (let slot = 1; slot <= soak.topology; slot++) {
        emit(input({ ...soak, phase: 'soak', processType: 'renderer', processSlot: slot }));
      }
    },
  };
  const { summary } = await runPerformanceProtocol({
    probe: forgedCustomProbe,
    config,
    runId: 'custom-probe-test',
    gitSha: APP_SHA,
    branch: 'main',
    sourceDirty: false,
    harnessGitSha: HARNESS_SHA,
    harnessSourceDirty: false,
    now: new Date('2026-08-20T00:00:00.000Z'),
  });
  assert.equal(summary.performanceSummary.protocolQualified, false);
  assert.equal(summary.performanceSummary.provenance.probeIdentity, 'custom-unverified-probe');
  assert.ok(summary.evidenceBoundaries.includes('CUSTOM_PROBE_NON_CLAIMABLE'));
  assert.equal(performanceRunExitCode(summary), 1);
  assert.equal(performanceRunExitCode(summary, { allowSmoke: true }), 0);
});

test('CLI qualification excludes custom probes and requires explicit smoke opt-in', () => {
  const custom = parsePerformanceArgs(['--probe', 'fixture.mjs', '--allow-smoke']);
  assert.equal(custom.protocolQualified, false);
  assert.equal(custom.allowSmoke, true);
  assert.throws(() => parsePerformanceArgs(['--allow-smoke=true']), /Unknown performance option/);
});

test('Electron probe uses one app-metrics snapshot per tick and measured pace distributions', () => {
  const probeMain = fs.readFileSync(
    new URL('../../tools/core-loop-electron-probe-main.cjs', import.meta.url), 'utf8');
  const processMetricBody = probeMain.match(/function processMetric\([\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(processMetricBody, /getAppMetrics/,
    'per-process lookup must never take a fresh Electron snapshot');
  assert.match(probeMain,
    /const snapshot = metricSnapshot\(\);[\s\S]*?mainSample\([^\n]*snapshot\)[\s\S]*?rendererSample\([^\n]*[\s\S]*?snapshot\)/,
    'a sampling tick must fan one immutable snapshot out to main and renderers');
  assert.match(probeMain, /pace\.intervalP50Ms/);
  assert.match(probeMain, /pace\.intervalP95Ms/);
  assert.match(probeMain, /pace\.intervalP99Ms/);
  assert.match(probeMain, /pace\.intervalHistogram/);
  assert.doesNotMatch(probeMain,
    /const frameIntervalMs = Number\.isFinite\(pace\.fps\)[\s\S]*?1000 \/ pace\.fps/,
    'frame cadence must not be inferred from average FPS');
  assert.ok(probeMain.indexOf("app.on('web-contents-created'")
    < probeMain.indexOf('app.whenReady().then(run)'),
  'renderer failure observers must be registered before any measured renderer starts');
  assert.match(probeMain, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
  assert.match(probeMain, /powerSaveBlocker\.stop\(suspensionBlockerId\)/);
  assert.match(probeMain, /finalEnvironmentIdentity !== initialEnvironmentIdentity/,
    'display or power changes during a run must invalidate the evidence');
  assert.match(probeMain, /window\.__poppetDev = Object\.freeze\(\{ charId \}\)/,
    'pre and after runs must use the same minimal renderer evidence surface');
});

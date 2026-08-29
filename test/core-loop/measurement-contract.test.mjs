import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARTIFACTS_ROOT,
  FAILURE_CLASSES,
  PERFORMANCE_PROTOCOL,
  PROJECT_ROOT,
  acceptanceEvidenceDigest,
  aggregateCaseRecords,
  createCaseRecord,
  createMilestoneSummary,
  emptyTimings,
  resolveArtifactDirectory,
  sanitizeDiagnosticText,
  summarizeHardwareClass,
  validateCaseRecord,
  validateMilestoneSummary,
  writeLocalArtifacts,
} from '../../tools/core-loop-contract.mjs';
import { runSyntheticCorpus } from '../../tools/core-loop-corpus.mjs';
import {
  createPerformanceSample,
  parsePerformanceArgs,
  performanceProtocolIdentity,
  runPerformanceProtocol,
  validatePerformanceSample,
} from '../../tools/core-loop-performance.mjs';

const GIT_SHA = 'a'.repeat(40);

function validCase(overrides = {}) {
  return createCaseRecord({
    runId: 'run-001',
    gitSha: GIT_SHA,
    platform: { os: 'win32', arch: 'x64' },
    hardwareClass: { logicalCpuBucket: '9-16', memoryGiBBucket: '17-32' },
    evidenceKind: 'automated-engineering',
    actor: 'automation',
    caseId: 'case-001',
    inputBucket: 'supported',
    width: 64,
    height: 96,
    frameCount: 1,
    chosenPreset: 'original',
    extractorMode: 'alpha',
    timings: emptyTimings({ pipelineMs: 12.5 }),
    outcome: 'success',
    failures: [],
    recoveryUsed: false,
    warnings: [],
    claimEligible: false,
    rightsStatus: 'unverified',
    ...overrides,
  });
}

function calibratedTimings(markers, { human = false } = {}) {
  const timings = emptyTimings();
  timings.clock = { mode: 'calibrated-cross-process', calibrationUncertaintyMs: 1 };
  Object.assign(timings.markersMs, markers);
  const available = (...names) => names.every(name => Number.isFinite(timings.markersMs[name]));
  if (available('T0', 'T1')) {
    timings.timeToSourcePreviewMs = timings.markersMs.T1 - timings.markersMs.T0;
  }
  if (available('T0', 'T2')) {
    timings.timeToProcessedPreviewMs = timings.markersMs.T2 - timings.markersMs.T0;
  }
  if (available('T3', 'T5')) {
    timings.createToPetReadyMs = timings.markersMs.T5 - timings.markersMs.T3;
  }
  if (available('T0', 'T2', 'T3', 'T5')) {
    timings.systemTimeToPetMs = (timings.markersMs.T2 - timings.markersMs.T0)
      + (timings.markersMs.T5 - timings.markersMs.T3);
  }
  if (human && available('T0', 'T5')) {
    timings.humanEndToEndTimeMs = timings.markersMs.T5 - timings.markersMs.T0;
  }
  return timings;
}

function engineeringAcceptedSummary(base) {
  const summary = structuredClone(base);
  const protocol = {
    petCounts: [...PERFORMANCE_PROTOCOL.petCounts],
    repetitions: PERFORMANCE_PROTOCOL.repetitions,
    warmupMs: PERFORMANCE_PROTOCOL.warmupMs,
    idleMs: PERFORMANCE_PROTOCOL.idleMs,
    activeMs: PERFORMANCE_PROTOCOL.activeMs,
    recoveryMs: PERFORMANCE_PROTOCOL.recoveryMs,
    soakPets: PERFORMANCE_PROTOCOL.soakPets,
    soakWarmupMs: PERFORMANCE_PROTOCOL.soakWarmupMs,
    soakMs: PERFORMANCE_PROTOCOL.soakMs,
    sampleIntervalMs: PERFORMANCE_PROTOCOL.sampleIntervalMs,
  };
  summary.engineeringVerdict = 'CORE_LOOP_ENGINEERING_ACCEPTED';
  summary.acceptanceBinding = {
    bindingVersion: 'core-loop-acceptance-binding-v1',
    subjectGitSha: GIT_SHA,
    reportCarrierMode: 'DETACHED_ARTIFACT',
    ciEvidenceDigest: '5'.repeat(64),
    performanceEvidenceDigest: '6'.repeat(64),
  };
  summary.evidenceBoundaries = [
    ...summary.evidenceBoundaries,
    'SUMMARY_GIT_SHA_IS_EVIDENCE_APP_SHA_NOT_REPORT_CARRIER',
  ];
  summary.commits = [{ sha: GIT_SHA, purpose: 'CORE_LOOP_EVIDENCE_APP_SHA' }];
  summary.ciRun = {
    url: 'https://github.com/SioYooo/poppet/actions/runs/123456',
    gitSha: GIT_SHA,
    jobs: [
      { name: 'test (ubuntu-latest)', status: 'PASS' },
      { name: 'test (macos-latest)', status: 'PASS' },
      { name: 'test (windows-latest)', status: 'PASS' },
      { name: 'audit', status: 'PASS' },
      { name: 'package (macos, macos-latest, npm run pack:mac)', status: 'PASS' },
      { name: 'package (windows, windows-latest, npm run pack:win)', status: 'PASS' },
    ],
  };
  const requiredCommands = [
    'npm test', 'npm run test:manager', 'npm run test:click', 'npm run test:multi',
    'npm run test:packaging', 'npm run test:security', 'npm run test:release',
  ];
  summary.testCommands = [...requiredCommands];
  summary.testResults = requiredCommands.map(command => ({ command, status: 'PASS', exitCode: 0 }));
  Object.assign(summary.testResults.find(result => result.command === 'npm run test:manager'), {
    firstProcess: { passed: 4, failed: 0, total: 4 },
    restartProcess: { passed: 4, failed: 0, total: 4 },
  });
  summary.managerScenarios = [
    { name: 'single-flight-exact-runtime', status: 'PASS', passed: 1, total: 1 },
    { name: 'restart-exact-character', status: 'PASS', passed: 1, total: 1 },
    { name: 'draft-retention-recovery', status: 'PASS', passed: 1, total: 1 },
    {
      name: 'first-frame-before-success', status: 'PASS', passed: 1, total: 1,
      timings: calibratedTimings({
        T0: 10, T1: 20, T2: 30, T3: 40, T4: 50, T5: 80, T6: 90,
      }),
    },
  ];
  summary.packageResults = [
    {
      platform: 'macos', command: 'npm run package:macos', status: 'PASS',
      verifyStatus: 'PASS', artifactCount: 1, noticeStatus: 'PASS', asarStatus: 'PASS',
    },
    {
      platform: 'windows', command: 'npm run package:windows', status: 'PASS',
      verifyStatus: 'PASS', artifactCount: 1, noticeStatus: 'PASS', asarStatus: 'PASS',
    },
  ];
  summary.nativePlatformStatus = {
    windows: 'HOSTED_PACKAGE_VERIFIED',
    macos: 'HOSTED_PACKAGE_VERIFIED',
    signingNotarization: 'UNVERIFIED',
  };
  summary.performanceSummary.sourceDirty = false;
  summary.performanceSummary.protocolQualified = true;
  summary.performanceSummary.protocol = protocol;
  summary.performanceSummary.provenance = {
    identityVersion: 'core-loop-performance-run-identity-v1',
    appGitSha: GIT_SHA,
    harnessGitSha: 'c'.repeat(40),
    harnessSourceClean: true,
    harnessVersion: 'core-loop-harness-v1',
    performanceHarnessVersion: 'core-loop-performance-harness-v3',
    comparisonVersion: 'core-loop-performance-comparison-v2',
    probeIdentity: 'poppet-core-loop-electron-probe-v4',
    probeSourceSha256: 'd'.repeat(64),
    fixtureIdentity: 'e'.repeat(64),
    settingsIdentity: 'f'.repeat(64),
    protocolIdentity: performanceProtocolIdentity(protocol),
    environmentIdentity: '1'.repeat(64),
    driverNodeVersion: '22.23.2',
    electronVersion: '39.2.7',
    electronNodeVersion: '22.20.0',
  };
  const minimumSeriesSamples = durationMs => Math.max(1,
    Math.floor(durationMs / protocol.sampleIntervalMs) - 1);
  for (const topology of protocol.petCounts) {
    const row = summary.performanceSummary.byTopology[topology];
    row.samples = protocol.repetitions * (
      (topology + 1) * minimumSeriesSamples(protocol.idleMs)
      + (topology + 1) * minimumSeriesSamples(protocol.activeMs)
      + minimumSeriesSamples(protocol.recoveryMs)
    );
    row.frameIntervalSampleCount = Math.max(1, row.frameIntervalSampleCount);
    row.frameIntervalOverflowCount = 0;
    row.crashes = 0;
    row.unhandledErrors = 0;
    row.postDestroyPetCountMax = 0;
    row.postDestroyWindowCountMax = 0;
    row.postDestroyTimerDeltaMax = 0;
    row.postDestroyListenerDeltaMax = 0;
  }
  const minimumSoakSamples = (protocol.soakPets + 1) * minimumSeriesSamples(protocol.soakMs);
  summary.performanceSummary.soak = {
    samples: minimumSoakSamples,
    durationMs: PERFORMANCE_PROTOCOL.soakMs,
    memoryTrend: {
      status: 'AVAILABLE',
      combinedMemoryTheilSenMiBPerMinute: 0,
      combinedMemoryTheilSenLower95MiBPerMinute: 0,
      firstTenMinuteMedianMiB: 200,
      lastTenMinuteMedianMiB: 200,
      lastMinusFirstMedianMiB: 0,
      bootstrapSamples: PERFORMANCE_PROTOCOL.bootstrapSamples,
      bootstrapSeed: PERFORMANCE_PROTOCOL.bootstrapSeed,
      regressionDetected: false,
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
    comparisonToPreChange: {
      comparisonVersion: 'core-loop-performance-comparison-v2',
      status: 'NO_REGRESSION_DETECTED',
      claimEligible: true,
      regressionDetected: false,
      sameMachineAttested: true,
      beforeGitSha: 'b'.repeat(40),
      afterGitSha: GIT_SHA,
    },
  };
  const aggregateSampleCount = minimumSoakSamples
    + Object.values(summary.performanceSummary.byTopology)
      .reduce((sum, row) => sum + row.samples, 0);
  summary.performanceSummary.evidenceBinding = {
    bindingVersion: 'core-loop-performance-evidence-binding-v2',
    samplesSha256: '2'.repeat(64),
    sampleCount: aggregateSampleCount,
    beforeSamplesSha256: '3'.repeat(64),
    beforeSampleCount: aggregateSampleCount,
    afterSamplesSha256: '2'.repeat(64),
    afterSampleCount: aggregateSampleCount,
    comparisonArtifactSha256: '4'.repeat(64),
    pairedBlockCount: 1,
    metricResultCount: 1,
    hardCheckCount: 1,
  };
  const acceptanceEvidence = {
    ciBundle: { ciRun: structuredClone(summary.ciRun) },
    performanceBundle: {
      evidenceBinding: structuredClone(summary.performanceSummary.evidenceBinding),
      comparisonProjection: structuredClone(
        summary.performanceSummary.soak.comparisonToPreChange),
    },
  };
  summary.acceptanceBinding.ciEvidenceDigest = acceptanceEvidenceDigest(
    'ci', acceptanceEvidence.ciBundle);
  summary.acceptanceBinding.performanceEvidenceDigest = acceptanceEvidenceDigest(
    'performance', acceptanceEvidence.performanceBundle);
  summary.failureCounts.PERFORMANCE_REGRESSION = 0;
  summary.failureCounts.ENVIRONMENT_FAILURE = 0;
  return { summary, acceptanceEvidence };
}

function failure(overrides = {}) {
  return {
    class: 'PREVIEW_FAILURE',
    stage: 'preview',
    recoverable: true,
    supportedScope: true,
    errorCode: 'POPPET_PREVIEW_FAILURE',
    claimImpact: 'preview required recovery',
    ...overrides,
  };
}

test('failure taxonomy is fixed and complete', () => {
  assert.deepEqual(FAILURE_CLASSES, [
    'CI_SOURCE_CONTRACT', 'CI_HOST_LAYOUT_ASSUMPTION', 'PACKAGED_NOTICE_MISSING',
    'PACKAGED_NOTICE_STALE', 'ASAR_MANIFEST_DRIFT', 'INPUT_BUDGET_REJECTED',
    'UNSUPPORTED_COMPLEX_BACKGROUND', 'SUBJECT_EXTRACTION_FAILURE',
    'SUBJECT_EXTRACTION_UNCERTAIN', 'FACE_OR_PARTS_DETECTION_FAILURE',
    'MANUAL_FIX_REQUIRED', 'PIXELIZE_FAILURE', 'PREVIEW_FAILURE',
    'PERSISTENCE_FAILURE', 'SPAWN_FAILURE', 'RESTART_RECOVERY_FAILURE',
    'RUNTIME_COMPOSITION_FAILURE', 'PERFORMANCE_REGRESSION', 'TEST_FIXTURE_ERROR',
    'ENVIRONMENT_FAILURE', 'HUMAN_EVIDENCE_UNAVAILABLE',
    'RIGHTS_OR_PROVENANCE_BLOCKED',
  ]);
});

test('case records use an allowlist and reject private or binary payloads', () => {
  const record = validCase();
  assert.equal(validateCaseRecord(record), record);

  assert.throws(() => validateCaseRecord({ ...record, path: 'C:\\Users\\person\\pet.png' }),
    /forbidden private key|unknown key/);
  assert.throws(() => validateCaseRecord({ ...record, imageBytes: Buffer.from('private') }),
    /binary bytes|forbidden private key/);
  assert.throws(() => validateCaseRecord({ ...record, File_Name: 'opaque' }),
    /forbidden private key/);
  assert.throws(() => validCase({
    hardwareClass: { logicalCpuBucket: 'private-person', memoryGiBBucket: '17-32' },
  }), /logicalCpuBucket is invalid/);
  assert.throws(() => validCase({ chosenPreset: 'private-person' }),
    /chosenPreset is invalid/);

  for (const identifying of [
    'failed C:\\Users\\person\\pet.png',
    'failed /home/person/pet.png',
    'failed error=/home/person/pet.png',
    'failed path:/Users/person/pet.png',
    'failed ..\\private\\pet',
    'failed photos/private-person',
    'download https://example.test/input',
    'download example.test/input',
    'download example.xyz/input',
    'remote ssh:private-user@private-host',
    'data:image/png;base64,iVBORw0KGgoAAA',
    'peer 192.168.1.44:8080',
    'peer 2001:db8::1',
    'peer localhost:8080',
    'source pet.png',
    'source .env',
    'source private.7z',
    'username: private-person',
    '用户名：私人用户',
  ]) {
    assert.throws(() => validateCaseRecord({ ...record, warnings: [identifying] }),
      /contains a private/,
    `direct record validation must reject ${identifying}`);
  }
});

test('diagnostic sanitization removes a whole diagnostic containing identity-bearing text', () => {
  assert.equal(sanitizeDiagnosticText('failed C:\\Users\\Secret Name\\pet.png'), '[redacted-diagnostic]');
  assert.equal(sanitizeDiagnosticText('download https://example.test/input.png'), '[redacted-diagnostic]');
  assert.equal(sanitizeDiagnosticText('peer 10.0.0.8'), '[redacted-diagnostic]');
  assert.equal(sanitizeDiagnosticText('source pet.png'), '[redacted-diagnostic]');
  assert.equal(sanitizeDiagnosticText('username: private-person'), '[redacted-diagnostic]');
  assert.equal(sanitizeDiagnosticText('stable POPPET_RESOURCE_LIMIT'), 'stable POPPET_RESOURCE_LIMIT');
});

test('artifact writer rejects identifying strings before creating output', t => {
  const target = path.join(ARTIFACTS_ROOT, `privacy-reject-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => writeLocalArtifacts({
    directory: target,
    records: [validCase()],
    summary: createMilestoneSummary(),
    markdown: 'private input was pet.png',
  }), /markdown artifact contains a private (?:filename|URL)/);
  assert.equal(fs.existsSync(target), false);

  const serializerTarget = `${target}-serializer`;
  const serializerSummary = createMilestoneSummary();
  Object.defineProperty(serializerSummary.remainingGates, 'toJSON', {
    value: () => ['C:\\Users\\private-user\\pet.png'],
  });
  assert.throws(() => writeLocalArtifacts({
    directory: serializerTarget,
    records: [validCase()],
    summary: serializerSummary,
    markdown: 'privacy-safe aggregate evidence only',
  }), /custom array property|private Windows path/);
  assert.equal(fs.existsSync(serializerTarget), false);

  let markdownCoercions = 0;
  const statefulMarkdown = {
    toString() {
      markdownCoercions++;
      return markdownCoercions === 1
        ? 'privacy-safe aggregate evidence only'
        : 'C:\\Users\\private-user\\pet.png';
    },
  };
  assert.throws(() => writeLocalArtifacts({
    directory: `${target}-markdown-coercion`,
    records: [validCase()],
    summary: createMilestoneSummary(),
    markdown: statefulMarkdown,
  }), /markdown artifact must be a string/);
  assert.equal(markdownCoercions, 0);

  const safeTarget = `${target}-safe`;
  t.after(() => {
    if (fs.existsSync(safeTarget)) fs.rmSync(safeTarget, { recursive: true, force: false });
  });
  const relative = writeLocalArtifacts({
    directory: safeTarget,
    records: [validCase()],
    summary: createMilestoneSummary(),
    markdown: 'privacy-safe aggregate evidence only',
  });
  assert.match(relative, /^\.artifacts\/core-loop\//);
  assert.equal(fs.existsSync(path.join(safeTarget, 'cases.jsonl')), true);
});

test('automation cannot populate human time or human fixes', () => {
  const timings = emptyTimings();
  timings.clock = { mode: 'main-receipt-monotonic', calibrationUncertaintyMs: 0 };
  timings.humanEndToEndTimeMs = 500;
  assert.throws(() => validCase({ timings }), /automation cannot populate humanEndToEndTimeMs/);
  assert.throws(() => validCase({ fixesNeeded: 1 }), /automation cannot populate fixesNeeded/);
});

test('human correction fields and claim eligibility fail closed', () => {
  assert.throws(() => validCase({
    evidenceKind: 'human-product', actor: 'human', rightsStatus: 'rights-cleared',
    claimEligible: true, fixesNeeded: null,
  }), /claim-eligible product evidence/);
  assert.throws(() => validCase({
    evidenceKind: 'human-product', actor: 'human', rightsStatus: 'rights-cleared',
    claimEligible: true, fixesNeeded: 0, scriptedFixes: 1,
  }), /human evidence cannot populate scriptedFixes/);
  assert.throws(() => validCase({
    evidenceKind: 'automated-engineering', actor: 'automation', rightsStatus: 'unverified',
    fixesNeeded: null, scriptedFixes: 1, outcome: 'success',
  }), /success cannot contain failures, corrections, or recovery use/);
});

test('outcome, failure, correction, and recovery semantics are consistent', () => {
  assert.throws(() => validCase({ failures: [failure()] }),
    /success cannot contain failures/);
  assert.throws(() => validCase({ outcome: 'failed', failures: [] }),
    /failed requires a supported-scope failure/);
  assert.throws(() => validCase({
    outcome: 'recovered', failures: [failure()], recoveryUsed: false,
  }), /recovered requires/);
  assert.doesNotThrow(() => validCase({
    outcome: 'recovered', failures: [failure()], recoveryUsed: true,
  }));
  assert.throws(() => validCase({
    outcome: 'recovered', failures: [failure({ recoverable: false })],
    scriptedFixes: 1, recoveryUsed: true,
  }), /recovered requires/);
  assert.throws(() => validCase({
    outcome: 'rejected', failures: [failure()], recoveryUsed: false,
  }), /rejected requires a preregistered unsupported input/);
  assert.throws(() => validCase({
    outcome: 'rejected',
    failures: [failure({
      class: 'UNSUPPORTED_COMPLEX_BACKGROUND', supportedScope: false,
      errorCode: 'POPPET_UNSUPPORTED_BACKGROUND',
    })],
    recoveryUsed: false,
  }), /supportedScope must match the preregistered input bucket/);
  assert.doesNotThrow(() => validCase({
    inputBucket: 'unsupported',
    outcome: 'rejected',
    failures: [failure({
      class: 'UNSUPPORTED_COMPLEX_BACKGROUND', supportedScope: false,
      errorCode: 'POPPET_UNSUPPORTED_BACKGROUND',
    })],
    recoveryUsed: false,
  }));
  assert.throws(() => validCase({ recoveryUsed: 'false' }), /case boolean fields are invalid/);
});

test('uncalibrated renderer clocks cannot produce cross-process T0-T6 metrics', () => {
  const timings = emptyTimings();
  timings.markersMs.T0 = 0;
  timings.markersMs.T5 = 100;
  timings.createToPetReadyMs = 100;
  assert.throws(() => validCase({ timings }), /uncalibrated cross-process timing/);

  const singleDomain = emptyTimings();
  singleDomain.clock = { mode: 'main-receipt-monotonic', calibrationUncertaintyMs: 0 };
  singleDomain.markersMs.T0 = 0;
  singleDomain.markersMs.T5 = 100;
  singleDomain.humanEndToEndTimeMs = null;
  assert.doesNotThrow(() => validCase({ timings: singleDomain }));

  const calibrated = emptyTimings();
  calibrated.clock = { mode: 'calibrated-cross-process', calibrationUncertaintyMs: 2.5 };
  calibrated.markersMs.T0 = 0;
  calibrated.markersMs.T5 = 100;
  assert.doesNotThrow(() => validCase({ timings: calibrated }));
});

test('marker-derived durations are exact and missing markers force null', () => {
  const timings = calibratedTimings({
    T0: 10, T1: 30, T2: 50, T3: 70, T4: 90, T5: 120, T6: 125,
  });
  assert.equal(timings.timeToSourcePreviewMs, 20);
  assert.equal(timings.timeToProcessedPreviewMs, 40);
  assert.equal(timings.createToPetReadyMs, 50);
  assert.equal(timings.systemTimeToPetMs, 90);
  assert.doesNotThrow(() => validCase({ timings }));

  for (const [key, value] of [
    ['timeToSourcePreviewMs', 21],
    ['timeToProcessedPreviewMs', 41],
    ['createToPetReadyMs', 51],
    ['systemTimeToPetMs', 91],
  ]) {
    assert.throws(() => validCase({ timings: { ...timings, [key]: value } }),
      /marker-derived duration/);
  }

  const missing = calibratedTimings({ T0: 10, T2: 50, T3: 70, T5: 120 });
  missing.timeToSourcePreviewMs = 0;
  assert.throws(() => validCase({ timings: missing }), /must be null when a required marker is missing/);
});

test('human end-to-end time is T5 minus T0 only for qualifying completed humans', () => {
  const humanTimings = calibratedTimings({
    T0: 10, T1: 20, T2: 30, T3: 40, T4: 50, T5: 80, T6: 90,
  }, { human: true });
  assert.doesNotThrow(() => validCase({
    evidenceKind: 'human-product', actor: 'human', rightsStatus: 'rights-cleared',
    claimEligible: true, fixesNeeded: 0, timings: humanTimings,
  }));
  assert.throws(() => validCase({
    evidenceKind: 'human-product', actor: 'human', rightsStatus: 'rights-cleared',
    claimEligible: true, fixesNeeded: 0,
    timings: { ...humanTimings, humanEndToEndTimeMs: 71 },
  }), /must equal T5 - T0/);
  assert.throws(() => validCase({
    evidenceKind: 'human-product', actor: 'human', rightsStatus: 'rights-cleared',
    claimEligible: false, fixesNeeded: 0, timings: humanTimings,
  }), /completed claim-eligible human trial/);

  const missing = calibratedTimings({ T0: 10, T1: 20, T2: 30, T3: 40, T4: 50, T6: 90 });
  missing.humanEndToEndTimeMs = 70;
  assert.throws(() => validCase({
    evidenceKind: 'human-product', actor: 'human', rightsStatus: 'rights-cleared',
    claimEligible: true, fixesNeeded: 0, timings: missing,
  }), /must be null when T0 or T5 is missing/);
});

test('synthetic and unapproved records cannot enter the qualifying corpus denominator', () => {
  const synthetic = validCase();
  const eligible = validCase({
    caseId: 'case-002',
    evidenceKind: 'human-product',
    actor: 'human',
    fixesNeeded: 0,
    claimEligible: true,
    rightsStatus: 'rights-cleared',
  });
  const { counts } = aggregateCaseRecords([synthetic, eligible]);
  assert.equal(counts.total, 2);
  assert.equal(counts.syntheticAuxiliary, 0);
  assert.equal(counts.rightsClearedSupported, 1);

  const auxiliary = validCase({
    evidenceKind: 'synthetic-auxiliary',
    rightsStatus: 'project-synthetic',
  });
  assert.equal(aggregateCaseRecords([auxiliary]).counts.rightsClearedSupported, 0);

  assert.throws(() => validCase({
    evidenceKind: 'synthetic-auxiliary',
    rightsStatus: 'project-synthetic',
    claimEligible: true,
  }), /claim-eligible product evidence/,
  'synthetic evidence must never be promoted into a product denominator');
  assert.throws(() => validCase({
    evidenceKind: 'automated-engineering',
    rightsStatus: 'rights-cleared',
    claimEligible: true,
  }), /claim-eligible product evidence/,
  'automation may prove engineering behavior but cannot become product evidence');
  assert.throws(() => validCase({
    evidenceKind: 'human-product',
    actor: 'automation',
    rightsStatus: 'rights-cleared',
  }), /human-product evidence and a human actor/);
  assert.throws(() => validCase({
    evidenceKind: 'synthetic-auxiliary',
    rightsStatus: 'rights-cleared',
  }), /synthetic-auxiliary evidence must use project-synthetic rights/);
});

test('rights-cleared supported scope includes supported and recovery, never unsupported', () => {
  const supported = validCase({
    caseId: 'supported-human', evidenceKind: 'human-product', actor: 'human',
    fixesNeeded: 0, claimEligible: true, rightsStatus: 'rights-cleared',
    inputBucket: 'supported',
  });
  const recovery = validCase({
    caseId: 'recovery-human', evidenceKind: 'human-product', actor: 'human',
    fixesNeeded: 1, claimEligible: true, rightsStatus: 'rights-cleared',
    inputBucket: 'recovery', outcome: 'recovered', recoveryUsed: true,
  });
  assert.throws(() => validCase({
    caseId: 'unsupported-human', evidenceKind: 'human-product', actor: 'human',
    fixesNeeded: 0, claimEligible: true, rightsStatus: 'rights-cleared',
    inputBucket: 'unsupported', outcome: 'rejected', recoveryUsed: false,
    failures: [failure({
      class: 'UNSUPPORTED_COMPLEX_BACKGROUND', supportedScope: false,
      errorCode: 'POPPET_UNSUPPORTED_BACKGROUND',
    })],
  }), /supported-scope human actor/);
  const unsupported = validCase({
    caseId: 'unsupported-human', evidenceKind: 'human-product', actor: 'human',
    fixesNeeded: 0, claimEligible: false, rightsStatus: 'rights-cleared',
    inputBucket: 'unsupported', outcome: 'rejected', recoveryUsed: false,
    failures: [failure({
      class: 'UNSUPPORTED_COMPLEX_BACKGROUND', supportedScope: false,
      errorCode: 'POPPET_UNSUPPORTED_BACKGROUND',
    })],
  });
  const { counts } = aggregateCaseRecords([supported, recovery, unsupported]);
  assert.deepEqual(counts.byBucket, { supported: 1, recovery: 1, unsupported: 1 });
  assert.equal(counts.rightsClearedSupported, 2);
  assert.equal(counts.rightsClearedSupportedCompleted, 2);
  assert.equal(counts.rightsClearedSupportedCompletedWithinOneFix, 2);
});

test('the project synthetic runner emits 12 auxiliary, privacy-safe records', () => {
  const { records, summary } = runSyntheticCorpus({
    runId: 'synthetic-test',
    gitSha: GIT_SHA,
    branch: 'main',
    now: new Date('2026-08-20T00:00:00.000Z'),
  });
  assert.equal(records.length, 12);
  assert.ok(records.every(record => record.evidenceKind === 'synthetic-auxiliary'));
  assert.ok(records.every(record => record.claimEligible === false));
  assert.ok(records.every(record => record.timings.humanEndToEndTimeMs === null));
  assert.equal(summary.corpusCounts.rightsClearedSupported, 0);
  assert.equal(summary.corpusCounts.syntheticAuxiliary, 12);
  assert.equal(summary.productVerdict, 'HUMAN_REQUIRED');
});

test('artifact output cannot escape the ignored Core-loop root', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-core-loop-contract-'));
  const root = path.join(projectRoot, '.artifacts', 'core-loop');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: false }));
  const options = { artifactsRoot: root, projectRoot };
  const inside = resolveArtifactDirectory(path.join(root, 'run'), options);
  assert.equal(inside.target, path.join(root, 'run'));
  assert.throws(() => resolveArtifactDirectory(path.join(root, '..', 'escape'), options),
    /must be a child/);
  assert.throws(() => resolveArtifactDirectory(path.join(projectRoot, 'outside'), {
    artifactsRoot: projectRoot,
    projectRoot,
  }), /artifact root must be a child/);
});

test('artifact resolution rejects a symlink in an ancestor above artifactsRoot', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-core-loop-symlink-'));
  const real = path.join(projectRoot, 'real');
  const link = path.join(projectRoot, 'linked-parent');
  fs.mkdirSync(real);
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fs.rmSync(projectRoot, { recursive: true, force: false });
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmSync(projectRoot, { recursive: true, force: false });
  });
  const artifactsRoot = path.join(link, '.artifacts', 'core-loop');
  assert.throws(() => resolveArtifactDirectory(path.join(artifactsRoot, 'run'), {
    artifactsRoot,
    projectRoot,
  }), /not a regular directory/);
});

test('the committed machine summary contains the complete required schema', () => {
  const file = new URL('../../docs/reports/core-loop-excellence.summary.json', import.meta.url);
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (summary.engineeringVerdict === 'CORE_LOOP_ENGINEERING_ACCEPTED') {
    const acceptanceFile = new URL(
      '../../docs/reports/core-loop-excellence.acceptance.json', import.meta.url);
    const stat = fs.lstatSync(acceptanceFile);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    const acceptanceEvidence = JSON.parse(fs.readFileSync(acceptanceFile, 'utf8'));
    assert.equal(validateMilestoneSummary(summary, { acceptanceEvidence }), summary);
  } else {
    assert.equal(summary.engineeringVerdict, 'PARTIAL_VERIFIED');
    assert.equal(validateMilestoneSummary(summary), summary);
  }
  assert.equal(summary.productVerdict, 'HUMAN_REQUIRED');
  assert.equal(summary.humanTrialCounts.participants, 0);
});

test('committed summary validation rejects nested private payloads and only allows explicit GitHub evidence URLs', () => {
  // createMilestoneSummary validates immediately, so build mutations from a
  // known-good summary for the negative cases.
  assert.throws(() => validateMilestoneSummary({
    ...createMilestoneSummary(),
    testResults: [{ command: 'npm test', status: 'PASS', path: 'C:\\Users\\person\\input.png' }],
  }), /forbidden private key|absolute path/);
  assert.throws(() => validateMilestoneSummary({
    ...createMilestoneSummary(),
    packageResults: [{ platform: 'win32', status: 'PASS', bytes: Buffer.from('image') }],
  }), /binary bytes|forbidden private key/);
  assert.doesNotThrow(() => validateMilestoneSummary({
    ...createMilestoneSummary(),
    gitSha: GIT_SHA,
    ciRun: { url: 'https://github.com/SioYooo/poppet/actions/runs/123', gitSha: GIT_SHA, jobs: [] },
  }));
  assert.throws(() => validateMilestoneSummary({
    ...createMilestoneSummary(),
    gitSha: GIT_SHA,
    ciRun: { url: 'https://example.test/run/123', gitSha: GIT_SHA, jobs: [] },
  }), /private URL|ciRun.url is invalid/);
});

test('milestone nested schemas enforce exact keys, enums, and aggregate arithmetic', () => {
  const base = createMilestoneSummary();
  assert.equal(base.failureCounts.HUMAN_EVIDENCE_UNAVAILABLE, 1);
  assert.equal(base.failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED, 1);
  const missingCorpusKey = structuredClone(base);
  delete missingCorpusKey.corpusCounts.recovery;
  assert.throws(() => validateMilestoneSummary(missingCorpusKey), /corpusCounts is missing key: recovery/);

  assert.throws(() => validateMilestoneSummary({
    ...base,
    engineeringVerdict: 'LOOKS_GOOD',
  }), /engineeringVerdict is invalid/);
  assert.throws(() => validateMilestoneSummary({
    ...base,
    corpusCounts: {
      ...base.corpusCounts,
      supported: 1,
      recovery: 1,
      rightsClearedSupported: 3,
    },
  }), /exceeds supported-scope denominator/);
  assert.throws(() => validateMilestoneSummary({
    ...base,
    corpusCounts: { ...base.corpusCounts, syntheticAuxiliary: 1 },
  }), /syntheticByBucket is required/);
  assert.throws(() => validateMilestoneSummary({
    ...base,
    corpusCounts: { ...base.corpusCounts, rightsClearedSupportedCompleted: 0 },
  }), /completion metrics must be declared together/);
  assert.throws(() => validateMilestoneSummary({
    ...base,
    humanTrialCounts: { participants: 1, completed: 2, within60Seconds: 0 },
  }), /within60Seconds <= completed <= participants/);
  assert.throws(() => validateMilestoneSummary({
    ...base,
    nativePlatformStatus: { ...base.nativePlatformStatus, windows: 'TRUST_ME' },
  }), /nativePlatformStatus.windows is invalid/);
  assert.throws(() => validateMilestoneSummary({
    ...base,
    testResults: [{ command: 'npm test', status: 'PASS', failed: 1, total: 1 }],
  }), /PASS disagrees/);

  const missingHumanGate = structuredClone(base);
  missingHumanGate.failureCounts.HUMAN_EVIDENCE_UNAVAILABLE = 0;
  assert.throws(() => validateMilestoneSummary(missingHumanGate),
    /requires HUMAN_EVIDENCE_UNAVAILABLE/);
  const missingRightsGate = structuredClone(base);
  missingRightsGate.failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED = 0;
  assert.throws(() => validateMilestoneSummary(missingRightsGate),
    /requires RIGHTS_OR_PROVENANCE_BLOCKED/);
});

test('CI evidence is always exact-SHA and engineering acceptance requires every hosted role', () => {
  const base = createMilestoneSummary();
  assert.throws(() => validateMilestoneSummary({
    ...base,
    gitSha: GIT_SHA,
    ciRun: {
      url: 'https://github.com/SioYooo/poppet/actions/runs/123',
      gitSha: 'b'.repeat(40),
      jobs: [],
    },
  }), /exact summary gitSha/);
  assert.throws(() => validateMilestoneSummary({
    ...base,
    generatedAt: '2026-08-20T00:00:00.000Z',
    gitSha: GIT_SHA,
    branch: 'main',
    engineeringVerdict: 'CORE_LOOP_ENGINEERING_ACCEPTED',
  }), /same-SHA CI/);

  const incompleteCi = {
    url: 'https://github.com/SioYooo/poppet/actions/runs/123',
    gitSha: GIT_SHA,
    jobs: [{ name: 'audit', status: 'PASS' }],
  };
  assert.throws(() => validateMilestoneSummary({
    ...base,
    generatedAt: '2026-08-20T00:00:00.000Z',
    gitSha: GIT_SHA,
    branch: 'main',
    ciRun: incompleteCi,
    engineeringVerdict: 'CORE_LOOP_ENGINEERING_ACCEPTED',
  }), /all required same-SHA CI jobs/);

  const completeCi = {
    ...incompleteCi,
    jobs: [
      { name: 'test (ubuntu-latest)', status: 'PASS' },
      { name: 'test (macos-latest)', status: 'PASS' },
      { name: 'test (windows-latest)', status: 'PASS' },
      { name: 'audit', status: 'PASS' },
      { name: 'package (macos, macos-latest, npm run pack:mac)', status: 'PASS' },
      { name: 'package (windows, windows-latest, npm run pack:win)', status: 'PASS' },
    ],
  };
  assert.throws(() => validateMilestoneSummary({
    ...base,
    generatedAt: '2026-08-20T00:00:00.000Z',
    gitSha: GIT_SHA,
    branch: 'main',
    ciRun: completeCi,
    engineeringVerdict: 'CORE_LOOP_ENGINEERING_ACCEPTED',
  }), /claim-eligible same-machine no-regression comparison/);
});

test('product validation cannot be manufactured from zero corpus or human evidence', () => {
  const base = createMilestoneSummary();
  assert.throws(() => validateMilestoneSummary({
    ...base,
    productVerdict: 'CORE_LOOP_PRODUCT_VALIDATED',
  }), /qualifying corpus, human, timing, and rights evidence/);

  assert.throws(() => validateMilestoneSummary({
    ...base,
    productVerdict: 'CORE_LOOP_PRODUCT_VALIDATED',
    corpusCounts: {
      ...base.corpusCounts,
      supported: 50,
      rightsClearedSupported: 50,
      rightsClearedSupportedCompleted: 45,
      rightsClearedSupportedCompletedWithinOneFix: 45,
    },
    humanTrialCounts: { participants: 5, completed: 4, within60Seconds: 3 },
    timingSummary: {
      automatedPipelineOnly: false,
      humanEndToEndTimeMs: 45_000,
      timeToPetAvailable: true,
    },
    rightsStatus: 'RIGHTS_CLEARED',
  }), /requires CORE_LOOP_ENGINEERING_ACCEPTED/);
});

test('coarse hardware tail buckets are non-overlapping', () => {
  assert.deepEqual(summarizeHardwareClass({
    logicalCpuCount: 64,
    totalMemoryBytes: 128 * 1024 ** 3,
  }), { logicalCpuBucket: '>32', memoryGiBBucket: '>64' });
});

test('the canonical document preregisters timings, correction semantics, and report artifacts', () => {
  const file = new URL('../../docs/core-loop-excellence.md', import.meta.url);
  const document = fs.readFileSync(file, 'utf8');
  for (const marker of ['`T0`', '`T1`', '`T2`', '`T3`', '`T4`', '`T5`', '`T6`']) {
    assert.match(document, new RegExp(marker.replace(/`/g, '\\`')));
  }
  for (const failureClass of FAILURE_CLASSES) assert.match(document, new RegExp(`\\b${failureClass}\\b`));
  assert.match(document, /fixesNeeded/);
  assert.match(document, /core-loop-excellence\.summary\.json/);
  assert.match(document, /humanEndToEndTime.*valid only for an observed human trial/s);
});

test('the performance harness is developer-only and excluded from production packages', () => {
  const file = new URL('../../package.json', import.meta.url);
  const packageJson = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(packageJson.scripts['measure:performance'], 'node tools/core-loop-performance.mjs');
  assert.ok(packageJson.build.files.includes('!tools/**/*'));
  assert.notEqual(packageJson.main, 'tools/core-loop-electron-probe-main.cjs');
});

test('performance arguments default to the preregistered 1/3/6 plus one-hour soak protocol', () => {
  const defaults = parsePerformanceArgs([]);
  assert.deepEqual(PERFORMANCE_PROTOCOL.petCounts, [1, 3, 6]);
  assert.equal(defaults.soakMs, 60 * 60_000);
  assert.equal(defaults.protocolQualified, true);

  const smoke = parsePerformanceArgs([
    '--app-root', 'baseline-worktree',
    '--repetitions', '1', '--warmup-ms', '10', '--idle-ms', '10',
    '--active-ms', '10', '--recovery-ms', '10', '--soak-warmup-ms', '10',
    '--soak-ms', '20', '--sample-interval-ms', '5',
  ]);
  assert.equal(smoke.soakMs, 20);
  assert.equal(smoke.appRoot, 'baseline-worktree');
  assert.equal(smoke.protocolQualified, false);
});

function sampleInput({ topology, repetition, phase, processType, processSlot, elapsedMs = 0 }) {
  return {
    topology,
    repetition,
    phase,
    elapsedMs,
    processType,
    processSlot,
    cpuPercent: processType === 'main' ? 2 : 1,
    memoryMiB: processType === 'main' ? 100 : 50,
    frameIntervalMs: processType === 'renderer' ? 16.7 : null,
    renderWorkMs: processType === 'renderer' ? 1.2 : null,
    longFrame: false,
    eventLoopStallMs: 0,
    crashCount: 0,
    unhandledErrorCount: 0,
    petCount: phase === 'recovery' ? 0 : topology,
    windowCount: phase === 'recovery' ? 0 : topology,
    timerCount: phase === 'recovery' ? 0 : topology,
    listenerCount: phase === 'recovery' ? 0 : topology,
  };
}

test('performance sample schema rejects process identifiers and private extras', () => {
  const sample = createPerformanceSample({
    runId: 'performance-test', gitSha: GIT_SHA,
    ...sampleInput({ topology: 1, repetition: 1, phase: 'idle', processType: 'main', processSlot: 0 }),
  });
  assert.equal(validatePerformanceSample(sample), sample);
  assert.throws(() => validatePerformanceSample({ ...sample, pid: 1234 }), /unknown key/);
});

test('performance driver requires complete main and renderer coverage for 1/3/6 and soak', async () => {
  const config = parsePerformanceArgs([
    '--repetitions', '1', '--warmup-ms', '1', '--idle-ms', '1',
    '--active-ms', '1', '--recovery-ms', '1', '--soak-warmup-ms', '1',
    '--soak-ms', '1', '--sample-interval-ms', '1',
  ]);
  const probe = {
    async collectPerformanceScenario({ config: scenario, emit }) {
      for (const phase of ['idle', 'active']) {
        emit(sampleInput({ ...scenario, phase, processType: 'main', processSlot: 0 }));
        // gpu/utility 是同 tick 快照里的可选成员：v4 探针会发出它们，
        // 完整性断言必须容纳而不误报"快照不完整"。
        emit(sampleInput({ ...scenario, phase, processType: 'gpu', processSlot: 0 }));
        emit(sampleInput({ ...scenario, phase, processType: 'utility', processSlot: 0 }));
        for (let slot = 1; slot <= scenario.topology; slot++) {
          emit(sampleInput({ ...scenario, phase, processType: 'renderer', processSlot: slot }));
        }
      }
      emit(sampleInput({ ...scenario, phase: 'recovery', processType: 'main', processSlot: 0 }));
    },
    async collectPerformanceSoak({ config: soak, emit }) {
      emit(sampleInput({
        ...soak, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs: 0,
      }));
      emit(sampleInput({
        ...soak, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs: 1,
      }));
      for (let slot = 1; slot <= soak.topology; slot++) {
        emit(sampleInput({ ...soak, phase: 'soak', processType: 'renderer', processSlot: slot }));
      }
    },
  };
  const { samples, summary } = await runPerformanceProtocol({
    probe,
    config,
    runId: 'performance-test',
    gitSha: GIT_SHA,
    branch: 'main',
    now: new Date('2026-08-20T00:00:00.000Z'),
  });
  assert.ok(samples.length > 0);
  assert.deepEqual(Object.keys(summary.performanceSummary.byTopology), ['1', '3', '6']);
  assert.equal(summary.performanceSummary.protocolQualified, false);
  assert.equal(summary.performanceSummary.soak.durationMs, 1);
  assert.equal(summary.performanceSummary.soak.memoryTrend.status, 'UNAVAILABLE');
  assert.equal(summary.performanceSummary.soak.memoryTrend.regressionDetected, null);
  assert.equal(summary.performanceSummary.soak.resourceTrend.status, 'AVAILABLE');
  assert.equal(summary.performanceSummary.soak.resourceTrend.sustainedGrowthDetected, false);
  assert.equal(summary.failureCounts.PERFORMANCE_REGRESSION, 0);

  const unknown = structuredClone(summary);
  unknown.performanceSummary.rawSamples = [];
  assert.throws(() => validateMilestoneSummary(unknown), /performanceSummary contains unknown key/);
  const missingTopology = structuredClone(summary);
  delete missingTopology.performanceSummary.byTopology['3'];
  assert.throws(() => validateMilestoneSummary(missingTopology),
    /performanceSummary.byTopology is missing key: 3/);
  const wrongAppSha = structuredClone(summary);
  wrongAppSha.performanceSummary.provenance.appGitSha = 'b'.repeat(40);
  assert.throws(() => validateMilestoneSummary(wrongAppSha), /exact summary gitSha/);
  const wrongProtocolIdentity = structuredClone(summary);
  wrongProtocolIdentity.performanceSummary.provenance.protocolIdentity = '0'.repeat(64);
  assert.throws(() => validateMilestoneSummary(wrongProtocolIdentity), /does not match protocol/);

  const smokeProjection = {
    comparisonVersion: 'core-loop-performance-comparison-v2',
    status: 'SMOKE_ONLY',
    claimEligible: false,
    regressionDetected: false,
    sameMachineAttested: false,
    beforeGitSha: 'b'.repeat(40),
    afterGitSha: GIT_SHA,
  };
  const projected = structuredClone(summary);
  projected.performanceSummary.soak.comparisonToPreChange = smokeProjection;
  assert.doesNotThrow(() => validateMilestoneSummary(projected));
  const wrongAfter = structuredClone(projected);
  wrongAfter.performanceSummary.soak.comparisonToPreChange.afterGitSha = 'c'.repeat(40);
  assert.throws(() => validateMilestoneSummary(wrongAfter), /afterGitSha must equal/);
  const inconsistent = structuredClone(projected);
  inconsistent.performanceSummary.soak.comparisonToPreChange.status = 'NO_REGRESSION_DETECTED';
  assert.throws(() => validateMilestoneSummary(inconsistent), /verdict fields are inconsistent/);

  const { summary: accepted, acceptanceEvidence } = engineeringAcceptedSummary(summary);
  const validateAccepted = candidate => validateMilestoneSummary(candidate, {
    acceptanceEvidence,
  });
  assert.deepEqual(Object.fromEntries(Object.entries(accepted.performanceSummary.byTopology)
    .map(([topology, row]) => [topology, row.samples])), {
    1: 795, 3: 1503, 6: 2565,
  });
  assert.equal(accepted.performanceSummary.soak.samples, 25_193);
  assert.throws(() => validateMilestoneSummary(accepted),
    /requires external CI\/performance evidence bundles/);
  assert.doesNotThrow(() => validateAccepted(accepted));
  assert.equal(
    acceptanceEvidenceDigest('ci', { z: 1, a: { y: 2, x: 3 } }),
    acceptanceEvidenceDigest('ci', { a: { x: 3, y: 2 }, z: 1 }),
  );

  const tamperedCiEvidence = structuredClone(acceptanceEvidence);
  tamperedCiEvidence.ciBundle.ciRun.jobs[0].status = 'FAIL';
  assert.throws(() => validateMilestoneSummary(accepted, {
    acceptanceEvidence: tamperedCiEvidence,
  }), /external CI evidence bundle does not match/);

  const tamperedPerformanceEvidence = structuredClone(acceptanceEvidence);
  tamperedPerformanceEvidence.performanceBundle.evidenceBinding.samplesSha256 = '8'.repeat(64);
  assert.throws(() => validateMilestoneSummary(accepted, {
    acceptanceEvidence: tamperedPerformanceEvidence,
  }), /external performance evidence bundle does not match/);

  const substringCiRoles = structuredClone(accepted);
  substringCiRoles.ciRun.jobs = [
    { name: 'contest ubuntu macos windows', status: 'PASS' },
    { name: 'not-audit', status: 'PASS' },
    { name: 'unpackaged macos windows', status: 'PASS' },
  ];
  assert.throws(() => validateAccepted(substringCiRoles),
    /all required same-SHA CI jobs/);

  const handAuthoredCiAliases = structuredClone(accepted);
  handAuthoredCiAliases.ciRun.jobs = [
    { name: 'test ubuntu', status: 'PASS' },
    { name: 'test macos', status: 'PASS' },
    { name: 'test windows', status: 'PASS' },
    { name: 'audit', status: 'PASS' },
    { name: 'package macos', status: 'PASS' },
    { name: 'package windows', status: 'PASS' },
  ];
  assert.throws(() => validateAccepted(handAuthoredCiAliases),
    /all required same-SHA CI jobs/);

  const crossPlatformPackageRole = structuredClone(accepted);
  crossPlatformPackageRole.ciRun.jobs.find(job =>
    job.name.startsWith('package (macos,')).name =
      'package (macos, windows-latest, npm run pack:mac)';
  assert.throws(() => validateAccepted(crossPlatformPackageRole),
    /all required same-SHA CI jobs/);

  const missingAcceptanceBinding = structuredClone(accepted);
  missingAcceptanceBinding.acceptanceBinding = null;
  assert.throws(() => validateAccepted(missingAcceptanceBinding),
    /detached acceptance evidence binding/);

  const carrierAsSubject = structuredClone(accepted);
  carrierAsSubject.acceptanceBinding.subjectGitSha = '7'.repeat(40);
  assert.throws(() => validateAccepted(carrierAsSubject),
    /must equal the evidence app gitSha/);

  const docsOnlyCarrier = structuredClone(accepted);
  docsOnlyCarrier.acceptanceBinding.reportCarrierMode = 'DOCS_ONLY_DESCENDANT_OF_SUBJECT';
  docsOnlyCarrier.commits.push({
    sha: '7'.repeat(40),
    purpose: 'DOCS_ONLY_REPORT_CARRIER_DESCENDANT_ATTESTATION',
  });
  assert.doesNotThrow(() => validateAccepted(docsOnlyCarrier));
  const carrierMasqueradingAsApp = structuredClone(accepted);
  carrierMasqueradingAsApp.commits.push({
    sha: GIT_SHA,
    purpose: 'DOCS_ONLY_REPORT_CARRIER_DESCENDANT_ATTESTATION',
  });
  assert.throws(() => validateAccepted(carrierMasqueradingAsApp),
    /cannot masquerade as the evidence app SHA/);

  const missingRawBinding = structuredClone(accepted);
  delete missingRawBinding.performanceSummary.evidenceBinding;
  assert.throws(() => validateAccepted(missingRawBinding),
    /immutable raw-sample and comparison evidence binding/);

  const sparseTopology = structuredClone(accepted);
  sparseTopology.performanceSummary.byTopology['1'].samples--;
  sparseTopology.performanceSummary.evidenceBinding.sampleCount--;
  sparseTopology.performanceSummary.evidenceBinding.afterSampleCount--;
  assert.throws(() => validateAccepted(sparseTopology),
    /locked-protocol 1-pet sample density/);

  const sparseSoak = structuredClone(accepted);
  sparseSoak.performanceSummary.soak.samples--;
  sparseSoak.performanceSummary.evidenceBinding.sampleCount--;
  sparseSoak.performanceSummary.evidenceBinding.afterSampleCount--;
  assert.throws(() => validateAccepted(sparseSoak),
    /locked-protocol soak sample density/);

  const missingMetric = structuredClone(accepted);
  missingMetric.performanceSummary.byTopology['3'].meanMainCpuPercent = null;
  assert.throws(() => validateAccepted(missingMetric),
    /lacks 3-pet meanMainCpuPercent evidence/);

  const mismatchedRawCount = structuredClone(accepted);
  mismatchedRawCount.performanceSummary.evidenceBinding.sampleCount++;
  assert.throws(() => validateAccepted(mismatchedRawCount),
    /disagrees with the final aggregate sample coverage/);

  const stalePerformanceManifestDigest = structuredClone(accepted);
  stalePerformanceManifestDigest.acceptanceBinding.performanceEvidenceDigest = '9'.repeat(64);
  assert.throws(() => validateAccepted(stalePerformanceManifestDigest),
    /performance evidence digest does not match/);

  const missingRequiredCommand = structuredClone(accepted);
  missingRequiredCommand.testResults = missingRequiredCommand.testResults
    .filter(result => result.command !== 'npm run test:security');
  assert.throws(() => validateAccepted(missingRequiredCommand),
    /successful npm run test:security test result/);

  const missingManagerTiming = structuredClone(accepted);
  missingManagerTiming.managerScenarios
    .find(result => result.name === 'first-frame-before-success').timings.markersMs.T6 = null;
  assert.throws(() => validateAccepted(missingManagerTiming),
    /calibrated T0-T6 first-frame Manager timings/);

  const stalePackageNotice = structuredClone(accepted);
  stalePackageNotice.packageResults.find(result => result.platform === 'macos').noticeStatus = 'FAIL';
  assert.throws(() => validateAccepted(stalePackageNotice),
    /verified macOS package evidence/);

  const sourceOnlyNative = structuredClone(accepted);
  sourceOnlyNative.nativePlatformStatus.windows = 'SOURCE_ELECTRON_SMOKE_ONLY';
  assert.throws(() => validateAccepted(sourceOnlyNative),
    /hosted-package-or-better Windows and macOS evidence/);

  const falsifiedMemoryVerdict = structuredClone(accepted);
  falsifiedMemoryVerdict.performanceSummary.soak.memoryTrend.regressionDetected = true;
  assert.throws(() => validateAccepted(falsifiedMemoryVerdict),
    /memory trend regression verdict is inconsistent/);

  const hiddenPerformanceFailure = structuredClone(accepted);
  const hiddenResourceTrend = hiddenPerformanceFailure.performanceSummary.soak.resourceTrend;
  Object.assign(hiddenResourceTrend, {
    timerLastWindowMedianDelta: hiddenResourceTrend.timerFirstWindowMedianDelta + 1,
    timerTheilSenDeltaPerMinute: 1,
    sustainedGrowthDetected: true,
  });
  assert.throws(() => validateAccepted(hiddenPerformanceFailure),
    /detected performance regressions require PERFORMANCE_REGRESSION/);

  const product = structuredClone(accepted);
  product.productVerdict = 'CORE_LOOP_PRODUCT_VALIDATED';
  product.corpusCounts = {
    ...product.corpusCounts,
    supported: 50,
    rightsClearedSupported: 50,
    rightsClearedSupportedCompleted: 45,
    rightsClearedSupportedCompletedWithinOneFix: 45,
  };
  product.humanTrialCounts = { participants: 5, completed: 4, within60Seconds: 3 };
  product.timingSummary = {
    automatedPipelineOnly: false,
    humanEndToEndTimeMs: 45_000,
    timeToPetAvailable: true,
  };
  product.rightsStatus = 'RIGHTS_CLEARED';
  product.failureCounts.HUMAN_EVIDENCE_UNAVAILABLE = 0;
  product.failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED = 0;
  assert.doesNotThrow(() => validateAccepted(product));

  const belowCorpusTarget = structuredClone(product);
  belowCorpusTarget.corpusCounts.rightsClearedSupportedCompletedWithinOneFix = 44;
  assert.throws(() => validateAccepted(belowCorpusTarget),
    /qualifying corpus, human, timing, and rights evidence/);

  const weakParticipantRatio = structuredClone(product);
  weakParticipantRatio.humanTrialCounts = {
    participants: 6, completed: 4, within60Seconds: 3,
  };
  assert.throws(() => validateAccepted(weakParticipantRatio),
    /qualifying corpus, human, timing, and rights evidence/);

  const missingHumanDuration = structuredClone(product);
  missingHumanDuration.timingSummary.humanEndToEndTimeMs = null;
  assert.throws(() => validateAccepted(missingHumanDuration),
    /conflicts with unavailable product evidence/);
});

test('performance driver fails closed on missing or sustained soak resource trends', async () => {
  const config = parsePerformanceArgs([
    '--repetitions', '1', '--warmup-ms', '1', '--idle-ms', '1',
    '--active-ms', '1', '--recovery-ms', '1', '--soak-warmup-ms', '1',
    '--soak-ms', '2', '--sample-interval-ms', '1',
  ]);
  const scenario = async ({ config: current, emit }) => {
    for (const phase of ['idle', 'active']) {
      emit(sampleInput({ ...current, phase, processType: 'main', processSlot: 0 }));
      for (let slot = 1; slot <= current.topology; slot++) {
        emit(sampleInput({ ...current, phase, processType: 'renderer', processSlot: slot }));
      }
    }
    emit(sampleInput({ ...current, phase: 'recovery', processType: 'main', processSlot: 0 }));
  };
  const missing = {
    collectPerformanceScenario: scenario,
    async collectPerformanceSoak({ config: soak, emit }) {
      emit(sampleInput({ ...soak, phase: 'soak', processType: 'main', processSlot: 0 }));
      for (let slot = 1; slot <= soak.topology; slot++) {
        emit(sampleInput({ ...soak, phase: 'soak', processType: 'renderer', processSlot: slot }));
      }
    },
  };
  await assert.rejects(() => runPerformanceProtocol({
    probe: missing, config, runId: 'resource-missing', gitSha: GIT_SHA, branch: 'main',
  }), /at least two main-process samples/);

  const growing = {
    collectPerformanceScenario: scenario,
    async collectPerformanceSoak({ config: soak, emit }) {
      for (let elapsedMs = 1; elapsedMs <= 3; elapsedMs++) {
        emit({
          ...sampleInput({
            ...soak, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs,
          }),
          timerCount: elapsedMs,
          listenerCount: elapsedMs,
        });
      }
      for (let slot = 1; slot <= soak.topology; slot++) {
        emit(sampleInput({ ...soak, phase: 'soak', processType: 'renderer', processSlot: slot }));
      }
    },
  };
  const { summary } = await runPerformanceProtocol({
    probe: growing, config, runId: 'resource-growing', gitSha: GIT_SHA, branch: 'main',
  });
  assert.equal(summary.performanceSummary.soak.resourceTrend.sustainedGrowthDetected, true);
  assert.equal(summary.failureCounts.PERFORMANCE_REGRESSION, 1);
});

test('qualified soak applies the locked deterministic bootstrap memory gate', async () => {
  const config = parsePerformanceArgs([]);
  const probe = {
    async collectPerformanceScenario({ config: scenario, emit }) {
      for (const phase of ['idle', 'active']) {
        emit(sampleInput({ ...scenario, phase, processType: 'main', processSlot: 0 }));
        for (let slot = 1; slot <= scenario.topology; slot++) {
          emit(sampleInput({ ...scenario, phase, processType: 'renderer', processSlot: slot }));
        }
      }
      emit(sampleInput({ ...scenario, phase: 'recovery', processType: 'main', processSlot: 0 }));
    },
    async collectPerformanceSoak({ config: soak, emit }) {
      for (let minute = 0; minute < 60; minute++) {
        const elapsedMs = minute * 60_000 + 1_000;
        emit({
          ...sampleInput({
            ...soak, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs,
          }),
          memoryMiB: 100 + minute * 2,
          timerCount: 0,
          listenerCount: 0,
        });
        for (let slot = 1; slot <= soak.topology; slot++) {
          emit(sampleInput({
            ...soak, phase: 'soak', processType: 'renderer', processSlot: slot, elapsedMs,
          }));
        }
      }
    },
  };
  const { summary } = await runPerformanceProtocol({
    probe, config, runId: 'memory-growing', gitSha: GIT_SHA, branch: 'main', sourceDirty: false,
  });
  const trend = summary.performanceSummary.soak.memoryTrend;
  assert.equal(trend.status, 'AVAILABLE');
  assert.equal(trend.bootstrapSamples, 10_000);
  assert.equal(trend.bootstrapSeed, 0x4b5454);
  assert.ok(trend.combinedMemoryTheilSenLower95MiBPerMinute > 1);
  assert.ok(trend.lastMinusFirstMedianMiB > 20);
  assert.equal(trend.regressionDetected, true);
  assert.equal(summary.failureCounts.PERFORMANCE_REGRESSION, 1);
  assert.equal(summary.failureCounts.ENVIRONMENT_FAILURE, 0);
});

test('summary constructor fails closed when a failure class count is missing', () => {
  const summary = createMilestoneSummary();
  delete summary.failureCounts.ENVIRONMENT_FAILURE;
  assert.throws(() => validateMilestoneSummary(summary), /failureCounts/);
});

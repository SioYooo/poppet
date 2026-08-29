// Explicit, developer-only synthetic Core-loop diagnostic.
//
// This runs project-created morphology fixtures through the local pipeline and
// writes only privacy-filtered JSON/JSONL/Markdown under .artifacts/core-loop.
// It is auxiliary engineering evidence: it is not a novice trial, Time-to-Pet,
// identity-preservation result, or qualifying product corpus.

import crypto from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { buildCharacter } from '../src/shared/pipeline.js';
import { normalizeParts } from '../src/shared/parts.js';
import { FIXTURES } from './fixtures.mjs';
import {
  aggregateCaseRecords,
  classifyFailure,
  coarseHardwareClass,
  createCaseRecord,
  createMilestoneSummary,
  currentGitBranch,
  currentGitSha,
  emptyTimings,
  renderLocalRunMarkdown,
  resolveArtifactDirectory,
  writeLocalArtifacts,
} from './core-loop-contract.mjs';

const modulePath = fileURLToPath(import.meta.url);

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return args[index + 1];
}

export function parseCorpusArgs(args = process.argv.slice(2)) {
  const known = new Set(['--output']);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!known.has(value)) throw new Error(`Unknown core-loop corpus option: ${value}`);
    index++;
  }
  return { output: argumentValue(args, '--output') };
}

function failureRecord(error, stage = 'pipeline', supportedScope = true) {
  return {
    class: classifyFailure(error, stage),
    stage,
    recoverable: false,
    supportedScope,
    errorCode: typeof error?.code === 'string' && /^[A-Z0-9_-]+$/.test(error.code)
      ? error.code : null,
    claimImpact: 'synthetic auxiliary pipeline diagnostic only',
  };
}

function expectedFaceResult(result, expected) {
  if (expected === null) return true;
  const parts = normalizeParts(result?.meta?.parts);
  const found = parts.some(part => part.role === 'eye');
  return found === expected;
}

export function runSyntheticCorpus({
  fixtures = FIXTURES,
  runId = `synthetic-${crypto.randomUUID()}`,
  gitSha = currentGitSha(),
  branch = currentGitBranch(),
  now = new Date(),
} = {}) {
  if (!gitSha) throw new Error('A Git SHA is required for a measurement run');
  const records = [];
  const hardwareClass = coarseHardwareClass();

  fixtures.forEach((fixture, index) => {
    const caseId = `synthetic-${String(index + 1).padStart(3, '0')}`;
    let source = null;
    let result = null;
    let error = null;
    const failures = [];
    const started = performance.now();
    try {
      source = fixture.make();
      result = buildCharacter(source);
      if (!expectedFaceResult(result, fixture.expectFace)) {
        const mismatch = new Error('Synthetic fixture face expectation mismatch');
        mismatch.code = 'POPPET_FIXTURE_EXPECTATION';
        failures.push(failureRecord(mismatch, 'fixture'));
      }
      if (result?.meta?.source?.extraction?.status === 'needs-advanced-extraction') {
        failures.push({
          class: 'UNSUPPORTED_COMPLEX_BACKGROUND',
          stage: 'subject-extraction',
          recoverable: true,
          supportedScope: false,
          errorCode: null,
          claimImpact: 'synthetic auxiliary pipeline diagnostic only',
        });
      }
    } catch (caught) {
      error = caught;
      failures.push(failureRecord(caught, source ? 'pipeline' : 'fixture'));
    }
    const pipelineMs = Math.max(0, performance.now() - started);
    const width = source?.width || 1;
    const height = source?.height || 1;
    const rejected = failures.some(failure => failure.class === 'UNSUPPORTED_COMPLEX_BACKGROUND'
      || failure.class === 'INPUT_BUDGET_REJECTED');
    const record = createCaseRecord({
      runId,
      gitSha,
      hardwareClass,
      evidenceKind: 'synthetic-auxiliary',
      actor: 'automation',
      caseId,
      inputBucket: 'supported',
      width,
      height,
      frameCount: 1,
      chosenPreset: 'original',
      extractorMode: result?.meta?.source?.extraction?.mode ?? null,
      timings: emptyTimings({ pipelineMs }),
      fixesNeeded: null,
      scriptedFixes: 0,
      outcome: failures.length ? (rejected ? 'rejected' : 'failed') : 'success',
      failures,
      recoveryUsed: false,
      warnings: [
        ...(result?.report?.warnings || []),
        ...(error ? [error.message || 'Synthetic pipeline failure'] : []),
      ],
      claimEligible: false,
      rightsStatus: 'project-synthetic',
    });
    records.push(record);
  });

  const { counts, failureCounts } = aggregateCaseRecords(records);
  const summary = createMilestoneSummary({
    generatedAt: now.toISOString(),
    gitSha,
    branch,
    engineeringVerdict: records.some(record => record.outcome === 'failed')
      ? 'PARTIAL_VERIFIED' : 'PARTIAL_VERIFIED',
    productVerdict: 'HUMAN_REQUIRED',
    evidenceBoundaries: [
      'LOCAL_SYNTHETIC_AUXILIARY',
      'NOT_HUMAN_TIME_TO_PET',
      'NOT_IDENTITY_OR_STYLE_VALIDATION',
      'NO_NETWORK_OR_TELEMETRY',
    ],
    testCommands: ['npm run measure:core-loop'],
    testResults: [{
      command: 'npm run measure:core-loop',
      status: records.some(record => record.outcome === 'failed') ? 'FAIL' : 'PASS',
      passed: counts.byOutcome.success,
      failed: counts.byOutcome.failed,
      rejected: counts.byOutcome.rejected,
      total: counts.total,
      evidence: 'synthetic-auxiliary',
    }],
    corpusCounts: {
      supported: 0,
      recovery: 0,
      unsupported: 0,
      rightsClearedSupported: 0,
      syntheticAuxiliary: counts.syntheticAuxiliary,
      syntheticByBucket: counts.byBucket,
    },
    humanTrialCounts: { participants: 0, completed: 0, within60Seconds: 0 },
    timingSummary: {
      automatedPipelineOnly: true,
      humanEndToEndTimeMs: null,
      timeToPetAvailable: false,
    },
    performanceSummary: null,
    failureCounts,
    rightsStatus: 'RIGHTS_OR_PROVENANCE_BLOCKED',
    remainingGates: [
      'Rights-cleared supported corpus is 0/50.',
      'Qualifying novice participants are 0/5.',
      'Synthetic pipeline timing cannot replace T0-T6 or human decision time.',
    ],
    nextAction: 'Run the exact-character first-frame core-loop oracle once its runtime acknowledgement exists.',
  });
  return { records, summary };
}

export function writeSyntheticCorpusRun({ output = null } = {}) {
  const { target } = resolveArtifactDirectory(output, { label: 'synthetic' });
  const { records, summary } = runSyntheticCorpus();
  const markdown = renderLocalRunMarkdown({
    title: 'Poppet Core Loop synthetic diagnostic',
    summary,
    auxiliaryNote: 'Project-generated synthetic pipeline coverage only. It does not qualify a product corpus or human Time-to-Pet claim.',
  });
  const relative = writeLocalArtifacts({ directory: target, records, summary, markdown });
  return { relative, records, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  try {
    const options = parseCorpusArgs();
    const { relative, records } = writeSyntheticCorpusRun(options);
    const failed = records.filter(record => record.outcome === 'failed').length;
    const rejected = records.filter(record => record.outcome === 'rejected').length;
    console.log(`[core-loop] synthetic auxiliary ${records.length - failed - rejected}/${records.length} passed; ${rejected} rejected; ${failed} failed`);
    console.log(`[core-loop] local artifacts: ${relative}`);
    process.exit(failed ? 1 : 0);
  } catch (error) {
    console.error(`[core-loop] ${error?.stack || error}`);
    process.exit(1);
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createMilestoneSummary,
} from '../../tools/core-loop-contract.mjs';
import {
  finalizeCoreLoopAcceptance,
  parseAcceptanceFinalizeArgs,
} from '../../tools/core-loop-acceptance-finalize.mjs';

test('acceptance finalizer rejects an unverified in-memory performance bundle', () => {
  assert.throws(() => finalizeCoreLoopAcceptance({
    afterSummary: createMilestoneSummary(),
    verifiedPerformanceEvidence: {
      comparison: { milestoneProjection: {} },
      evidenceBinding: {},
      afterSummary: {},
    },
    ciBundle: { ciRun: null },
  }), /must come from raw artifact verification/);
});

test('acceptance finalizer CLI requires both raw runs and aggregate inputs', () => {
  assert.deepEqual(parseAcceptanceFinalizeArgs([
    '--after-summary', '.artifacts/core-loop/final/summary.json',
    '--before-run', '.artifacts/core-loop/before',
    '--after-run', '.artifacts/core-loop/after',
    '--comparison', '.artifacts/core-loop/comparison',
    '--ci-bundle', '.artifacts/core-loop/ci/ci-bundle.json',
    '--output', '.artifacts/core-loop/acceptance',
  ]), {
    afterSummaryFile: '.artifacts/core-loop/final/summary.json',
    beforeRunDirectory: '.artifacts/core-loop/before',
    afterRunDirectory: '.artifacts/core-loop/after',
    comparisonDirectory: '.artifacts/core-loop/comparison',
    ciBundleFile: '.artifacts/core-loop/ci/ci-bundle.json',
    output: '.artifacts/core-loop/acceptance',
    reportCarrierMode: 'DETACHED_ARTIFACT',
  });
  assert.throws(() => parseAcceptanceFinalizeArgs([
    '--after-summary', 'summary.json',
    '--comparison', 'comparison',
    '--ci-bundle', 'ci.json',
  ]), /--before-run, --after-run/);

  const packageJson = JSON.parse(fs.readFileSync(
    new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['finalize:core-loop'],
    'node tools/core-loop-acceptance-finalize.mjs');
  assert.ok(packageJson.build.files.includes('!tools/**/*'));
});

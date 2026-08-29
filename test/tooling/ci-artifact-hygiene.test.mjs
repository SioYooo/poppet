// Ordinary CI is a verification lane, not a storage lane: the package jobs must
// never persist full installers (400-700 MB per platform pair, deleted after 7
// days) into Actions artifact storage. Only small, failure-gated smoke
// diagnostics may be uploaded. This test parses the real workflow YAML so the
// rule survives reformatting, and it deliberately scopes itself to ci.yml:
// release.yml's uploads are the cross-job lineage transfer that feeds the
// protected publish environment, which is a separate fail-closed architecture
// that an ordinary-CI hygiene rule must never misjudge or constrain.
//
// js-yaml is a transitive dependency of the direct devDependency
// electron-builder (the same assumption tools/precheck.mjs already makes when
// it validates workflow syntax).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const ciPath = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
const ci = load(fs.readFileSync(ciPath, 'utf8'));
const jobs = ci?.jobs ?? {};

function uploadSteps(job) {
  return (job?.steps ?? []).filter(step => typeof step?.uses === 'string' && step.uses.startsWith('actions/upload-artifact'));
}

function runs(job) {
  return (job?.steps ?? []).map(step => step?.run ?? '');
}

function failureGated(step) {
  return typeof step.if === 'string' && /(^|[^a-z])failure\(\)/.test(step.if);
}

test('the ordinary CI workflow grants itself read-only repository content', () => {
  assert.deepEqual(ci.permissions, { contents: 'read' });
});

test('the package job verifies the release inventory but uploads no installer artifact', () => {
  const pkg = jobs.package;
  assert.ok(pkg, 'ci.yml must keep its package job');

  assert.equal(uploadSteps(pkg).length, 0,
    'package job must not upload installers to Actions artifact storage; verification runs on the ephemeral runner');
  const commands = runs(pkg).join('\n');
  assert.match(commands, /\$\{\{ matrix\.command \}\}/, 'package job must still build the native package');
  assert.match(commands, /npm run verify:package/, 'package job must still verify the built app.asar');
  assert.match(commands, /collect-release-assets\.mjs/, 'package job must still validate the exact expected release file set');
});

test('every artifact upload that remains in ordinary CI is small failure diagnostics', () => {
  const uploads = Object.entries(jobs).flatMap(([name, job]) => uploadSteps(job).map(step => ({ name, step })));
  assert.ok(uploads.length > 0, 'smoke diagnostics upload must still exist; this rule guards size, not existence');
  for (const { name, step } of uploads) {
    assert.ok(failureGated(step), `${name}: uploads are allowed only with "if: failure()" diagnostics gating`);
    const retention = Number(step.with?.['retention-days']);
    assert.ok(Number.isInteger(retention) && retention > 0 && retention <= 7,
      `${name}: diagnostics retention must stay short (<= 7 days), got ${step.with?.['retention-days']}`);
    assert.equal(step.with?.['if-no-files-found'], 'ignore',
      `${name}: missing diagnostics must not fail the run`);
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NOT_PROVABLE_LOCALLY,
  PREFLIGHT_OMISSIONS,
  USAGE,
  packScriptForPlatform,
  parsePreflightArgs,
  runReleasePreflight,
} from '../../tools/release-preflight.mjs';

const script = fileURLToPath(new URL('../../tools/release-preflight.mjs', import.meta.url));

const WORKFLOW_ORDER = [
  'git-diff-check',
  'release-script-tests',
  'release-readiness',
  'npm-test',
  'npm-audit',
  'pack',
  'verify-package',
];

function recordingLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      log: (...args) => lines.push(args.join(' ')),
      error: (...args) => lines.push(args.join(' ')),
    },
  };
}

// Keyed by the spawned argument list so a test can fail exactly one gate.
function fakeSpawn(outcomes = {}) {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    const outcome = outcomes[args.join(' ')];
    if (typeof outcome === 'function') return outcome();
    return { status: outcome ?? 0, signal: null, error: undefined };
  };
  return { calls, impl };
}

function run(argv, { outcomes, platform = 'darwin', readPackageJson, environment } = {}) {
  const { calls, impl } = fakeSpawn(outcomes);
  const { lines, logger } = recordingLogger();
  const result = runReleasePreflight({
    argv,
    spawnSyncImpl: impl,
    cwd: '/repo/checkout',
    platform,
    logger,
    execPath: '/fake/node',
    environment: environment ?? { PATH: '/usr/bin' },
    readPackageJson: readPackageJson ?? (() => ({ version: '9.9.9-alpha.9' })),
  });
  return { ...result, calls, lines };
}

function argsOf(calls) {
  return calls.map(({ args }) => args.join(' '));
}

function statusesOf(steps) {
  return Object.fromEntries(steps.map(({ name, status }) => [name, status]));
}

test('all gates pass: exit 0, workflow spawn order, pack lane skipped by default', () => {
  const { exitCode, steps, calls } = run([]);

  assert.equal(exitCode, 0);
  assert.deepEqual(steps.map(({ name }) => name), WORKFLOW_ORDER);
  assert.deepEqual(argsOf(calls), [
    'diff --check',
    'tools/run-node-tests.mjs .github/scripts',
    '.github/scripts/check-release-readiness.mjs',
    'test',
    'audit --audit-level=high',
  ]);
  assert.deepEqual(calls.map(({ command }) => command), [
    'git', '/fake/node', '/fake/node', 'npm', 'npm',
  ]);
  assert.deepEqual(statusesOf(steps), {
    'git-diff-check': 'PASS',
    'release-script-tests': 'PASS',
    'release-readiness': 'PASS',
    'npm-test': 'PASS',
    'npm-audit': 'PASS',
    pack: 'SKIPPED',
    'verify-package': 'SKIPPED',
  });
  for (const step of steps.slice(0, 5)) assert.equal(step.exitCode, 0);
  assert.deepEqual(steps.map(({ command }) => command), [
    'git diff --check',
    'node tools/run-node-tests.mjs .github/scripts',
    'GITHUB_REF_NAME=v9.9.9-alpha.9 node .github/scripts/check-release-readiness.mjs',
    'npm test',
    'npm audit --audit-level=high',
    'npm run pack:mac',
    'npm run verify:package',
  ]);
  assert.match(steps[5].reason, /not requested; pass --pack/);
  assert.match(steps[6].reason, /not requested; pass --pack/);
});

test('every spawned gate inherits stdio, runs in the repository root, and spawns directly on POSIX', () => {
  const { calls } = run([]);
  assert.equal(calls.length, 5);
  for (const { options } of calls) {
    assert.equal(options.stdio, 'inherit');
    assert.equal(options.cwd, path.resolve('/repo/checkout'));
    assert.equal(options.shell, false);
  }
});

test('a failing readiness gate is FAIL, the remaining gates still run, and the exit code is 1', () => {
  const { exitCode, steps, calls } = run([], {
    outcomes: { '.github/scripts/check-release-readiness.mjs': 1 },
  });

  assert.equal(exitCode, 1);
  assert.equal(calls.length, 5, 'later gates must still be spawned without --fail-fast');
  assert.deepEqual(statusesOf(steps), {
    'git-diff-check': 'PASS',
    'release-script-tests': 'PASS',
    'release-readiness': 'FAIL',
    'npm-test': 'PASS',
    'npm-audit': 'PASS',
    pack: 'SKIPPED',
    'verify-package': 'SKIPPED',
  });
  assert.equal(steps[2].exitCode, 1);
  assert.equal(steps[2].reason, 'exit 1');
});

test('--fail-fast stops at the first FAIL and marks the unrun gates SKIPPED', () => {
  const { exitCode, steps, calls } = run(['--fail-fast'], {
    outcomes: { 'tools/run-node-tests.mjs .github/scripts': 3 },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(argsOf(calls), ['diff --check', 'tools/run-node-tests.mjs .github/scripts']);
  assert.deepEqual(statusesOf(steps), {
    'git-diff-check': 'PASS',
    'release-script-tests': 'FAIL',
    'release-readiness': 'SKIPPED',
    'npm-test': 'SKIPPED',
    'npm-audit': 'SKIPPED',
    pack: 'SKIPPED',
    'verify-package': 'SKIPPED',
  });
  assert.equal(steps[1].exitCode, 3);
  for (const step of steps.slice(2, 5)) {
    assert.equal(step.exitCode, null);
    assert.match(step.reason, /not run \(--fail-fast after release-script-tests failed\)/);
  }
});

test('--offline skips npm audit without spawning it and does not fail the run', () => {
  const { exitCode, steps, calls } = run(['--offline']);

  assert.equal(exitCode, 0);
  assert.ok(!argsOf(calls).includes('audit --audit-level=high'));
  assert.equal(calls.length, 4);
  assert.equal(steps[4].name, 'npm-audit');
  assert.equal(steps[4].status, 'SKIPPED');
  assert.equal(steps[4].exitCode, null);
  assert.match(steps[4].reason, /--offline/);
});

test('--pack on darwin builds with pack:mac and then verifies the package', () => {
  const { exitCode, steps, calls } = run(['--pack'], { platform: 'darwin' });

  assert.equal(exitCode, 0);
  assert.deepEqual(argsOf(calls).slice(-2), ['run pack:mac', 'run verify:package']);
  for (const { command, options } of calls.slice(-2)) {
    assert.equal(command, 'npm');
    assert.equal(options.shell, false);
  }
  assert.equal(steps[5].status, 'PASS');
  assert.equal(steps[6].status, 'PASS');
  assert.equal(steps[5].command, 'npm run pack:mac');
});

test('--pack on win32 uses npm.cmd through a shell with pack:win while git and node spawn directly', () => {
  const { exitCode, steps, calls } = run(['--pack'], { platform: 'win32' });

  assert.equal(exitCode, 0);
  assert.deepEqual(argsOf(calls), [
    'diff --check',
    'tools/run-node-tests.mjs .github/scripts',
    '.github/scripts/check-release-readiness.mjs',
    'test',
    'audit --audit-level=high',
    'run pack:win',
    'run verify:package',
  ]);
  for (const { command, options } of calls) {
    if (command === 'npm.cmd') assert.equal(options.shell, true);
    else assert.equal(options.shell, false);
  }
  assert.deepEqual(calls.map(({ command }) => command), [
    'git', '/fake/node', '/fake/node', 'npm.cmd', 'npm.cmd', 'npm.cmd', 'npm.cmd',
  ]);
  assert.equal(steps[5].command, 'npm.cmd run pack:win');
  assert.equal(steps[5].status, 'PASS');
  assert.equal(steps[6].status, 'PASS');
});

test('--pack on linux marks the pack lane SKIPPED instead of guessing a target', () => {
  const { exitCode, steps, calls } = run(['--pack'], { platform: 'linux' });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 5);
  assert.ok(!argsOf(calls).some(args => args.startsWith('run ')));
  assert.equal(steps[5].status, 'SKIPPED');
  assert.match(steps[5].reason, /no local pack target on linux/);
  assert.equal(steps[6].status, 'SKIPPED');
  assert.match(steps[6].reason, /linux/);
  assert.equal(packScriptForPlatform('linux'), null);
  assert.equal(packScriptForPlatform('darwin'), 'pack:mac');
  assert.equal(packScriptForPlatform('win32'), 'pack:win');
});

test('a failed pack skips package verification rather than verifying stale output', () => {
  const { exitCode, steps, calls } = run(['--pack'], {
    platform: 'darwin',
    outcomes: { 'run pack:mac': 1 },
  });

  assert.equal(exitCode, 1);
  assert.ok(!argsOf(calls).includes('run verify:package'));
  assert.equal(steps[5].status, 'FAIL');
  assert.equal(steps[6].status, 'SKIPPED');
  assert.match(steps[6].reason, /pack failed/);
});

test('the readiness gate receives GITHUB_REF_NAME derived from package.json and nothing else does', () => {
  let reads = 0;
  const { calls } = run([], {
    readPackageJson: () => { reads += 1; return { version: '4.5.6-rc.7' }; },
    environment: { PATH: '/usr/bin', HOME: '/home/poppet' },
  });

  assert.equal(reads, 1);
  const readiness = calls.find(({ args }) => args[0] === '.github/scripts/check-release-readiness.mjs');
  assert.deepEqual(readiness.options.env, {
    PATH: '/usr/bin',
    HOME: '/home/poppet',
    GITHUB_REF_NAME: 'v4.5.6-rc.7',
  });
  for (const { args, options } of calls) {
    if (args[0] === '.github/scripts/check-release-readiness.mjs') continue;
    assert.equal(options.env.GITHUB_REF_NAME, undefined);
    assert.equal(options.env.PATH, '/usr/bin');
  }
});

test('--tag overrides the derived tag in both argument forms', () => {
  for (const argv of [['--tag', 'v1.2.3-beta.4'], ['--tag=v1.2.3-beta.4']]) {
    const { exitCode, steps, calls } = run(argv, {
      readPackageJson: () => { throw new Error('package.json must not be consulted'); },
    });
    assert.equal(exitCode, 0);
    const readiness = calls.find(({ args }) => args[0] === '.github/scripts/check-release-readiness.mjs');
    assert.equal(readiness.options.env.GITHUB_REF_NAME, 'v1.2.3-beta.4');
    assert.equal(
      steps[2].command,
      'GITHUB_REF_NAME=v1.2.3-beta.4 node .github/scripts/check-release-readiness.mjs',
    );
  }
});

test('spawn failures, spawn errors, and signals are FAIL rather than crashes', () => {
  const { exitCode, steps, calls, lines } = run([], {
    outcomes: {
      'diff --check': () => ({ status: null, signal: null, error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }),
      '.github/scripts/check-release-readiness.mjs': () => { throw new Error('fake spawn failure'); },
      test: () => ({ status: null, signal: 'SIGKILL', error: undefined }),
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(calls.length, 5);
  assert.equal(steps[0].status, 'FAIL');
  assert.match(steps[0].reason, /could not start: spawn git ENOENT/);
  assert.equal(steps[2].status, 'FAIL');
  assert.match(steps[2].reason, /could not start: fake spawn failure/);
  assert.equal(steps[3].status, 'FAIL');
  assert.match(steps[3].reason, /terminated by SIGKILL/);
  assert.equal(steps[1].status, 'PASS');
  assert.equal(steps[4].status, 'PASS');
  assert.match(lines.join('\n'), /git-diff-check could not start: spawn git ENOENT/);
});

test('usage errors exit 2 without spawning anything', () => {
  for (const argv of [['--bogus'], ['--tag'], ['--tag', '--offline'], ['--tag=']]) {
    const { exitCode, steps, calls, lines } = run(argv);
    assert.equal(exitCode, 2, argv.join(' '));
    assert.deepEqual(steps, []);
    assert.equal(calls.length, 0);
    assert.match(lines.join('\n'), /Usage: node tools\/release-preflight\.mjs/);
  }
  assert.deepEqual(parsePreflightArgs(['--offline', '--pack', '--fail-fast', '--tag', 'v0.1.0-alpha.1']), {
    options: { tag: 'v0.1.0-alpha.1', offline: true, pack: true, failFast: true, help: false },
    errors: [],
  });
});

test('an underivable tag exits 2 before any gate runs', () => {
  for (const readPackageJson of [
    () => ({}),
    () => ({ version: '   ' }),
    () => { throw new Error('ENOENT package.json'); },
  ]) {
    const { exitCode, steps, calls, lines } = run([], { readPackageJson });
    assert.equal(exitCode, 2);
    assert.deepEqual(steps, []);
    assert.equal(calls.length, 0);
    assert.match(lines.join('\n'), /cannot derive the release tag/);
  }
});

test('the summary names every step with its status and ends with the evidence that cannot be proven locally', () => {
  const { lines } = run(['--offline'], {
    outcomes: { '.github/scripts/check-release-readiness.mjs': 1 },
  });
  const output = lines.join('\n');

  assert.match(output, /==== release-preflight summary ====/);
  // Status column is padEnd(7) plus a two-space gutter.
  assert.match(output, /^PASS {5}git-diff-check {8}git diff --check$/m);
  assert.match(output, /^FAIL {5}release-readiness {5}GITHUB_REF_NAME=v9\.9\.9-alpha\.9 node \.github\/scripts\/check-release-readiness\.mjs \(exit 1\)$/m);
  assert.match(output, /^SKIPPED {2}npm-audit {13}npm audit --audit-level=high -- --offline/m);
  assert.match(output, /^Result: FAIL \(3 passed, 1 failed, 3 skipped\)$/m);
  assert.match(output, /Not provable locally \(development evidence boundaries\):/);
  for (const item of NOT_PROVABLE_LOCALLY) assert.ok(output.includes(`- ${item}`), item);
  for (const item of PREFLIGHT_OMISSIONS) assert.ok(output.includes(`- ${item}`), item);
  for (const pattern of [
    /hosted Linux\/macOS\/Windows/, /Gatekeeper, and SmartScreen/, /signing and notarization/,
    /real-user acceptance/, /hosted Windows smoke job \(test:manager\)/,
  ]) assert.match(output, pattern);
  const summaryIndex = output.indexOf('==== release-preflight summary ====');
  const boundaryIndex = output.indexOf('Not provable locally');
  assert.ok(summaryIndex >= 0 && boundaryIndex > summaryIndex, 'the boundary list must follow the summary table');
});

test('the CLI entry prints usage and exits 0 with --help', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), USAGE.trim());
});

test('the CLI entry rejects unknown arguments with exit 2 before running any gate', () => {
  const result = spawnSync(process.execPath, [script, '--definitely-unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --definitely-unknown/);
  assert.equal(result.stdout, '');
});

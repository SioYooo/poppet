// Local aggregate of the `validate` gates in .github/workflows/release.yml plus
// an optional current-platform package lane. Each gate is spawned exactly as
// the workflow spawns it; the readiness script stays authoritative and
// fail-closed, so a RELEASE_BLOCKED verdict is reported here as FAIL, never
// special-cased. This command is local evidence only: it cannot stand in for
// the hosted matrix, native installation, signing, or real-user acceptance.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL('..', import.meta.url));

export const STEP_STATUSES = Object.freeze(['PASS', 'FAIL', 'SKIPPED']);

// Evidence boundaries that no local run can cross.
export const NOT_PROVABLE_LOCALLY = Object.freeze([
  'hosted Linux/macOS/Windows clean-checkout test matrix (workflow YAML is not a hosted CI run)',
  'native installation, Gatekeeper, and SmartScreen behavior (an unpacked or local package is not installer proof)',
  'code signing and notarization (Developer ID / Authenticode); local artifacts stay unsigned',
  'real-user acceptance on a native macOS or Windows machine',
  'the hosted Windows smoke job (test:manager) for this exact change; every change needs its own hosted run',
]);

// Workflow steps this command deliberately does not reproduce.
export const PREFLIGHT_OMISSIONS = Object.freeze([
  'npm ci (fresh-checkout reproducibility): this command reuses the existing node_modules',
  'remote tag/main lineage (check-release-lineage.mjs): only a pushed tag can be checked',
]);

export const USAGE = [
  'Usage: node tools/release-preflight.mjs [--tag vX.Y.Z-alpha.N] [--offline] [--pack] [--fail-fast]',
  '',
  'Runs the release.yml validate gates locally, in workflow order:',
  '  1. git diff --check',
  '  2. node tools/run-node-tests.mjs .github/scripts',
  '  3. GITHUB_REF_NAME=<tag> node .github/scripts/check-release-readiness.mjs',
  '  4. npm test',
  '  5. npm audit --audit-level=high        (SKIPPED with --offline)',
  '  6. npm run pack:mac | pack:win         (only with --pack; current platform)',
  '  7. npm run verify:package              (only with --pack; needs step 6)',
  '',
  '  --tag <tag>  override the tag derived from package.json version (v<version>)',
  '  --offline    skip npm audit (it needs registry access) and mark it SKIPPED',
  '  --pack       build and verify the current platform package (slow)',
  '  --fail-fast  stop at the first FAIL instead of running the remaining steps',
  '  --help, -h   print this message',
  '',
  'Exit code: 0 when no step failed, 1 when any step failed, 2 on usage errors.',
].join('\n');

export function parsePreflightArgs(argv = []) {
  const options = { tag: null, offline: false, pack: false, failFast: false, help: false };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--offline') {
      options.offline = true;
    } else if (arg === '--pack') {
      options.pack = true;
    } else if (arg === '--fail-fast') {
      options.failFast = true;
    } else if (arg === '--tag' || arg.startsWith('--tag=')) {
      let value;
      if (arg === '--tag') {
        const next = argv[index + 1];
        if (typeof next === 'string' && next !== '' && !next.startsWith('-')) {
          value = next;
          index += 1;
        }
      } else {
        value = arg.slice('--tag='.length);
      }
      if (typeof value !== 'string' || value === '') {
        errors.push('--tag requires a value such as --tag v0.1.0-alpha.1');
      } else {
        options.tag = value;
      }
    } else {
      errors.push(`unknown argument: ${arg}`);
    }
  }
  return { options, errors };
}

export function packScriptForPlatform(platform) {
  if (platform === 'darwin') return 'pack:mac';
  if (platform === 'win32') return 'pack:win';
  return null;
}

// Node refuses to spawn .cmd files without a shell (CVE-2024-27980 hardening),
// so npm on Windows goes through npm.cmd + shell, matching
// test/packaging/package-config.test.mjs. git and node are spawned directly.
function npmInvocation(platform) {
  return platform === 'win32'
    ? { executable: 'npm.cmd', display: 'npm.cmd', shell: true }
    : { executable: 'npm', display: 'npm', shell: false };
}

function plannedStep(name, invocation, args, extra = {}) {
  return {
    name,
    executable: invocation.executable,
    display: invocation.display,
    shell: invocation.shell,
    args,
    env: extra.env ?? {},
    skipReason: extra.skipReason ?? null,
    dependsOn: extra.dependsOn ?? null,
  };
}

export function displayCommand(step) {
  const prefix = Object.entries(step.env).map(([key, value]) => `${key}=${value} `).join('');
  return `${prefix}${[step.display, ...step.args].join(' ')}`;
}

export function planPreflightSteps({
  tag,
  offline = false,
  pack = false,
  platform = process.platform,
  execPath = process.execPath,
}) {
  const git = { executable: 'git', display: 'git', shell: false };
  const node = { executable: execPath, display: 'node', shell: false };
  const npm = npmInvocation(platform);
  const auditArgs = ['audit', '--audit-level=high'];

  const steps = [
    plannedStep('git-diff-check', git, ['diff', '--check']),
    plannedStep('release-script-tests', node, ['tools/run-node-tests.mjs', '.github/scripts']),
    plannedStep('release-readiness', node, ['.github/scripts/check-release-readiness.mjs'], {
      env: { GITHUB_REF_NAME: tag },
    }),
    plannedStep('npm-test', npm, ['test']),
    plannedStep('npm-audit', npm, auditArgs, offline
      ? { skipReason: '--offline: npm audit needs registry access' }
      : {}),
  ];

  const packScript = packScriptForPlatform(platform);
  const packArgs = ['run', packScript ?? 'pack:<platform>'];
  const verifyArgs = ['run', 'verify:package'];
  if (!pack) {
    const skipReason = 'not requested; pass --pack to build and verify the current platform package (slow, needs electron-builder)';
    steps.push(plannedStep('pack', npm, packArgs, { skipReason }));
    steps.push(plannedStep('verify-package', npm, verifyArgs, { skipReason }));
  } else if (!packScript) {
    steps.push(plannedStep('pack', npm, packArgs, {
      skipReason: `no local pack target on ${platform}; the hosted matrix builds macOS and Windows`,
    }));
    steps.push(plannedStep('verify-package', npm, verifyArgs, {
      skipReason: `no local package to verify on ${platform}`,
    }));
  } else {
    steps.push(plannedStep('pack', npm, packArgs));
    steps.push(plannedStep('verify-package', npm, verifyArgs, { dependsOn: 'pack' }));
  }
  return steps;
}

function executeStep(step, { spawnSyncImpl, cwd, environment, logger }) {
  let result;
  try {
    result = spawnSyncImpl(step.executable, step.args, {
      cwd,
      env: { ...environment, ...step.env },
      stdio: 'inherit',
      shell: step.shell,
    });
  } catch (error) {
    const reason = `could not start: ${error?.message || error}`;
    logger.error(`[release-preflight] ${step.name} ${reason}`);
    return { exitCode: 1, reason };
  }
  if (result?.error) {
    const reason = `could not start: ${result.error.message}`;
    logger.error(`[release-preflight] ${step.name} ${reason}`);
    return { exitCode: 1, reason };
  }
  if (result?.signal) {
    const reason = `terminated by ${result.signal}`;
    logger.error(`[release-preflight] ${step.name} ${reason}`);
    return { exitCode: 1, reason };
  }
  const exitCode = Number.isInteger(result?.status) ? result.status : 1;
  return { exitCode, reason: exitCode === 0 ? null : `exit ${exitCode}` };
}

function printSummary(steps, logger) {
  const width = Math.max(...steps.map(step => step.name.length));
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  logger.log('');
  logger.log('==== release-preflight summary ====');
  for (const step of steps) {
    counts[step.status] += 1;
    let suffix = '';
    if (step.status === 'SKIPPED') suffix = ` -- ${step.reason}`;
    else if (step.status === 'FAIL') suffix = ` (${step.reason})`;
    logger.log(`${step.status.padEnd(7)}  ${step.name.padEnd(width)}  ${step.command}${suffix}`);
  }
  const verdict = counts.FAIL ? 'FAIL' : 'PASS';
  logger.log(
    `Result: ${verdict} (${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIPPED} skipped)`,
  );
  logger.log('');
  logger.log('Not provable locally (development evidence boundaries):');
  for (const item of NOT_PROVABLE_LOCALLY) logger.log(`- ${item}`);
  logger.log('Not covered by this command:');
  for (const item of PREFLIGHT_OMISSIONS) logger.log(`- ${item}`);
}

export function runReleasePreflight({
  argv = [],
  spawnSyncImpl = spawnSync,
  cwd = defaultProjectRoot,
  platform = process.platform,
  logger = console,
  environment = process.env,
  execPath = process.execPath,
  readPackageJson = () => JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')),
} = {}) {
  const { options, errors } = parsePreflightArgs(argv);
  if (options.help) {
    logger.log(USAGE);
    return { exitCode: 0, steps: [] };
  }
  if (errors.length) {
    for (const error of errors) logger.error(`release-preflight: ${error}`);
    logger.error(USAGE);
    return { exitCode: 2, steps: [] };
  }

  let tag = options.tag;
  let tagSource = '--tag';
  if (!tag) {
    try {
      const pkg = readPackageJson();
      if (typeof pkg?.version !== 'string' || pkg.version.trim() === '') {
        throw new Error('package.json version is missing');
      }
      tag = `v${pkg.version.trim()}`;
      tagSource = 'package.json version';
    } catch (error) {
      logger.error(`release-preflight: cannot derive the release tag: ${error?.message || error}`);
      return { exitCode: 2, steps: [] };
    }
  }

  const resolvedCwd = path.resolve(cwd);
  const plan = planPreflightSteps({
    tag, offline: options.offline, pack: options.pack, platform, execPath,
  });
  logger.log(
    `[release-preflight] tag ${tag} (from ${tagSource}) | platform ${platform} | ${
      options.failFast ? 'fail-fast' : 'continue after failures'}`,
  );
  logger.log(`[release-preflight] cwd ${resolvedCwd}`);

  const steps = [];
  const failedNames = new Set();
  let firstFailure = null;
  for (const [index, planned] of plan.entries()) {
    const label = `${index + 1}/${plan.length} ${planned.name}`;
    const record = {
      name: planned.name,
      status: 'SKIPPED',
      command: displayCommand(planned),
      exitCode: null,
      reason: null,
    };
    steps.push(record);

    if (planned.skipReason) {
      record.reason = planned.skipReason;
    } else if (options.failFast && firstFailure) {
      record.reason = `not run (--fail-fast after ${firstFailure} failed)`;
    } else if (planned.dependsOn && failedNames.has(planned.dependsOn)) {
      record.reason = `${planned.dependsOn} failed; verifying a stale dist/ would not be package evidence`;
    }
    if (record.reason) {
      logger.log(`[release-preflight] ${label}: SKIPPED (${record.reason})`);
      continue;
    }

    logger.log(`[release-preflight] ${label}: ${record.command}`);
    const outcome = executeStep(planned, {
      spawnSyncImpl, cwd: resolvedCwd, environment, logger,
    });
    record.exitCode = outcome.exitCode;
    record.reason = outcome.reason;
    record.status = outcome.exitCode === 0 ? 'PASS' : 'FAIL';
    if (record.status === 'FAIL') {
      failedNames.add(planned.name);
      firstFailure ??= planned.name;
    }
    logger.log(`[release-preflight] ${label}: ${record.status} (exit ${record.exitCode})`);
  }

  printSummary(steps, logger);
  return { exitCode: failedNames.size ? 1 : 0, steps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  let exitCode = 1;
  try {
    ({ exitCode } = runReleasePreflight({ argv: process.argv.slice(2) }));
  } catch (error) {
    console.error(`release-preflight failed: ${error?.stack || error}`);
  }
  process.exit(exitCode);
}

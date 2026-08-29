// Local native-release qualification: run the automated half of the
// qualification chain on the current machine and emit one structured evidence
// report. The chain is exactly source-commit -> tests -> package -> package
// purity -> expected release inventory -> platform signature/trust observation.
// It never publishes, tags, uploads, or notarizes, and it cannot stand in for
// the manual GUI checklist, a quarantined download, or another operating
// system: see docs/native-release-qualification.md for what each tier proves.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL('..', import.meta.url));

export const USAGE = [
  'Usage: node tools/qualify-native.mjs [--smokes] [--allow-dirty] [--out <file>]',
  '',
  'Runs the automated native qualification chain for the current platform and',
  'writes a schemaVersion 1 evidence report (default under .artifacts/, which',
  'is git-ignored):',
  '  1. record commit/working-tree state (refuses a dirty tree without --allow-dirty)',
  '  2. npm test',
  '  3. npm run pack:mac | pack:win        (native build; Linux is refused, no cross-build evidence)',
  '  4. npm run verify:package             (production app.asar purity)',
  '  5. collect-release-assets             (exact expected inventory + SHA-256)',
  '  6. macOS: codesign --verify/--display and spctl per .app (structural trust observation)',
  '     Windows: Get-AuthenticodeSignature per packaged .exe (signature metadata observation)',
  '',
  '  --smokes        also run the three Electron smokes (test:manager/click/multi; GUI session)',
  '  --allow-dirty   record a dirty working tree instead of refusing it',
  '  --out <file>    report path override (default .artifacts/native-qualification/<platform>-<sha8>-<stamp>.json)',
  '  --help, -h      print this message',
  '',
  'Exit code: 0 when every automated step passed, 1 when any step failed,',
  '2 on usage/environment errors. The report is local evidence only.',
].join('\n');

export function parseArgs(argv = []) {
  const options = { smokes: false, allowDirty: false, out: null, help: false };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--smokes') {
      options.smokes = true;
    } else if (arg === '--allow-dirty') {
      options.allowDirty = true;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[index + 1] : arg.slice('--out='.length);
      if (typeof value !== 'string' || value === '') errors.push('--out requires a file path');
      else {
        options.out = value;
        if (arg === '--out') index += 1;
      }
    } else {
      errors.push(`unknown argument: ${arg}`);
    }
  }
  return { options, errors };
}

// One platform, one build. Cross-building is deliberately not offered: a
// macOS-built Windows executable is not Windows evidence.
export function platformTarget(platform = process.platform) {
  if (platform === 'darwin') return { platform: 'macos', packScript: 'pack:mac', collectArg: 'macos', native: true };
  if (platform === 'win32') return { platform: 'windows', packScript: 'pack:win', collectArg: 'windows', native: true };
  return { platform: null, packScript: null, collectArg: null, native: false };
}

// Node refuses to spawn .cmd files without a shell (CVE-2024-27980 hardening).
function npmInvocation(platform) {
  return platform === 'win32'
    ? { executable: 'npm.cmd', shell: true }
    : { executable: 'npm', shell: false };
}

export function planSteps({ smokes = false, platform = process.platform, execPath = process.execPath } = {}) {
  const target = platformTarget(platform);
  if (!target.native) return [];
  const npm = npmInvocation(platform);
  const step = (name, args, executable = npm.executable, shell = npm.shell) =>
    ({ name, executable, shell, args });
  const node = (name, args) => step(name, args, execPath, false);
  const steps = [
    step('npm-test', ['test']),
    step('pack', ['run', target.packScript]),
    step('verify-package', ['run', 'verify:package']),
    node('collect-release-assets', ['.github/scripts/collect-release-assets.mjs', target.collectArg]),
  ];
  if (smokes) {
    steps.splice(1, 0,
      step('smoke-manager', ['run', 'test:manager']),
      step('smoke-click', ['run', 'test:click']),
      step('smoke-multi', ['run', 'test:multi']),
    );
  }
  return steps;
}

// codesign -d prints its display output on stderr and leaves stdout empty, so
// callers must feed combined output. See build/after-sign.cjs for the same pit.
export function parseCodesignDisplay(text) {
  const identifier = /(?:^|\n)\s*Identifier=(\S+)/.exec(text)?.[1] ?? null;
  const team = /(?:^|\n)\s*TeamIdentifier=(?!not set)(\S+)/.exec(text)?.[1] ?? null;
  const adhoc = /(?:^|\n)\s*Signature=adhoc/.test(text) || /(?:^|\n)\s*flags=0x\d+\([^)]*adhoc[^)]*\)/.test(text);
  return { identifier, teamIdentifier: team, adhoc };
}

// The expected per-platform release inventory, mirroring
// .github/scripts/collect-release-assets.mjs output names.
export function expectedArtifacts(platform) {
  return platform === 'macos'
    ? ['Poppet-macOS-arm64.dmg', 'Poppet-macOS-arm64.zip', 'Poppet-macOS-x64.dmg', 'Poppet-macOS-x64.zip']
    : ['Poppet-Windows-x64-installer.exe', 'Poppet-Windows-x64-portable.exe'];
}

export function manifestName(platform) {
  return platform === 'macos' ? 'Poppet-macOS-manifest.json' : 'Poppet-Windows-manifest.json';
}

// Every packaged binary must still match the manifest that collect-release-assets
// wrote for this run: same bytes, same SHA-256.
export function collectPackageEvidence(releaseAssetsDir, platform, readFileSync = fs.readFileSync) {
  const manifest = JSON.parse(readFileSync(path.join(releaseAssetsDir, manifestName(platform)), 'utf8'));
  const byName = new Map(manifest.files.map(file => [file.name, file]));
  return expectedArtifacts(platform).map(name => {
    const record = byName.get(name);
    if (!record) return { name, status: 'FAIL', reason: 'missing from manifest' };
    const bytes = readFileSync(path.join(releaseAssetsDir, name));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== record.bytes || sha256 !== record.sha256) {
      return { name, status: 'FAIL', reason: 'package bytes do not match the run manifest' };
    }
    return { name, bytes: bytes.length, sha256, status: 'PASS' };
  });
}

// spctl prints "<path>: rejected (…)" with the app path leading the line, so
// the verdict word must not be anchored to line start. Recorded as trust-state
// evidence, never judged: "rejected" is the normal verdict for an ad-hoc app.
export function parseSpctlVerdict(text) {
  if (/\baccepted\b/.test(text)) return 'accepted';
  if (/\brejected\b/.test(text)) return 'rejected';
  return 'unknown';
}

// Every .app bundle electron-builder emitted below dist/.
export function findAppBundles(distRoot, existSync = fs.existsSync, readdirSync = fs.readdirSync) {
  if (!existSync(distRoot)) return [];
  const apps = [];
  const pending = [distRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.app')) apps.push(target);
      else pending.push(target);
    }
  }
  return apps.sort();
}

export function manualChecklist(platform) {
  const shared = [
    'manager-opens-from-tray',
    'bundled-pet-appears',
    'png-import-and-pixelization',
    'create-succeeds-first-non-empty-frame',
    'click-reaction',
    'drag-and-landing',
    'click-through-behavior',
    'multiple-pets',
    'positions-persist-across-restart',
    'remove-and-re-add-pet',
    'poppetpack-import',
    'poppetpack-export-user-created',
    'builtin-brand-character-export-refused',
    'quit-and-relaunch',
  ];
  if (platform === 'macos') {
    return [...shared, 'tray-menu-bar-icon', 'multi-display-rescue'];
  }
  return [...shared, 'tray-notification-area-icon', 'installer-install', 'uninstall-reinstall'];
}

export const NOT_PROVABLE_HERE = (platform) => Object.freeze([
  platform === 'macos'
    ? 'quarantined first launch (a local build never passes through browser download; Gatekeeper dialog behavior is NOT verified here)'
    : 'SmartScreen first-launch reputation (a local build was never downloaded)',
  'the other operating system: a cross-build is not native evidence; run this tool on real hardware',
  'hosted-CI confirmation for this exact commit',
  'signing identity or notarization: local artifacts stay unsigned/ad-hoc and must not be described as trusted',
  'the manual GUI checklist in docs/native-release-qualification.md',
]);

function gitOutput(root, args, spawnSyncImpl, environment) {
  const result = spawnSyncImpl('git', args, { cwd: root, encoding: 'utf8', env: environment, shell: false });
  return result.status === 0 ? (result.stdout || '').trim() : null;
}

function runStep(stepState, root, environment, spawnSyncImpl, logger) {
  logger.log(`[qualify] ${stepState.name}: ${stepState.display}`);
  const result = spawnSyncImpl(stepState.executable, stepState.args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    shell: stepState.shell,
  });
  const failed = Boolean(result?.error) || Boolean(result?.signal)
    || (Number.isInteger(result?.status) ? result.status !== 0 : true);
  stepState.exitCode = result?.error ? -1 : result?.signal ? -1 : result?.status ?? 1;
  stepState.status = failed ? 'FAIL' : 'PASS';
  if (failed) logger.error(`[qualify] ${stepState.name}: FAIL${result?.error ? ` (${result.error.message})` : ''}`);
  return !failed;
}

function runCodesignChecks({ root, appId, spawnSyncImpl, logger }) {
  const distRoot = path.join(root, 'dist');
  const apps = findAppBundles(distRoot);
  const records = [];
  for (const app of apps) {
    const relative = path.relative(root, app);
    const display = (args) => {
      const result = spawnSyncImpl('codesign', args, { cwd: root, encoding: 'utf8', shell: false });
      return {
        ok: result.status === 0,
        text: `${result.stdout || ''}${result.stderr || ''}`.trim(),
      };
    };
    const verify = display(['--verify', '--deep', '--strict', '--verbose=4', relative]);
    const info = display(['-d', '--verbose=4', relative]);
    const parsed = parseCodesignDisplay(info.text);
    const spctl = spawnSyncImpl('spctl', ['-a', '-vv', relative], { cwd: root, encoding: 'utf8', shell: false });
    const spctlText = `${spctl.stdout || ''}${spctl.stderr || ''}`.trim();
    const verdict = parseSpctlVerdict(spctlText);
    records.push({
      app: relative.split(path.sep).join('/'),
      verifyDeepStrict: verify.ok ? 'PASS' : 'FAIL',
      verifyDetail: verify.ok ? null : verify.text,
      identifier: parsed.identifier,
      identifierMatchesAppId: parsed.identifier === appId,
      teamIdentifier: parsed.teamIdentifier,
      adhoc: parsed.adhoc,
      spctlVerdict: verdict,
      spctlDetail: spctlText,
    });
    logger.log(`[qualify] codesign ${relative}: verify=${records.at(-1).verifyDeepStrict} identifier=${parsed.identifier} team=${parsed.teamIdentifier ?? 'not set'} adhoc=${parsed.adhoc} spctl=${verdict}`);
  }
  return records;
}

function runWindowsSignatureChecks({ root, spawnSyncImpl, logger }) {
  const releaseAssetsDir = path.join(root, 'release-assets');
  const records = [];
  for (const name of expectedArtifacts('windows')) {
    const file = path.join(releaseAssetsDir, name);
    if (!fs.existsSync(file)) {
      records.push({ file: `release-assets/${name}`, status: 'FAIL', reason: 'packaged executable not found' });
      continue;
    }
    const command = `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}').Status`;
    const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: root, encoding: 'utf8', shell: false });
    const status = `${result.stdout || ''}`.trim() || `powershell exit ${result.status}`;
    records.push({
      file: `release-assets/${name}`,
      status: 'RECORDED',
      authenticode: status,
      note: /NotSigned/i.test(status)
        ? 'unsigned developer alpha: expected for the controlled alpha, not a trusted Windows release'
        : 'unexpected for the unsigned alpha; inspect before treating this build as ours',
    });
    logger.log(`[qualify] Authenticode release-assets/${name}: ${status}`);
  }
  return records;
}

export function buildReport({ commit, workingTree, pkg, target, osInfo, nodeVersion, steps, packageEvidence, signature, smokes, timestamp }) {
  const manualChecks = Object.fromEntries(manualChecklist(target.platform).map(key => [key, 'MANUAL_REQUIRED']));
  const failed = steps.some(step => step.status === 'FAIL')
    || packageEvidence.some(item => item.status === 'FAIL')
    || signature.some(item => item.verifyDeepStrict === 'FAIL' || item.status === 'FAIL');
  return {
    schemaVersion: 1,
    generatedBy: 'tools/qualify-native.mjs',
    automatedOnly: true,
    commit,
    workingTree,
    version: pkg.version,
    platform: target.platform,
    osVersion: `${osInfo.type} ${osInfo.release}`,
    arch: osInfo.arch,
    node: nodeVersion,
    electron: pkg.devDependencies?.electron ?? null,
    electronBuilder: pkg.devDependencies?.['electron-builder'] ?? null,
    appId: pkg.build?.appId ?? null,
    timestamp,
    commands: steps.map(({ name, display, status, exitCode }) => ({ name, command: display, status, exitCode })),
    packageArtifacts: packageEvidence,
    packagePurity: {
      verifyPackage: steps.find(step => step.name === 'verify-package')?.status ?? 'NOT_RUN',
      note: 'tools/verify-package.mjs inspected every built app.asar against current production source',
    },
    signature,
    smokes: smokes ?? { status: 'NOT_RUN', note: 'Electron smokes need a GUI session; run npm run test:manager|test:click|test:multi (or --smokes)' },
    manualChecks,
    blockedChecks: NOT_PROVABLE_HERE(target.platform),
    result: failed ? 'FAIL' : 'PASS',
  };
}

export function runNativeQualification({
  argv = [],
  spawnSyncImpl = spawnSync,
  cwd = defaultProjectRoot,
  platform = process.platform,
  logger = console,
  environment = process.env,
  execPath = process.execPath,
  now = () => new Date().toISOString(),
  osInfo = { type: os.type(), release: os.release(), arch: os.arch() },
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  const { options, errors } = parseArgs(argv);
  if (options.help) {
    logger.log(USAGE);
    return { exitCode: 0, report: null };
  }
  if (errors.length) {
    for (const error of errors) logger.error(`qualify: ${error}`);
    logger.error(USAGE);
    return { exitCode: 2, report: null };
  }

  const target = platformTarget(platform);
  if (!target.native) {
    logger.error('qualify: no native package target on this OS; a cross-build is not native evidence.');
    logger.error('Run this command on real macOS or Windows hardware (docs/native-release-qualification.md).');
    return { exitCode: 2, report: null };
  }

  const root = path.resolve(cwd);
  const commit = gitOutput(root, ['rev-parse', 'HEAD'], spawnSyncImpl, environment);
  if (!commit) {
    logger.error('qualify: could not resolve the git commit; run inside the repository checkout.');
    return { exitCode: 2, report: null };
  }
  const dirtyLines = gitOutput(root, ['status', '--porcelain'], spawnSyncImpl, environment);
  if (dirtyLines && !options.allowDirty) {
    logger.error('qualify: the working tree is dirty; evidence must name the commit it tested.');
    logger.error('Commit (or stash) first, or pass --allow-dirty to record the dirty state honestly.');
    return { exitCode: 2, report: null };
  }

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const npm = npmInvocation(platform);
  const steps = planSteps({ smokes: options.smokes, platform, execPath }).map(plan => ({
    ...plan,
    display: [plan.executable === execPath ? 'node' : plan.executable, ...plan.args].join(' '),
    status: 'NOT_RUN',
    exitCode: null,
  }));

  let failed = false;
  for (const step of steps) {
    if (!runStep(step, root, environment, spawnSyncImpl, logger)) {
      failed = true;
      logger.error(`[qualify] stopping before later steps: a failed ${step.name} invalidates the rest of the chain`);
      break;
    }
  }

  // Signature/trust observations only mean something for the package this run
  // built; after a failed step they would inspect stale dist/ output.
  const signature = failed
    ? [{ status: 'NOT_RUN', reason: 'skipped: the build/test chain failed' }]
    : target.platform === 'macos'
      ? runCodesignChecks({ root, appId: pkg.build?.appId, spawnSyncImpl, logger })
      : runWindowsSignatureChecks({ root, spawnSyncImpl, logger });

  let packageEvidence = [];
  if (!failed) {
    try {
      packageEvidence = collectPackageEvidence(path.join(root, 'release-assets'), target.platform, readFileSync);
    } catch (error) {
      packageEvidence = expectedArtifacts(target.platform).map(name => ({ name, status: 'FAIL', reason: `manifest/evidence error: ${error.message}` }));
    }
  } else {
    packageEvidence = expectedArtifacts(target.platform).map(name => ({ name, status: 'NOT_RUN' }));
  }

  const smokesStatus = options.smokes
    ? { status: steps.filter(step => step.name.startsWith('smoke-')).every(step => step.status === 'PASS') ? 'PASS' : 'FAIL', note: 'Electron smokes ran in this session' }
    : { status: 'NOT_RUN', note: 'Electron smokes need a GUI session; run npm run test:manager|test:click|test:multi (or --smokes)' };

  const report = buildReport({
    commit,
    workingTree: dirtyLines ? 'dirty (--allow-dirty recorded)' : 'clean',
    pkg,
    target,
    osInfo,
    nodeVersion: process.version,
    steps,
    packageEvidence,
    signature,
    smokes: smokesStatus,
    timestamp: now(),
  });

  const defaultOut = path.join(
    root, '.artifacts', 'native-qualification',
    `${target.platform}-${commit.slice(0, 8)}-${now().replace(/[:.]/g, '-')}.json`,
  );
  const outPath = path.resolve(root, options.out ?? defaultOut);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  logger.log('');
  logger.log(`==== native qualification (${target.platform}) ====`);
  for (const step of steps) logger.log(`${step.status.padEnd(7)}  ${step.name}`);
  for (const item of packageEvidence) logger.log(`${item.status.padEnd(7)}  ${item.name}`);
  logger.log(`Result: ${report.result}`);
  logger.log(`Report: ${path.relative(root, outPath).split(path.sep).join('/')}`);
  logger.log('');
  logger.log('Local evidence only. Not proven here:');
  for (const item of report.blockedChecks) logger.log(`- ${item}`);

  // The report verdict is the single source of truth: package-evidence or
  // signature FAILs must fail the command even when every build step passed.
  return { exitCode: report.result === 'FAIL' ? 1 : 0, report, outPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  let exitCode = 1;
  try {
    ({ exitCode } = runNativeQualification({ argv: process.argv.slice(2) }));
  } catch (error) {
    console.error(`qualify failed: ${error?.stack || error}`);
  }
  process.exit(exitCode);
}

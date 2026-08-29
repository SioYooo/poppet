// Tests for tools/qualify-native.mjs: argument handling, platform gating
// (Linux must be refused, never cross-built), the step plan, codesign display
// parsing (combined-stream regression: codesign -d prints to stderr), manifest
// re-verification of the packaged inventory, and the report schema/result
// semantics. The orchestration is exercised with an injected spawn so no test
// builds or signs anything.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import {
  NOT_PROVABLE_HERE,
  USAGE,
  buildReport,
  collectPackageEvidence,
  expectedArtifacts,
  findAppBundles,
  manualChecklist,
  manifestName,
  parseArgs,
  parseCodesignDisplay,
  parseSpctlVerdict,
  planSteps,
  platformTarget,
  runNativeQualification,
} from '../../tools/qualify-native.mjs';

const HEAD = 'a'.repeat(40);
const PKG = JSON.stringify({
  version: '0.1.0-alpha.1',
  devDependencies: { electron: '43.4.1', 'electron-builder': '26.15.7' },
  build: { appId: 'com.sioyoo.poppet' },
});

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

// Keyed by "executable firstArg". An object outcome is returned as the result
// itself; a number becomes the status; a function is invoked for the result.
function fakeSpawn(outcomes = {}) {
  const calls = [];
  const impl = (executable, args, options) => {
    calls.push({ executable, args, options });
    const outcome = outcomes[[executable, args[0]].join(' ')] ?? outcomes[executable];
    if (typeof outcome === 'function') return outcome(args, options);
    if (outcome && typeof outcome === 'object') return { signal: null, error: undefined, ...outcome };
    return { status: outcome ?? 0, stdout: '', stderr: '', signal: null, error: undefined };
  };
  return { calls, impl };
}

// A consistent release-assets fixture: real buffers plus a manifest carrying
// their real sizes and SHA-256 digests, exactly as collect-release-assets
// writes them for the run.
function releaseAssetsFixture(platform = 'macos') {
  const buffers = new Map(expectedArtifacts(platform).map((name, index) => [name, Buffer.alloc(10 + index, index)]));
  const manifest = {
    files: [...buffers].map(([name, bytes]) => ({
      name,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  const files = { [manifestName(platform)]: JSON.stringify(manifest) };
  const readFileSync = (file) => {
    const key = path.basename(String(file));
    if (key === 'package.json') return PKG;
    if (key in files) return files[key];
    if (buffers.has(key)) return buffers.get(key);
    throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
  };
  return { files, readFileSync };
}

function baseRun(argv, {
  outcomes,
  platform = 'darwin',
  fixture = releaseAssetsFixture(),
  dirty = false,
  environment = { PATH: '/usr/bin' },
} = {}) {
  const { calls, impl } = fakeSpawn({
    'git rev-parse': { status: 0, stdout: `${HEAD}\n`, stderr: '' },
    'git status': { status: 0, stdout: dirty ? ' M src/x.js\n' : '', stderr: '' },
    ...outcomes,
  });
  const { lines, logger } = recordingLogger();
  const written = [];
  const result = runNativeQualification({
    argv,
    spawnSyncImpl: impl,
    cwd: '/repo/checkout',
    platform,
    logger,
    environment,
    execPath: '/fake/node',
    now: () => '2026-08-28T00:00:00.000Z',
    osInfo: { type: 'Darwin', release: '27.0.0', arch: 'arm64' },
    readFileSync: fixture.readFileSync,
    existsSync: () => false,
    mkdirSync: () => {},
    writeFileSync: (file, contents) => written.push({ file: String(file), contents }),
  });
  const report = written[0] ? JSON.parse(written[0].contents) : null;
  return { ...result, calls, lines, written, report };
}

test('parseArgs accepts the documented flags and rejects unknown ones', () => {
  assert.deepEqual(parseArgs(['--smokes', '--allow-dirty', '--out', 'x.json']),
    { options: { smokes: true, allowDirty: true, out: 'x.json', help: false }, errors: [] });
  assert.equal(parseArgs(['--out=y.json']).options.out, 'y.json');
  const { options, errors } = parseArgs(['--bogus']);
  assert.equal(options.help, false);
  assert.match(errors.join(' '), /unknown argument: --bogus/);
});

test('linux has no native target and the run refuses it instead of cross-building', () => {
  assert.equal(platformTarget('linux').native, false);
  assert.deepEqual(planSteps({ platform: 'linux' }), []);
  const { exitCode, report, lines } = baseRun([], { platform: 'linux' });
  assert.equal(exitCode, 2);
  assert.equal(report, null);
  assert.match(lines.join('\n'), /no native package target.*cross-build is not native evidence/s);
});

test('the plan runs tests, native pack, purity, and the inventory collector in order', () => {
  const steps = planSteps({ platform: 'darwin', execPath: '/fake/node' });
  assert.deepEqual(steps.map(step => `${step.executable} ${step.args.join(' ')}`), [
    'npm test',
    'npm run pack:mac',
    'npm run verify:package',
    '/fake/node .github/scripts/collect-release-assets.mjs macos',
  ]);
  assert.deepEqual(planSteps({ platform: 'win32' }).map(step => step.args.at(-1)), [
    'test', 'pack:win', 'verify:package', 'windows',
  ]);
});

test('--smokes inserts the three GUI smokes after the unit suite and before packaging', () => {
  assert.deepEqual(planSteps({ smokes: true, platform: 'darwin' }).map(step => step.name), [
    'npm-test', 'smoke-manager', 'smoke-click', 'smoke-multi', 'pack', 'verify-package', 'collect-release-assets',
  ]);
});

test('a dirty working tree is refused before any step runs unless --allow-dirty records it', () => {
  const refused = baseRun([], { dirty: true });
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.report, null);
  assert.ok(!refused.calls.some(({ executable }) => executable === 'npm'));

  const allowed = baseRun(['--allow-dirty'], { dirty: true });
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.report.workingTree, 'dirty (--allow-dirty recorded)');
});

test('spctl verdicts are parsed wherever they appear on the line, and unknown stays unknown', () => {
  assert.equal(parseSpctlVerdict('dist/mac-arm64/Poppet.app: rejected'), 'rejected');
  assert.equal(parseSpctlVerdict('/x.app: rejected\nsource=no usable signature'), 'rejected');
  assert.equal(parseSpctlVerdict('/x.app: accepted\nsource=Notarized Developer ID'), 'accepted');
  assert.equal(parseSpctlVerdict(''), 'unknown');
});

test('codesign display parsing reads combined output: identifier, ad-hoc, and a real team', () => {
  const adhoc = parseCodesignDisplay([
    'Executable=/repo/dist/mac-arm64/Poppet.app/Contents/MacOS/Poppet',
    'Identifier=com.sioyoo.poppet',
    'TeamIdentifier=not set',
    'Signature=adhoc',
    'Authority=(unavailable)',
  ].join('\n'));
  assert.deepEqual(adhoc, { identifier: 'com.sioyoo.poppet', teamIdentifier: null, adhoc: true });

  const real = parseCodesignDisplay('Identifier=com.sioyoo.poppet\nTeamIdentifier=QQ2XB4A1C2\nSignature size=4202');
  assert.equal(real.teamIdentifier, 'QQ2XB4A1C2');
  assert.equal(real.adhoc, false);
  assert.equal(parseCodesignDisplay('').identifier, null);
});

test('package evidence re-verifies every packaged binary against the run manifest', () => {
  const { files, readFileSync } = releaseAssetsFixture('macos');
  const evidence = collectPackageEvidence('/repo/release-assets', 'macos', readFileSync);
  assert.deepEqual(evidence.map(item => item.status), ['PASS', 'PASS', 'PASS', 'PASS']);
  const manifest = JSON.parse(files[manifestName('macos')]);
  assert.deepEqual(evidence.map(item => item.sha256), manifest.files.map(file => file.sha256));

  const tampered = collectPackageEvidence('/repo/release-assets', 'macos', (file) => {
    const key = path.basename(String(file));
    if (key === expectedArtifacts('macos')[1]) return Buffer.alloc(1);
    return readFileSync(file);
  });
  assert.equal(tampered[1].status, 'FAIL');
  assert.match(tampered[1].reason, /do not match the run manifest/);
});

test('findAppBundles collects every .app below dist, recursing and ignoring plain files', () => {
  const tree = { dist: { mac: { 'Poppet.app': {} }, 'Poppet.app': {}, 'notes.txt': null } };
  const readdirSync = (dir) => {
    const segments = String(dir).split(path.sep).filter(Boolean);
    let node = tree;
    for (const segment of segments.slice(1)) node = node[segment];
    return Object.entries(node).map(([name, child]) => ({
      name,
      isDirectory: () => child !== null,
    }));
  };
  const apps = findAppBundles('/repo/dist', () => true, readdirSync);
  assert.deepEqual(apps.sort(), ['/repo/dist/Poppet.app', '/repo/dist/mac/Poppet.app']);
});

test('a clean darwin run passes and writes a schemaVersion 1 report with honest boundaries', () => {
  const { exitCode, report, lines } = baseRun([]);
  assert.equal(exitCode, 0);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.result, 'PASS');
  assert.equal(report.automatedOnly, true);
  assert.equal(report.commit, HEAD);
  assert.equal(report.workingTree, 'clean');
  assert.equal(report.version, '0.1.0-alpha.1');
  assert.equal(report.platform, 'macos');
  assert.equal(report.appId, 'com.sioyoo.poppet');
  assert.equal(report.electron, '43.4.1');
  assert.equal(report.electronBuilder, '26.15.7');
  assert.deepEqual(report.commands.map(cmd => cmd.status), ['PASS', 'PASS', 'PASS', 'PASS']);
  assert.deepEqual(report.packageArtifacts.map(item => item.status), ['PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(report.smokes.status, 'NOT_RUN');
  for (const value of Object.values(report.manualChecks)) assert.equal(value, 'MANUAL_REQUIRED');
  assert.ok(report.manualChecks['poppetpack-import']);
  assert.deepEqual(report.blockedChecks, [...NOT_PROVABLE_HERE('macos')]);
  assert.match(report.blockedChecks.join(' '), /quarantined first launch/);
  assert.match(lines.join('\n'), /Local evidence only/);
});

test('a failing test step stops the chain, marks later evidence NOT_RUN, and fails the report', () => {
  const { exitCode, report, calls } = baseRun([], {
    outcomes: {
      npm: (args) => (args[0] === 'test' ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' }),
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(report.result, 'FAIL');
  assert.equal(report.commands.find(cmd => cmd.name === 'npm-test').status, 'FAIL');
  assert.deepEqual(report.packageArtifacts.map(item => item.status), ['NOT_RUN', 'NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  assert.deepEqual(report.signature, [{ status: 'NOT_RUN', reason: 'skipped: the build/test chain failed' }]);
  assert.ok(!calls.some(({ args }) => args?.[0] === '.github/scripts/collect-release-assets.mjs'),
    'the inventory collector must not run after a failed build step');
});

test('usage errors and --help behave like the other local gates', () => {
  const bad = baseRun(['--nope']);
  assert.equal(bad.exitCode, 2);
  assert.equal(bad.report, null);
  assert.match(bad.lines.join('\n'), /Usage: node tools\/qualify-native\.mjs/);

  const help = baseRun(['--help']);
  assert.equal(help.exitCode, 0);
  assert.equal(help.report, null);
  assert.equal(help.lines.join('\n').trim(), USAGE.trim());
});

test('the manual checklist distinguishes the platform-specific surfaces', () => {
  const mac = manualChecklist('macos');
  const win = manualChecklist('windows');
  assert.ok(mac.includes('multi-display-rescue') && !win.includes('multi-display-rescue'));
  assert.ok(win.includes('uninstall-reinstall') && !mac.includes('uninstall-reinstall'));
  for (const key of ['poppetpack-import', 'builtin-brand-character-export-refused', 'positions-persist-across-restart']) {
    assert.ok(mac.includes(key) && win.includes(key), key);
  }
});

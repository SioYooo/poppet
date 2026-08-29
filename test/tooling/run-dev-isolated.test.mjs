import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runDevIsolated } from '../../tools/run-dev-isolated.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temporaryRoot = path.resolve(os.tmpdir());

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

// The runner must never touch the real process signal table from a unit test.
function fakeProcess(events = []) {
  return {
    events,
    processImpl: {
      on: (signal, handler) => { events.push(['on', signal, handler]); },
      off: (signal, handler) => { events.push(['off', signal, handler]); },
    },
  };
}

function scratchDirectory(t) {
  const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'poppet-dev-isolated-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  return scratch;
}

test('starts Electron interactively on a fresh tmpdir profile and passes the exit code through', () => {
  const events = [];
  const { lines, logger } = recordingLogger();
  const { processImpl } = fakeProcess(events);
  let profile;
  let calls = 0;

  const exitCode = runDevIsolated(['--demo'], {
    electronPath: '/fake/electron',
    logger,
    processImpl,
    environment: { PATH: '/usr/bin', POPPET_TEST_USER_DATA: '/must/be/overridden' },
    spawnSyncImpl(command, args, options) {
      calls += 1;
      events.push(['spawn']);
      profile = options.env.POPPET_TEST_USER_DATA;
      const stat = fs.lstatSync(profile);
      assert.equal(stat.isDirectory(), true, 'profile exists while Electron runs');
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(command, '/fake/electron');
      assert.deepEqual(args, [projectRoot, '--dev', '--isolated', '--demo']);
      assert.equal(options.cwd, projectRoot);
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.timeout, undefined, 'interactive sessions have no deadline');
      assert.equal(options.killSignal, undefined);
      assert.deepEqual(Object.keys(options.env).sort(), ['PATH', 'POPPET_TEST_USER_DATA'],
        'only the isolated profile variable is added to the inherited environment');
      assert.equal(options.env.PATH, '/usr/bin');
      return { status: 7, signal: null, error: undefined };
    },
  });

  assert.equal(exitCode, 7);
  assert.equal(calls, 1);
  assert.equal(path.dirname(profile), temporaryRoot, 'profile is a direct tmpdir child');
  assert.match(path.basename(profile), /^poppet-electron-smoke-/, 'profile reuses the prefix index.js validates');
  assert.equal(fs.existsSync(profile), false, 'profile is removed after the app exits');
  assert.ok(lines.some(line => line === `[dev-isolated] userData=${profile}`));
  assert.ok(lines.some(line => line === `[dev-isolated] removed ${profile}`));

  // Signal listeners are installed before Electron starts and removed after it exits.
  const handler = events[0][2];
  assert.equal(typeof handler, 'function');
  assert.deepEqual(events.map(event => event.slice(0, 2)), [
    ['on', 'SIGINT'], ['on', 'SIGTERM'], ['spawn'], ['off', 'SIGINT'], ['off', 'SIGTERM'],
  ]);
  for (const event of events) if (event[0] !== 'spawn') assert.equal(event[2], handler);
});

test('a clean quit returns zero and a leading -- separator is dropped', () => {
  const { logger } = recordingLogger();
  let args;
  const exitCode = runDevIsolated(['--', '--character', 'default'], {
    electronPath: '/fake/electron',
    logger,
    processImpl: fakeProcess().processImpl,
    spawnSyncImpl(_command, spawnArgs) {
      args = spawnArgs;
      return { status: 0, signal: null, error: undefined };
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(args, [projectRoot, '--dev', '--isolated', '--character', 'default']);
});

test('smoke flags are refused before any profile is created', (t) => {
  const scratch = scratchDirectory(t);
  for (const flag of ['--test-click', '--test-manager', '--test-manager-restart', '--test-multi']) {
    const { lines, logger } = recordingLogger();
    let spawned = false;
    const exitCode = runDevIsolated([flag], {
      electronPath: '/fake/electron',
      logger,
      temporaryRoot: scratch,
      processImpl: fakeProcess().processImpl,
      spawnSyncImpl() { spawned = true; return { status: 0 }; },
    });
    assert.equal(exitCode, 2);
    assert.equal(spawned, false);
    assert.match(lines.join('\n'), /Usage:/);
    assert.match(lines.join('\n'), new RegExp(`${flag} is a smoke mode`));
  }
  assert.deepEqual(fs.readdirSync(scratch), [], 'no temporary profile is created for a refused run');
});

test('a synchronous spawn failure returns non-zero and still removes the profile', () => {
  const { lines, logger } = recordingLogger();
  let profile;
  const exitCode = runDevIsolated([], {
    electronPath: '/fake/electron',
    logger,
    processImpl: fakeProcess().processImpl,
    spawnSyncImpl(_command, _args, options) {
      profile = options.env.POPPET_TEST_USER_DATA;
      throw new Error('fake spawn failure');
    },
  });
  assert.equal(exitCode, 1);
  assert.match(lines.join('\n'), /could not start: fake spawn failure/);
  assert.equal(fs.existsSync(profile), false);
});

test('a spawn error result and a signal-terminated app both return non-zero and clean up', () => {
  for (const [result, expected] of [
    [{ status: null, signal: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, /could not start: spawn ENOENT/],
    [{ status: null, signal: 'SIGTERM', error: undefined }, /terminated by SIGTERM/],
  ]) {
    const { lines, logger } = recordingLogger();
    let profile;
    const exitCode = runDevIsolated([], {
      electronPath: '/fake/electron',
      logger,
      processImpl: fakeProcess().processImpl,
      spawnSyncImpl(_command, _args, options) {
        profile = options.env.POPPET_TEST_USER_DATA;
        return result;
      },
    });
    assert.equal(exitCode, 1);
    assert.match(lines.join('\n'), expected);
    assert.equal(fs.existsSync(profile), false);
  }
});

test('refuses to clean a profile that was swapped for a symbolic link while the app ran', (t) => {
  const scratch = scratchDirectory(t);
  const victim = path.join(scratch, 'outside', 'victim');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'must survive');
  const { logger } = recordingLogger();
  let profile;
  t.after(() => { try { fs.unlinkSync(profile); } catch { /* already gone */ } });

  assert.throws(() => runDevIsolated([], {
    electronPath: '/fake/electron',
    logger,
    processImpl: fakeProcess().processImpl,
    spawnSyncImpl(_command, _args, options) {
      profile = options.env.POPPET_TEST_USER_DATA;
      fs.rmdirSync(profile);
      fs.symlinkSync(victim, profile);
      return { status: 0, signal: null, error: undefined };
    },
  }), /Refusing to clean unexpected isolated profile/);

  assert.equal(fs.lstatSync(profile).isSymbolicLink(), true, 'the link is left untouched');
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'must survive');
});

test('refuses to clean a profile that was replaced by a regular file', (t) => {
  const { logger } = recordingLogger();
  let profile;
  t.after(() => { try { fs.unlinkSync(profile); } catch { /* already gone */ } });

  assert.throws(() => runDevIsolated([], {
    electronPath: '/fake/electron',
    logger,
    processImpl: fakeProcess().processImpl,
    spawnSyncImpl(_command, _args, options) {
      profile = options.env.POPPET_TEST_USER_DATA;
      fs.rmdirSync(profile);
      fs.writeFileSync(profile, 'not a directory');
      return { status: 0, signal: null, error: undefined };
    },
  }), /Refusing to clean unexpected isolated profile/);

  assert.equal(fs.readFileSync(profile, 'utf8'), 'not a directory');
});

test('a profile moved out of tmpdir during the run is neither followed nor deleted', (t) => {
  const scratch = scratchDirectory(t);
  const moved = path.join(scratch, 'outside', 'moved-profile');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  const { logger } = recordingLogger();

  assert.throws(() => runDevIsolated([], {
    electronPath: '/fake/electron',
    logger,
    processImpl: fakeProcess().processImpl,
    spawnSyncImpl(_command, _args, options) {
      const profile = options.env.POPPET_TEST_USER_DATA;
      fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
      fs.renameSync(profile, moved);
      return { status: 0, signal: null, error: undefined };
    },
  }), error => error?.code === 'ENOENT');

  assert.equal(fs.readFileSync(path.join(moved, 'settings.json'), 'utf8'), '{}',
    'the relocated directory is intact');
});

test('the CLI entry refuses smoke flags with a usage error without starting Electron', () => {
  const runner = path.join(projectRoot, 'tools/run-dev-isolated.mjs');
  const result = spawnSync(process.execPath, [runner, '--test-click'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

// The --isolated branch in the Electron main process cannot execute inside node:test;
// this is a source-text guard (regex assertions over source, not executed UI) for the
// invariants a real `npm run dev:isolated` session relies on.
test('src/main/index.js routes --isolated through the smoke profile validation but the interactive path', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/index.js'), 'utf8');

  assert.match(source, /const DEV_SMOKE = DEV && \[\n\s*'--test-click', '--test-manager', '--test-manager-restart', '--test-multi',\n\]\.find\(flag => process\.argv\.includes\(flag\)\);/,
    'DEV_SMOKE definition is unchanged');
  assert.match(source, /const DEV_ISOLATED = DEV && !DEV_SMOKE && process\.argv\.includes\('--isolated'\);/,
    'smoke flags keep precedence over --isolated');

  const smoke = source.match(/if \(DEV_SMOKE\) \{([\s\S]*?)\} else if \(DEV_ISOLATED\) \{/);
  assert.ok(smoke, 'smoke branch is followed by the isolated branch');
  assert.match(smoke[1], /configureSmokeUserData\(\);[\s\S]*app\.disableHardwareAcceleration\(\);[\s\S]*appendSwitch\('in-process-gpu'\)/,
    'smoke still forces the software rendering path');

  const isolated = source.match(/\} else if \(DEV_ISOLATED\) \{([\s\S]*?)\} else \{/);
  assert.ok(isolated, 'isolated branch sits before the legacy-profile guard');
  // Only code lines count: the branch comment explains why the guard is skipped.
  const isolatedCode = isolated[1].split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.equal(isolatedCode.trim(), 'configureSmokeUserData();',
    'the isolated branch only validates and adopts the temporary profile');
  assert.doesNotMatch(isolatedCode, /disableHardwareAcceleration|in-process-gpu|configureUserDataCompatibility|runDevSmoke|userDataReady/);

  const guard = source.match(/\} else \{\n\s*const profile = configureUserDataCompatibility\(\{ app \}\);\n\s*userDataReady = profile\.status !== 'LEGACY_PROFILE_BUSY';/);
  assert.ok(guard, 'non-isolated startup still runs the fail-closed legacy-profile guard');

  // The validation chain itself is shared and unchanged.
  assert.match(source, /function configureSmokeUserData\(\) \{[\s\S]*?path\.dirname\(resolved\) === temporaryRoot[\s\S]*?startsWith\('poppet-electron-smoke-'\)[\s\S]*?stat\?\.isDirectory\(\)[\s\S]*?!stat\.isSymbolicLink\(\)[\s\S]*?app\.setPath\('userData', resolved\);/);
  // No interactive-path decision is gated on DEV_ISOLATED: onboarding, watchdogs,
  // failMainStartup and the single-instance lock behave exactly as in npm run dev.
  assert.equal(source.match(/DEV_ISOLATED/g).length, 2);
});

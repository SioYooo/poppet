import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  SMOKE_PHASE_TIMEOUT_MS,
  runElectronSmoke,
} from '../../tools/run-electron-smoke.mjs';

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

test('every manager smoke phase is bounded and a simulated hang fails closed immediately', () => {
  const calls = [];
  const { lines, logger } = recordingLogger();
  let profile;
  const started = Date.now();

  const exitCode = runElectronSmoke('--test-manager', {
    electronPath: '/fake/electron',
    logger,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      profile = options.env.POPPET_TEST_USER_DATA;
      assert.equal(fs.lstatSync(profile).isDirectory(), true);
      if (calls.length === 1) return { status: 0, signal: null, error: undefined };
      const error = new Error('fake child exceeded its deadline');
      error.code = 'ETIMEDOUT';
      // An error must dominate even a contradictory zero status from a fake or
      // platform-specific child-process implementation.
      return { status: 0, signal: 'SIGTERM', error };
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls.map(({ args }) => args.at(-1)), [
    '--test-manager',
    '--test-manager-restart',
  ]);
  for (const { options } of calls) {
    assert.equal(options.timeout, SMOKE_PHASE_TIMEOUT_MS);
    assert.equal(options.killSignal, 'SIGTERM');
  }
  assert.ok(Date.now() - started < 5_000, 'fake timeout regression must not wait for the real deadline');
  assert.match(lines.join('\n'), /timed out after 90000ms/);
  assert.equal(fs.existsSync(profile), false, 'isolated smoke profile must be removed after timeout');
});

test('a synchronous child-process failure returns non-zero and still cleans the profile', () => {
  const { lines, logger } = recordingLogger();
  let profile;
  const exitCode = runElectronSmoke('--test-click', {
    electronPath: '/fake/electron',
    logger,
    spawnSyncImpl(_command, _args, options) {
      profile = options.env.POPPET_TEST_USER_DATA;
      throw new Error('fake spawn failure');
    },
  });

  assert.equal(exitCode, 1);
  assert.match(lines.join('\n'), /could not start: fake spawn failure/);
  assert.equal(fs.existsSync(profile), false, 'isolated smoke profile must be removed after spawn failure');
});

test('the Electron ready chain has a terminal diagnostic and non-zero app exit', () => {
  const source = fs.readFileSync(new URL('../../src/main/index.js', import.meta.url), 'utf8');
  assert.match(source, /function failMainStartup\(error\) \{[\s\S]*?console\.error\([\s\S]*?app\.exit\(1\);[\s\S]*?\}/);
  assert.match(source, /app\.whenReady\(\)\.then\([\s\S]*?\}\)\.catch\(failMainStartup\);/);
});

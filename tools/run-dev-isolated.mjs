// Interactive development on an isolated, throwaway user profile.
//
// `npm start` / `npm run dev` keep failing closed on a machine where both the
// Poppet profile and a legacy profile exist without a trusted migration marker
// (src/main/user-data-compat.js). This runner lets a developer iterate anyway:
// it creates a fresh temporary userData directory, hands it to Electron through
// the same POPPET_TEST_USER_DATA validation chain the smoke tests use, starts
// the app on the ordinary interactive path (`--dev --isolated`, no software
// rendering, no smoke handlers, no timeout) and removes the directory once the
// app has quit. The real user profile is never read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL('..', import.meta.url));
// These flags switch src/main/index.js into DEV_SMOKE (software 2D rendering,
// smoke handlers, unattended exit). A smoke without the smoke runner's deadline
// is a footgun, so they are not accepted as pass-through arguments.
const smokeFlags = new Set([
  '--test-click', '--test-manager', '--test-manager-restart', '--test-multi',
]);
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'];

export function runDevIsolated(extraArgs = [], {
  spawnSyncImpl = spawnSync,
  electronPath = null,
  projectRoot = defaultProjectRoot,
  temporaryRoot = os.tmpdir(),
  environment = process.env,
  logger = console,
  processImpl = process,
} = {}) {
  const passthrough = (Array.isArray(extraArgs) ? extraArgs : []).map(String);
  if (passthrough[0] === '--') passthrough.shift();
  const rejected = passthrough.find(arg => smokeFlags.has(arg));
  if (rejected) {
    logger.error(
      `Usage: node tools/run-dev-isolated.mjs [extra Electron arguments]; ${rejected} is a smoke mode, `
      + 'run it through npm run test:click|test:manager|test:multi instead',
    );
    return 2;
  }

  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  // Same prefix as tools/run-electron-smoke.mjs on purpose: src/main/index.js
  // only accepts a direct tmpdir child named poppet-electron-smoke-* that is a
  // real directory (not a symlink) as an isolated userData path.
  const profile = fs.mkdtempSync(path.join(resolvedTemporaryRoot, 'poppet-electron-smoke-'));
  // spawnSync blocks this thread, so no JavaScript runs until Electron exits.
  // Node's default SIGINT/SIGTERM disposition would kill the runner at once and
  // skip the cleanup below. A registered listener keeps the runner alive: a
  // terminal Ctrl+C reaches Electron as well (same process group), the app
  // quits, spawnSync returns and the profile is removed. A signal sent to the
  // runner alone only defers the cleanup until the app is quit by the user.
  const keepAlive = () => {};
  let exitCode = 1;

  try {
    for (const signal of INTERRUPT_SIGNALS) processImpl.on(signal, keepAlive);
    const executable = electronPath || require('electron');
    logger.log(`[dev-isolated] userData=${profile}`);
    let result;
    try {
      result = spawnSyncImpl(executable, [resolvedProjectRoot, '--dev', '--isolated', ...passthrough], {
        cwd: resolvedProjectRoot,
        env: { ...environment, POPPET_TEST_USER_DATA: profile },
        stdio: 'inherit',
        // Interactive session: no timeout and no kill signal. It ends when the
        // user quits the app.
      });
    } catch (error) {
      logger.error(`Isolated dev session could not start: ${error?.message || error}`);
      return 1;
    }

    if (result?.error) {
      logger.error(`Isolated dev session could not start: ${result.error.message}`);
      return 1;
    }
    if (result?.signal) {
      logger.error(`Isolated dev session terminated by ${result.signal}`);
      return 1;
    }
    exitCode = Number.isInteger(result?.status) ? result.status : 1;
  } finally {
    for (const signal of INTERRUPT_SIGNALS) processImpl.off(signal, keepAlive);
    // Identical fail-closed cleanup to tools/run-electron-smoke.mjs: only ever
    // remove a real poppet-electron-smoke-* directory that still sits directly
    // under the temporary root. Anything else aborts instead of deleting.
    const resolved = path.resolve(profile);
    const stat = fs.lstatSync(resolved);
    const safe = path.dirname(resolved) === resolvedTemporaryRoot
      && path.basename(resolved).startsWith('poppet-electron-smoke-')
      && stat.isDirectory()
      && !stat.isSymbolicLink();
    if (!safe) throw new Error(`Refusing to clean unexpected isolated profile: ${resolved}`);
    fs.rmSync(resolved, { recursive: true });
    logger.log(`[dev-isolated] removed ${resolved}`);
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  let exitCode = 1;
  try {
    exitCode = runDevIsolated(process.argv.slice(2));
  } catch (error) {
    console.error(`Isolated dev runner failed: ${error?.stack || error}`);
  }
  process.exit(exitCode);
}

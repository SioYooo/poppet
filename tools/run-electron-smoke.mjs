import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = fileURLToPath(new URL('..', import.meta.url));
const validModes = new Set(['--test-click', '--test-manager', '--test-multi']);

export const SMOKE_PHASE_TIMEOUT_MS = 90_000;

export function runElectronSmoke(mode, {
  spawnSyncImpl = spawnSync,
  electronPath = null,
  projectRoot = defaultProjectRoot,
  temporaryRoot = os.tmpdir(),
  environment = process.env,
  logger = console,
} = {}) {
  if (!validModes.has(mode)) {
    logger.error('Usage: node tools/run-electron-smoke.mjs --test-click|--test-manager|--test-multi');
    return 2;
  }

  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const profile = fs.mkdtempSync(path.join(resolvedTemporaryRoot, 'poppet-electron-smoke-'));
  let exitCode = 1;

  try {
    const executable = electronPath || require('electron');
    const phases = mode === '--test-manager'
      ? ['--test-manager', '--test-manager-restart']
      : [mode];
    exitCode = 0;
    for (const phase of phases) {
      logger.log(`[electron-smoke] ${phase}`);
      let result;
      try {
        result = spawnSyncImpl(executable, [resolvedProjectRoot, '--dev', phase], {
          cwd: resolvedProjectRoot,
          env: { ...environment, POPPET_TEST_USER_DATA: profile },
          stdio: 'inherit',
          timeout: SMOKE_PHASE_TIMEOUT_MS,
          killSignal: 'SIGTERM',
        });
      } catch (error) {
        logger.error(`Electron smoke ${phase} could not start: ${error?.message || error}`);
        exitCode = 1;
        break;
      }

      if (result?.error) {
        if (result.error.code === 'ETIMEDOUT') {
          logger.error(`Electron smoke ${phase} timed out after ${SMOKE_PHASE_TIMEOUT_MS}ms`);
        } else {
          logger.error(`Electron smoke ${phase} could not start: ${result.error.message}`);
        }
        exitCode = 1;
        break;
      }
      if (result?.signal) {
        logger.error(`Electron smoke ${phase} terminated by ${result.signal}`);
        exitCode = 1;
        break;
      }
      exitCode = Number.isInteger(result?.status) ? result.status : 1;
      if (exitCode !== 0) break;
    }
  } finally {
    const resolved = path.resolve(profile);
    const stat = fs.lstatSync(resolved);
    const safe = path.dirname(resolved) === resolvedTemporaryRoot
      && path.basename(resolved).startsWith('poppet-electron-smoke-')
      && stat.isDirectory()
      && !stat.isSymbolicLink();
    if (!safe) throw new Error(`Refusing to clean unexpected smoke profile: ${resolved}`);
    fs.rmSync(resolved, { recursive: true });
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  let exitCode = 1;
  try {
    exitCode = runElectronSmoke(process.argv[2]);
  } catch (error) {
    console.error(`Electron smoke runner failed: ${error?.stack || error}`);
  }
  process.exit(exitCode);
}

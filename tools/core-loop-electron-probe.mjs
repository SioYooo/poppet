// Node-side adapter for the developer-only Electron performance probe.
// Production packages exclude tools/**. The measurement CLI selects this probe
// by default, but no production/runtime entry point can reach it.

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { sanitizeDiagnosticText } from './core-loop-contract.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const mainScript = path.join(moduleDir, 'core-loop-electron-probe-main.cjs');
const projectRoot = path.resolve(moduleDir, '..');
const SAMPLE_PREFIX = 'POPPET_PERF_SAMPLE ';
const DONE_PREFIX = 'POPPET_PERF_DONE ';
export const performanceProbeIdentity = 'poppet-core-loop-electron-probe-v4';

function sha256Files(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Performance probe source must be regular non-symlink files');
    }
    hash.update(path.basename(file), 'utf8');
    hash.update('\0');
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

const probeSourceSha256 = sha256Files([fileURLToPath(import.meta.url), mainScript]);

function safeRemoveProfile(profile, temporaryRoot) {
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolved = path.resolve(profile);
  const stat = fs.lstatSync(resolved);
  const safe = path.dirname(resolved) === resolvedRoot
    && path.basename(resolved).startsWith('poppet-core-loop-perf-')
    && stat.isDirectory()
    && !stat.isSymbolicLink();
  if (!safe) throw new Error('Refusing to clean an unexpected performance profile');
  fs.rmSync(resolved, { recursive: true, force: false });
}

function timeoutFor(mode, config) {
  const measured = mode === 'soak'
    ? config.warmupMs + config.soakMs
    : config.warmupMs + config.idleMs + config.activeMs + config.recoveryMs;
  return measured + 90_000;
}

function resolveAppRoot(candidate) {
  const resolved = path.resolve(candidate || projectRoot);
  const rootStat = fs.lstatSync(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Performance app root must be a regular directory');
  }
  for (const relative of [
    'package.json',
    'src/main/channels.js',
    'src/main/pet-window.js',
    'src/main/library.js',
    'src/main/security.js',
    'src/renderer/pet/index.html',
  ]) {
    const candidateFile = path.join(resolved, relative);
    const stat = fs.lstatSync(candidateFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Performance app root is missing a required regular source file');
    }
  }
  return resolved;
}

async function runElectronProbe(mode, config, emit) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(temporaryRoot, 'poppet-core-loop-perf-'));
  const appRoot = resolveAppRoot(config.appRoot);
  const childConfig = { ...config };
  delete childConfig.appRoot;
  let completed = false;
  let completedMetadata = null;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(electronPath, [mainScript, '--dev', '--core-loop-performance-probe'], {
        cwd: appRoot,
        env: {
          ...process.env,
          POPPET_CORE_LOOP_PROBE_MODE: mode,
          POPPET_CORE_LOOP_PROBE_CONFIG: JSON.stringify(childConfig),
          POPPET_CORE_LOOP_PROBE_USER_DATA: profile,
          POPPET_CORE_LOOP_PROBE_APP_ROOT: appRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let timer = null;
      let doneCount = null;
      let doneMetadata = null;
      let emitted = 0;
      const diagnostics = [];
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error(`Electron performance probe timed out in ${mode}`));
      }, timeoutFor(mode, config));
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          if (line.startsWith(SAMPLE_PREFIX)) {
            emit(JSON.parse(line.slice(SAMPLE_PREFIX.length)));
            emitted++;
          } else if (line.startsWith(DONE_PREFIX)) {
            const result = JSON.parse(line.slice(DONE_PREFIX.length));
            doneCount = result.samples;
            doneMetadata = result.metadata;
          }
        } catch {
          child.kill('SIGTERM');
          finish(new Error('Electron performance probe emitted invalid JSON'));
        }
      });
      child.once('error', () => finish(new Error('Electron performance probe could not start')));
      child.once('close', code => {
        lines.close();
        if (code !== 0) {
          const detail = diagnostics.length ? `: ${diagnostics.slice(-3).join(' | ')}` : '';
          return finish(new Error(`Electron performance probe exited ${code}${detail}`));
        }
        if (!Number.isSafeInteger(doneCount) || doneCount !== emitted || emitted < 1) {
          return finish(new Error('Electron performance probe did not complete its sample contract'));
        }
        const metadataKeys = [
          'probeIdentity', 'fixtureIdentity', 'settingsIdentity', 'environmentIdentity',
          'electronVersion', 'electronNodeVersion',
        ];
        if (!doneMetadata || typeof doneMetadata !== 'object' || Array.isArray(doneMetadata)
            || Object.keys(doneMetadata).length !== metadataKeys.length
            || metadataKeys.some(key => !(key in doneMetadata))
            || doneMetadata.probeIdentity !== performanceProbeIdentity
            || !/^[0-9a-f]{64}$/.test(doneMetadata.fixtureIdentity)
            || !/^[0-9a-f]{64}$/.test(doneMetadata.settingsIdentity)
            || !/^[0-9a-f]{64}$/.test(doneMetadata.environmentIdentity)
            || !/^\d+\.\d+\.\d+/.test(doneMetadata.electronVersion)
            || !/^\d+\.\d+\.\d+/.test(doneMetadata.electronNodeVersion)) {
          return finish(new Error('Electron performance probe metadata is invalid'));
        }
        completedMetadata = Object.freeze({
          ...doneMetadata,
          probeSourceSha256,
          driverNodeVersion: process.versions.node,
        });
        completed = true;
        finish();
      });
      const errors = readline.createInterface({ input: child.stderr });
      errors.on('line', line => {
        const safe = sanitizeDiagnosticText(line);
        if (safe && safe !== '[redacted-diagnostic]') diagnostics.push(safe);
      });
    });
  } finally {
    safeRemoveProfile(profile, temporaryRoot);
  }
  if (!completed) throw new Error(`Electron performance probe ${mode} did not complete`);
  return completedMetadata;
}

export async function collectPerformanceScenario({ config, emit }) {
  return runElectronProbe('scenario', config, emit);
}

export async function collectPerformanceSoak({ config, emit }) {
  return runElectronProbe('soak', config, emit);
}

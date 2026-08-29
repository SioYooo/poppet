'use strict';

// Dedicated Electron main process for Core-loop performance measurement.
// It is launched only by tools/core-loop-electron-probe.mjs, uses an isolated
// profile, never initializes the normal tray/Manager/library state, and is
// excluded from production packages with the existing !tools/**/* allowlist.

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const {
  app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, screen,
} = require('electron');

const appRoot = configureAppRoot(process.env.POPPET_CORE_LOOP_PROBE_APP_ROOT);
const { CH } = require(path.join(appRoot, 'src/main/channels'));
const { PetWindow } = require(path.join(appRoot, 'src/main/pet-window'));
const lib = require(path.join(appRoot, 'src/main/library'));
const {
  assertTrustedIpcFrame,
  noArguments,
  oneArgument,
  safeIpcListener,
  validateBoolean,
  validateLog,
  validateMove,
} = require(path.join(appRoot, 'src/main/security'));

const SAMPLE_PREFIX = 'POPPET_PERF_SAMPLE ';
const DONE_PREFIX = 'POPPET_PERF_DONE ';
const PROBE_IDENTITY = 'poppet-core-loop-electron-probe-v4';
const PET_HTML = path.join(appRoot, 'src/renderer/pet/index.html');
const mode = process.env.POPPET_CORE_LOOP_PROBE_MODE;
const profile = process.env.POPPET_CORE_LOOP_PROBE_USER_DATA;
const config = parseConfig(process.env.POPPET_CORE_LOOP_PROBE_CONFIG);
configureProfile(profile);

const settings = Object.freeze({
  activeId: null,
  scale: 0.5,
  wander: false,
  clickThrough: true,
  alwaysOnTop: true,
  fps: 60,
  position: null,
  pets: null,
});

let pets = [];
let samples = 0;
let mainCrashCount = 0;
let mainUnhandledCount = 0;
let suspensionBlockerId = null;
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
const rendererErrors = new Map();

// Register at WebContents creation time, before PetWindow starts navigation or
// its preload. The in-page listeners installed below cover ordinary runtime
// errors; these main-side observers retain failures that happen before that
// injection can run.
app.on('web-contents-created', (_event, contents) => {
  const state = { errors: 0 };
  rendererErrors.set(contents.id, state);
  contents.on('console-message', (_consoleEvent, level) => {
    if (Number(level) >= 3) state.errors++;
  });
  contents.on('preload-error', () => { state.errors++; });
  contents.on('did-fail-load', (_loadEvent, _code, _description, _url, isMainFrame) => {
    if (isMainFrame !== false) state.errors++;
  });
  contents.on('unresponsive', () => { state.errors++; });
  contents.once('destroyed', () => { rendererErrors.delete(contents.id); });
});

function configureAppRoot(candidate) {
  const resolved = candidate && path.resolve(candidate);
  let stat = null;
  try { stat = resolved ? fs.lstatSync(resolved) : null; } catch {}
  if (!resolved || !stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Electron performance probe requires a regular app root');
  }
  return resolved;
}

function parseConfig(raw) {
  let value;
  try { value = JSON.parse(raw || ''); } catch { throw new Error('Invalid performance probe config'); }
  const allowed = mode === 'soak'
    ? new Set(['topology', 'repetition', 'warmupMs', 'soakMs', 'sampleIntervalMs'])
    : new Set(['topology', 'repetition', 'warmupMs', 'idleMs', 'activeMs', 'recoveryMs', 'sampleIntervalMs']);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid performance probe config');
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown performance probe config key: ${key}`);
  for (const key of allowed) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error(`Invalid performance probe config value: ${key}`);
  }
  if (![1, 3, 6].includes(value.topology)) throw new Error('Performance topology must be 1, 3, or 6');
  return Object.freeze(value);
}

function configureProfile(candidate) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = candidate && path.resolve(candidate);
  let stat = null;
  try { stat = resolved ? fs.lstatSync(resolved) : null; } catch {}
  const safe = resolved
    && path.dirname(resolved) === temporaryRoot
    && path.basename(resolved).startsWith('poppet-core-loop-perf-')
    && stat?.isDirectory()
    && !stat.isSymbolicLink();
  if (!safe) throw new Error('Electron performance probe requires an isolated profile');
  app.setPath('userData', resolved);
}

function trustedPet(event) {
  const pet = pets.find(candidate => candidate.win?.webContents === event.sender);
  if (!pet) throw new Error('Unknown performance pet renderer');
  assertTrustedIpcFrame(event, pet.win.webContents, PET_HTML);
  return pet;
}

ipcMain.handle(CH.PET_READY, (event, ...args) => {
  const pet = trustedPet(event);
  noArguments(args);
  return { character: pet.character, settings };
});
if (CH.PET_FRAME_READY) {
  if (typeof PetWindow.prototype.markFirstFrameReady !== 'function') {
    throw new Error('App root exposes first-frame IPC without the readiness contract');
  }
  ipcMain.handle(CH.PET_FRAME_READY, (event, ...args) => {
    const pet = trustedPet(event);
    noArguments(args);
    // Match the production readiness contract: T5 is the main-process receipt
    // of the first trusted, argument-free non-empty-frame acknowledgement.
    return pet.markFirstFrameReady();
  });
}
ipcMain.handle(CH.PET_MOVE_BY, (event, ...args) => {
  const pet = trustedPet(event);
  const move = oneArgument(args, validateMove);
  return pet.moveBy(move.dx, move.dy);
});
ipcMain.on(CH.PET_SET_INTERACTIVE, safeIpcListener(CH.PET_SET_INTERACTIVE, (event, ...args) => {
  const pet = trustedPet(event);
  pet.setInteractive(oneArgument(args, value => validateBoolean(value, 'interactive')));
}));
ipcMain.on(CH.PET_LOG, safeIpcListener(CH.PET_LOG, (event, ...args) => {
  trustedPet(event);
  oneArgument(args, validateLog);
}));

process.on('uncaughtException', () => { mainUnhandledCount++; });
process.on('unhandledRejection', () => { mainUnhandledCount++; });
app.on('render-process-gone', (_event, _webContents, details) => {
  if (details?.reason !== 'clean-exit') mainCrashCount++;
});
app.on('window-all-closed', () => {});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function numericBucket(value, limits) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 'unknown';
  for (const limit of limits) if (number <= limit) return `<=${limit}`;
  return `>${limits.at(-1)}`;
}

function environmentIdentity() {
  const displays = screen.getAllDisplays().map(display => ({
    widthBucket: numericBucket(display.size?.width, [1280, 1920, 2560, 3840]),
    heightBucket: numericBucket(display.size?.height, [720, 1080, 1440, 2160]),
    scaleFactorBucket: numericBucket(display.scaleFactor, [1, 1.25, 1.5, 2]),
    refreshRateBucket: numericBucket(display.displayFrequency, [60, 90, 120, 165]),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = {
    displayCount: displays.length,
    displays,
    onBatteryPower: powerMonitor.isOnBatteryPower(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function emit(sample) {
  process.stdout.write(`${SAMPLE_PREFIX}${JSON.stringify(sample)}\n`);
  samples++;
}

function metricSnapshot() {
  const metrics = app.getAppMetrics();
  if (!Array.isArray(metrics) || !metrics.length) {
    throw new Error('Electron app metrics snapshot is unavailable');
  }
  const byPid = new Map();
  for (const metric of metrics) {
    if (Number.isSafeInteger(metric?.pid)) byPid.set(metric.pid, metric);
  }
  return byPid;
}

// GPU 与 utility 进程占了每次运行 ~100-200 MiB 的真实足迹，之前完全不在
// 数字里。按 Electron metric.type 归类：'GPU' 单独一行；除 Browser（main）
// 与 Tab（renderer，另行按宠采样）以外的其余进程合并为一行 'utility'。
// Manager 窗口的 Tab 进程仍未单独采样，这是已知且有意的边界。
function auxiliaryProcessSamples(phase, elapsedMs, snapshot) {
  let gpuCpu = 0, gpuMiB = 0, gpuSeen = false;
  let utilCpu = 0, utilMiB = 0, utilSeen = false;
  for (const metric of snapshot.values()) {
    const cpu = Number.isFinite(metric.cpu?.percentCPUUsage)
      ? Math.max(0, metric.cpu.percentCPUUsage) : 0;
    const miB = Number.isFinite(metric.memory?.workingSetSize)
      ? Math.max(0, metric.memory.workingSetSize / 1024) : 0;
    if (metric.type === 'GPU') {
      gpuSeen = true; gpuCpu += cpu; gpuMiB += miB;
    } else if (metric.type !== 'Browser' && metric.type !== 'Tab') {
      utilSeen = true; utilCpu += cpu; utilMiB += miB;
    }
  }
  const base = {
    topology: config.topology,
    repetition: config.repetition,
    phase,
    elapsedMs,
    processSlot: 0,
    frameIntervalMs: null,
    frameIntervalP50Ms: null,
    frameIntervalP95Ms: null,
    frameIntervalP99Ms: null,
    frameIntervalSampleCount: 0,
    frameIntervalHistogram: null,
    renderWorkMs: null,
    longFrame: false,
    longFrameCount: 0,
    longFrameRate: null,
    eventLoopStallMs: 0,
    crashCount: 0,
    unhandledErrorCount: 0,
    petCount: phase === 'recovery' ? 0 : pets.length,
    windowCount: BrowserWindow.getAllWindows().length,
    timerCount: null,
    listenerCount: null,
  };
  const out = [];
  if (gpuSeen) out.push({ ...base, processType: 'gpu', cpuPercent: gpuCpu, memoryMiB: gpuMiB });
  if (utilSeen) out.push({ ...base, processType: 'utility', cpuPercent: utilCpu, memoryMiB: utilMiB });
  return out;
}

function processMetric(snapshot, pid) {
  const metric = snapshot.get(pid);
  if (!metric || !Number.isFinite(metric.cpu?.percentCPUUsage)
      || !Number.isFinite(metric.memory?.workingSetSize)) {
    throw new Error('Electron app metrics are unavailable for a required process');
  }
  return {
    cpuPercent: Math.max(0, metric.cpu.percentCPUUsage),
    memoryMiB: Math.max(0, metric.memory.workingSetSize / 1024),
  };
}

function listenerCount() {
  const emitters = [process, app, ipcMain];
  for (const pet of pets) {
    if (pet.win && !pet.win.isDestroyed()) emitters.push(pet.win, pet.win.webContents);
  }
  return emitters.reduce((total, emitter) => total
    + emitter.eventNames().reduce((sum, eventName) => sum + emitter.listenerCount(eventName), 0), 0);
}

function timerCount() {
  return (process.getActiveResourcesInfo?.() || []).filter(name => name === 'Timeout').length;
}

let resourceBaseline = null;

function mainSample(phase, elapsedMs, snapshot) {
  const metric = processMetric(snapshot, process.pid);
  const timerDelta = Math.max(0, timerCount() - resourceBaseline.timers);
  const listenerDelta = Math.max(0, listenerCount() - resourceBaseline.listeners);
  const stall = Number.isFinite(eventLoop.max) ? eventLoop.max / 1e6 : 0;
  eventLoop.reset();
  const crashCount = mainCrashCount;
  const unhandledErrorCount = mainUnhandledCount;
  mainCrashCount = 0;
  mainUnhandledCount = 0;
  return {
    topology: config.topology,
    repetition: config.repetition,
    phase,
    elapsedMs,
    processType: 'main',
    processSlot: 0,
    ...metric,
    frameIntervalMs: null,
    frameIntervalP50Ms: null,
    frameIntervalP95Ms: null,
    frameIntervalP99Ms: null,
    frameIntervalSampleCount: 0,
    frameIntervalHistogram: null,
    renderWorkMs: null,
    longFrame: false,
    longFrameCount: 0,
    longFrameRate: null,
    eventLoopStallMs: Math.max(0, stall),
    crashCount,
    unhandledErrorCount,
    petCount: phase === 'recovery' ? 0 : pets.length,
    windowCount: BrowserWindow.getAllWindows().length,
    timerCount: timerDelta,
    listenerCount: listenerDelta,
  };
}

function takeEarlyRendererErrors(contents) {
  const state = rendererErrors.get(contents.id);
  if (!state) return 0;
  const count = state.errors;
  state.errors = 0;
  return count;
}

async function rendererSample(pet, slot, phase, elapsedMs, snapshot) {
  const state = await pet.win.webContents.executeJavaScript(`(() => {
    const pace = window.__poppetPace.read();
    const errors = window.__poppetPerfProbeErrors || { errors: 0, rejections: 0 };
    const result = { pace, errors: errors.errors + errors.rejections };
    errors.errors = 0;
    errors.rejections = 0;
    window.__poppetPace.reset();
    return result;
  })()`);
  const metric = processMetric(snapshot, pet.win.webContents.getOSProcessId());
  const pace = state.pace || {};
  const intervalCount = Number.isSafeInteger(pace.intervalCount) && pace.intervalCount >= 0
    ? pace.intervalCount : 0;
  const longFrameCount = Number.isSafeInteger(pace.longFrameCount) && pace.longFrameCount >= 0
    ? pace.longFrameCount : 0;
  const histogram = pace.intervalHistogram || null;
  const p50 = Number.isFinite(pace.intervalP50Ms) ? Math.max(0, pace.intervalP50Ms) : null;
  const p95 = Number.isFinite(pace.intervalP95Ms) ? Math.max(0, pace.intervalP95Ms) : null;
  const p99 = Number.isFinite(pace.intervalP99Ms) ? Math.max(0, pace.intervalP99Ms) : null;
  return {
    topology: config.topology,
    repetition: config.repetition,
    phase,
    elapsedMs,
    processType: 'renderer',
    processSlot: slot,
    ...metric,
    // Keep frameIntervalMs for schema/backward compatibility, but make it a
    // measured median rather than the old 1000/fps estimate.
    frameIntervalMs: p50,
    frameIntervalP50Ms: p50,
    frameIntervalP95Ms: p95,
    frameIntervalP99Ms: p99,
    frameIntervalSampleCount: intervalCount,
    frameIntervalHistogram: histogram,
    renderWorkMs: Number.isFinite(pace.workAvg) ? Math.max(0, pace.workAvg) : null,
    longFrame: longFrameCount > 0,
    longFrameCount,
    longFrameRate: intervalCount > 0 ? longFrameCount / intervalCount : null,
    eventLoopStallMs: Number.isFinite(pace.dtMax)
      && Number.isFinite(pace.targetFps) && pace.targetFps > 0
      ? Math.max(0, pace.dtMax - (1000 / pace.targetFps)) : 0,
    crashCount: 0,
    unhandledErrorCount: (Number.isSafeInteger(state.errors) ? state.errors : 0)
      + takeEarlyRendererErrors(pet.win.webContents),
    petCount: pets.length,
    windowCount: BrowserWindow.getAllWindows().length,
    timerCount: null,
    listenerCount: null,
    skippedFrameCount: Number.isSafeInteger(pace.skippedFrameCount) && pace.skippedFrameCount >= 0
      ? pace.skippedFrameCount : 0,
  };
}

async function initializeRendererProbe(pet) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const ready = await pet.win.webContents.executeJavaScript(`(() => {
        if (!window.__poppetPace || !window.__poppetPetDev || !window.__poppetDev) return false;
        if (!window.__poppetPerfProbeErrors) {
          const state = { errors: 0, rejections: 0 };
          window.addEventListener('error', () => { state.errors++; });
          window.addEventListener('unhandledrejection', () => { state.rejections++; });
          window.__poppetPerfProbeErrors = state;
        }
        window.__poppetPace.reset();
        const matches = window.__poppetDev.charId() === ${JSON.stringify(pet.characterId)};
        if (matches) {
          // The final app has additional Manager evidence callbacks that the
          // instrumentation-first baseline intentionally lacks. Performance
          // needs only charId, so replace the dev object with the same minimal
          // frozen surface on both endpoints before warmup.
          const charId = window.__poppetDev.charId;
          window.__poppetDev = Object.freeze({ charId });
        }
        return matches;
      })()`);
      if (ready) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('Pet renderer development hooks did not become ready');
}

async function waitForRenderedInterval(pet) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const intervalCount = await pet.win.webContents.executeJavaScript(
        'window.__poppetPace?.read()?.intervalCount || 0');
      if (Number.isSafeInteger(intervalCount) && intervalCount >= 1) return;
    } catch {}
    await sleep(25);
  }
  throw new Error('Pet renderer did not produce a measured frame interval');
}

async function createPets(count) {
  const base = lib.loadBuiltinCharacter('default');
  if (!base?.meta?.sprite || !base.spriteDataURL) throw new Error('Tracked default character is unavailable');
  for (let index = 0; index < count; index++) {
    const character = { ...base, id: `performance-${index + 1}` };
    const pet = new PetWindow(character, index);
    pet.create(settings, character.meta.sprite, null);
    pets.push(pet);
  }
  await Promise.all(pets.map(async pet => {
    await initializeRendererProbe(pet);
    // The instrumentation-first baseline predates PetWindow's explicit T5
    // latch. Give both endpoints the same renderer-side readiness threshold
    // before warmup; a newer latch is checked only after that shared threshold
    // and therefore cannot shift a measured phase.
    await waitForRenderedInterval(pet);
    if (typeof pet.waitForFirstFrame === 'function') await pet.waitForFirstFrame(15_000);
  }));
  // Prime Electron's interval CPU metric after every required process exists.
  app.getAppMetrics();
}

async function resetPaces(active = false) {
  await Promise.all(pets.map(pet => pet.win.webContents.executeJavaScript(`(() => {
    window.__poppetPace.reset();
    ${active ? "window.__poppetPetDev.act('shake');" : ''}
    return true;
  })()`)));
}

async function samplePetPhase(phase, durationMs, active = false) {
  await resetPaces(active);
  const started = performance.now();
  const deadline = started + durationMs;
  let nextTick = started + config.sampleIntervalMs;
  while (nextTick <= deadline) {
    if (active) {
      await Promise.all(pets.map(pet => pet.win.webContents
        .executeJavaScript("window.__poppetPetDev.act('shake')")));
    }
    const remaining = nextTick - performance.now();
    if (remaining > 0) await sleep(remaining);
    const elapsedMs = Math.max(0, performance.now() - started);
    // One immutable Electron metric snapshot per sampling tick. Every main and
    // renderer process observation below is assigned from this same snapshot.
    const snapshot = metricSnapshot();
    emit(mainSample(phase, elapsedMs, snapshot));
    auxiliaryProcessSamples(phase, elapsedMs, snapshot).forEach(emit);
    const rendererSamples = await Promise.all(pets.map((pet, index) =>
      rendererSample(pet, index + 1, phase, elapsedMs, snapshot)));
    rendererSamples.forEach(emit);
    do { nextTick += config.sampleIntervalMs; } while (nextTick <= performance.now());
  }
}

async function destroyPets() {
  for (const pet of pets) pet.destroy();
  pets = [];
  const deadline = Date.now() + 5_000;
  while (BrowserWindow.getAllWindows().length && Date.now() < deadline) await sleep(25);
  if (BrowserWindow.getAllWindows().length) throw new Error('Pet windows did not close');
}

async function sampleRecovery(durationMs) {
  const started = performance.now();
  const deadline = started + durationMs;
  let nextTick = started + config.sampleIntervalMs;
  while (nextTick <= deadline) {
    const remaining = nextTick - performance.now();
    if (remaining > 0) await sleep(remaining);
    const snapshot = metricSnapshot();
    const recoveryElapsed = Math.max(0, performance.now() - started);
    emit(mainSample('recovery', recoveryElapsed, snapshot));
    auxiliaryProcessSamples('recovery', recoveryElapsed, snapshot).forEach(emit);
    do { nextTick += config.sampleIntervalMs; } while (nextTick <= performance.now());
  }
}

async function run() {
  eventLoop.enable();
  suspensionBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!powerSaveBlocker.isStarted(suspensionBlockerId)) {
    throw new Error('Performance probe could not prevent host suspension');
  }
  const initialEnvironmentIdentity = environmentIdentity();
  try {
    // IPC/error observers and the event-loop probe are part of the harness, so
    // establish their baseline before creating any measured pet.
    resourceBaseline = { timers: timerCount(), listeners: listenerCount() };
    await createPets(config.topology);
    await sleep(config.warmupMs);
    if (mode === 'scenario') {
      await samplePetPhase('idle', config.idleMs, false);
      await samplePetPhase('active', config.activeMs, true);
      await destroyPets();
      await sampleRecovery(config.recoveryMs);
    } else if (mode === 'soak') {
      await samplePetPhase('soak', config.soakMs, false);
      await destroyPets();
    } else {
      throw new Error('Unknown performance probe mode');
    }
    const finalEnvironmentIdentity = environmentIdentity();
    if (finalEnvironmentIdentity !== initialEnvironmentIdentity) {
      throw new Error('Display or power configuration changed during performance measurement');
    }
    const fixtureDirectory = path.join(appRoot, 'assets', 'characters', 'default');
    const fixtureHash = crypto.createHash('sha256');
    for (const name of ['character.json', 'pet.png', 'parts.png']) {
      const file = path.join(fixtureDirectory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Performance fixture must contain regular non-symlink files');
      }
      fixtureHash.update(name, 'utf8');
      fixtureHash.update('\0');
      fixtureHash.update(fs.readFileSync(file));
    }
    const settingsIdentity = crypto.createHash('sha256')
      .update(JSON.stringify({
        petSettings: settings,
        probePowerPolicy: 'prevent-app-suspension',
      }), 'utf8').digest('hex');
    process.stdout.write(`${DONE_PREFIX}${JSON.stringify({
      samples,
      metadata: {
        probeIdentity: PROBE_IDENTITY,
        fixtureIdentity: fixtureHash.digest('hex'),
        settingsIdentity,
        environmentIdentity: initialEnvironmentIdentity,
        electronVersion: process.versions.electron,
        electronNodeVersion: process.versions.node,
      },
    })}\n`);
  } finally {
    eventLoop.disable();
    if (Number.isSafeInteger(suspensionBlockerId)
        && powerSaveBlocker.isStarted(suspensionBlockerId)) {
      powerSaveBlocker.stop(suspensionBlockerId);
    }
    suspensionBlockerId = null;
  }
  app.quit();
}

app.whenReady().then(run).catch(error => {
  eventLoop.disable();
  if (Number.isSafeInteger(suspensionBlockerId)
      && powerSaveBlocker.isStarted(suspensionBlockerId)) {
    powerSaveBlocker.stop(suspensionBlockerId);
  }
  suspensionBlockerId = null;
  process.stderr.write(`[core-loop-electron-probe] ${error?.message || 'failed'}\n`);
  for (const pet of pets) pet.destroy();
  pets = [];
  app.exit(1);
});

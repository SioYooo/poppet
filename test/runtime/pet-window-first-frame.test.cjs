'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

class FakeWebContents extends EventEmitter {
  send() {}
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  static showThrows = false;
  static rejectLoad = false;

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.visible = false;
    this.visibleOnAllWorkspacesArgs = null;
    this.position = [0, 0];
    this.size = [options.width, options.height];
    this.listenerSnapshotAtLoad = null;
    FakeBrowserWindow.instances.push(this);
  }

  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces(...args) { this.visibleOnAllWorkspacesArgs = args; }
  setIgnoreMouseEvents() {}
  setPosition(x, y) { this.position = [x, y]; }
  getPosition() { return this.position; }
  getSize() { return this.size; }
  setBounds({ x, y, width, height }) { this.position = [x, y]; this.size = [width, height]; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  show() {
    if (FakeBrowserWindow.showThrows) throw new Error('private fake path must not escape');
    this.visible = true;
    this.emit('show');
  }
  loadFile() {
    this.listenerSnapshotAtLoad = {
      didFail: this.webContents.listenerCount('did-fail-load'),
      preload: this.webContents.listenerCount('preload-error'),
      gone: this.webContents.listenerCount('render-process-gone'),
      ready: this.listenerCount('ready-to-show'),
      show: this.listenerCount('show'),
      closed: this.listenerCount('closed'),
    };
    return FakeBrowserWindow.rejectLoad
      ? Promise.reject(new Error('private fake load path'))
      : Promise.resolve();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
}

const fakeElectron = {
  app: { isPackaged: true },
  BrowserWindow: FakeBrowserWindow,
  nativeImage: {},
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};
const { PetWindow } = require('../../src/main/pet-window');
Module._load = originalLoad;

function makePet({ showThrows = false, rejectLoad = false } = {}) {
  FakeBrowserWindow.showThrows = showThrows;
  FakeBrowserWindow.rejectLoad = rejectLoad;
  const pet = new PetWindow({ id: 'test-pet' }, 0);
  pet.create({ scale: 1 }, { width: 16, height: 16 });
  return { pet, win: pet.win };
}

test('all terminal and visibility listeners are installed before loadFile', () => {
  const { win } = makePet();
  assert.deepEqual(win.listenerSnapshotAtLoad,
    { didFail: 1, preload: 1, gone: 1, ready: 1, show: 1, closed: 1 });
  if (process.platform === 'darwin') {
    assert.deepEqual(win.visibleOnAllWorkspacesArgs,
      [true, { visibleOnFullScreen: true }]);
  } else {
    assert.equal(win.visibleOnAllWorkspacesArgs, null);
  }
});

test('first-frame gate requires both exact first ack and visible window in either order', async () => {
  {
    const { pet, win } = makePet();
    const waiting = pet.waitForFirstFrame(100);
    const first = pet.markFirstFrameReady();
    assert.equal(first.ready, true);
    assert.equal(pet.isFirstFrameLive(), false);
    win.emit('ready-to-show');
    const result = await waiting;
    assert.equal(result.readyAt, first.readyAt);
    assert.equal(pet.isFirstFrameLive(), true);
    const duplicate = pet.markFirstFrameReady();
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.readyAt, first.readyAt, 'duplicate ack must not rewrite T5');
    pet.destroy();
  }
  {
    const { pet, win } = makePet();
    win.emit('ready-to-show');
    const waiting = pet.waitForFirstFrame(100);
    const first = pet.markFirstFrameReady();
    assert.equal((await waiting).readyAt, first.readyAt);
    pet.destroy();
  }
});

test('timeout is terminal, clears waiters and rejects late ack', async () => {
  const { pet } = makePet();
  await assert.rejects(pet.waitForFirstFrame(5), error => error.code === 'POPPET_PET_FRAME_TIMEOUT');
  assert.equal(pet._firstFrameWaiters.size, 0);
  const late = pet.markFirstFrameReady();
  assert.equal(late.ready, false);
  assert.equal(late.terminal, true);
  assert.equal(pet.firstFrameReadyAt, null);
  pet.destroy();
});

test('loadFile rejection is sanitized, terminal and cleanup-notified', async () => {
  const { pet } = makePet({ rejectLoad: true });
  let unavailable = 0;
  pet.onUnavailable = () => { unavailable++; };
  await assert.rejects(pet.waitForFirstFrame(100), error => {
    assert.equal(error.code, 'POPPET_PET_LOAD_FAILED');
    assert.doesNotMatch(error.message, /private fake load path/);
    return true;
  });
  assert.equal(pet._firstFrameWaiters.size, 0);
  assert.equal(unavailable, 1);
  pet.destroy();
});

test('subframe did-fail-load cannot terminate the main-frame readiness gate', async () => {
  const { pet, win } = makePet();
  const waiting = pet.waitForFirstFrame(100);
  win.webContents.emit('did-fail-load', {}, -2, 'private', 'private', false);
  assert.equal(pet._firstFrameTerminal, null);
  win.emit('ready-to-show');
  pet.markFirstFrameReady();
  await waiting;
  pet.destroy();
});

for (const [name, emitFailure, code] of [
  ['main-frame load failure', win => win.webContents.emit('did-fail-load', {}, -2, 'private', 'private', true), 'POPPET_PET_LOAD_FAILED'],
  ['preload failure', win => win.webContents.emit('preload-error', {}, 'private', new Error('private')), 'POPPET_PET_PRELOAD_FAILED'],
  ['renderer gone', win => win.webContents.emit('render-process-gone', {}, { reason: 'crashed' }), 'POPPET_PET_RENDERER_GONE'],
  ['closed', win => win.emit('closed'), 'POPPET_PET_CLOSED'],
]) {
  test(`${name} rejects the gate, clears waiters and notifies cleanup`, async () => {
    const { pet, win } = makePet();
    let unavailable = 0;
    pet.onUnavailable = () => { unavailable++; };
    const waiting = pet.waitForFirstFrame(100);
    emitFailure(win);
    await assert.rejects(waiting, error => error.code === code);
    assert.equal(pet._firstFrameWaiters.size, 0);
    assert.equal(unavailable, 1);
    pet.destroy();
  });
}

test('show failure is stable, sanitized and cleanup-notified', async () => {
  const { pet, win } = makePet({ showThrows: true });
  let unavailable = 0;
  pet.onUnavailable = () => { unavailable++; };
  const waiting = pet.waitForFirstFrame(100);
  win.emit('ready-to-show');
  await assert.rejects(waiting, error => {
    assert.equal(error.code, 'POPPET_PET_SHOW_FAILED');
    assert.doesNotMatch(error.message, /private fake path/);
    return true;
  });
  assert.equal(unavailable, 1);
  pet.destroy();
});

test('a close after ack+visible makes the exact instance non-live and notifies main', async () => {
  const { pet, win } = makePet();
  let unavailable = 0;
  pet.onUnavailable = () => { unavailable++; };
  win.emit('ready-to-show');
  pet.markFirstFrameReady();
  await pet.waitForFirstFrame(100);
  win.emit('closed');
  assert.equal(pet.isFirstFrameLive(), false);
  assert.equal(unavailable, 1);
});

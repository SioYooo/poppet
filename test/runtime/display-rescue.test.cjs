'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createDisplayRescue, DISPLAY_RESCUE_EVENTS } = require('../../src/main/display-rescue');

const EXPECTED_EVENTS = ['display-metrics-changed', 'display-removed'];

// 注入式假定时器：记录挂起回调，由测试显式触发，不做真实等待，没有时序偶发。
function makeFakeTimers() {
  const pending = new Map();
  const cleared = [];
  let nextId = 1;
  return {
    pending,
    cleared,
    setTimeoutImpl(fn, delay) {
      const id = nextId++;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeoutImpl(id) {
      cleared.push(id);
      pending.delete(id);
    },
    // 触发当前全部挂起的定时器，返回触发个数
    fire() {
      const entries = [...pending.values()];
      pending.clear();
      for (const { fn } of entries) fn();
      return entries.length;
    },
  };
}

function makePet({ destroyed = false, noWindow = false, throws = false } = {}) {
  return {
    clampCalls: 0,
    win: noWindow ? null : { isDestroyed: () => destroyed },
    clampToDisplay() {
      this.clampCalls++;
      if (throws) throw new Error('private clamp failure');
      return { x: 0, y: 0 };
    },
  };
}

function setup({ pets = [makePet(), makePet()], delayMs, persistPets } = {}) {
  const timers = makeFakeTimers();
  const screen = new EventEmitter();
  const logged = [];
  let persistCalls = 0;
  const rescue = createDisplayRescue({
    screen,
    getPets: () => pets,
    persistPets: persistPets || (() => { persistCalls++; }),
    delayMs,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    log: (message, error) => { logged.push({ message, error }); },
  });
  return { rescue, screen, timers, pets, logged, persist: () => persistCalls };
}

test('attach() subscribes exactly display-removed and display-metrics-changed, once', () => {
  const { rescue, screen } = setup();
  assert.deepEqual(screen.eventNames(), []);
  rescue.attach();
  assert.deepEqual([...DISPLAY_RESCUE_EVENTS].sort(), EXPECTED_EVENTS);
  assert.deepEqual([...screen.eventNames()].sort(), EXPECTED_EVENTS);
  for (const event of EXPECTED_EVENTS) assert.equal(screen.listenerCount(event), 1);
  rescue.attach(); // 重复 attach 不得重复挂监听
  for (const event of EXPECTED_EVENTS) assert.equal(screen.listenerCount(event), 1);
});

test('five rapid events coalesce into one delayed clamp + one persist, and it re-arms afterwards', () => {
  const { rescue, screen, timers, pets, persist } = setup();
  rescue.attach();
  screen.emit('display-removed', {}, { id: 1 });
  screen.emit('display-metrics-changed', {}, { id: 2 }, ['bounds']);
  screen.emit('display-metrics-changed', {}, { id: 2 }, ['workArea']);
  screen.emit('display-removed', {}, { id: 3 });
  screen.emit('display-metrics-changed', {}, { id: 2 }, ['scaleFactor']);

  // 到期前什么都不做
  assert.deepEqual(pets.map(p => p.clampCalls), [0, 0]);
  assert.equal(persist(), 0);
  assert.equal(timers.pending.size, 1, 'only the trailing timer may be pending');
  assert.equal([...timers.pending.values()][0].delay, 100, 'default debounce is 100ms');
  assert.equal(timers.cleared.length, 4, 'each follow-up event resets the previous timer');

  assert.equal(timers.fire(), 1);
  assert.deepEqual(pets.map(p => p.clampCalls), [1, 1]);
  assert.equal(persist(), 1);

  // 不是一次性的：安静之后再来一阵仍会救援一次
  screen.emit('display-removed', {}, { id: 4 });
  screen.emit('display-metrics-changed', {}, { id: 2 }, ['bounds']);
  assert.equal(timers.pending.size, 1);
  assert.equal(timers.fire(), 1);
  assert.deepEqual(pets.map(p => p.clampCalls), [2, 2]);
  assert.equal(persist(), 2);
});

test('delayMs is honoured', () => {
  const { rescue, screen, timers } = setup({ delayMs: 250 });
  rescue.attach();
  screen.emit('display-removed', {}, { id: 1 });
  assert.equal([...timers.pending.values()][0].delay, 250);
});

test('a throwing pet is reported and skipped; siblings are clamped and persist still runs once', () => {
  const pets = [makePet(), makePet({ throws: true }), makePet()];
  const { rescue, screen, timers, persist, logged } = setup({ pets });
  rescue.attach();
  screen.emit('display-removed', {}, { id: 1 });
  assert.doesNotThrow(() => timers.fire());
  assert.deepEqual(pets.map(p => p.clampCalls), [1, 1, 1]);
  assert.equal(persist(), 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0].error.message, /private clamp failure/);
});

test('destroyed or window-less pets are skipped without touching clamp; live siblings still rescued', () => {
  const pets = [makePet({ destroyed: true }), makePet(), makePet({ noWindow: true }), null];
  const { rescue, screen, timers, persist, logged } = setup({ pets });
  rescue.attach();
  screen.emit('display-metrics-changed', {}, { id: 1 }, ['workArea']);
  assert.doesNotThrow(() => timers.fire());
  assert.deepEqual(pets.slice(0, 3).map(p => p.clampCalls), [0, 1, 0]);
  assert.equal(persist(), 1);
  assert.equal(logged.length, 0, 'skipping is not an error');
});

test('pets are read live at fire time, not captured at attach', () => {
  const timers = makeFakeTimers();
  const screen = new EventEmitter();
  const petA = makePet();
  const petB = makePet();
  let current = [petA];
  let persistCalls = 0;
  const rescue = createDisplayRescue({
    screen,
    getPets: () => current,
    persistPets: () => { persistCalls++; },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  rescue.attach();
  screen.emit('display-removed', {}, { id: 1 });
  current = [petB]; // index.js 会重新赋值 pets 数组
  timers.fire();
  assert.equal(petA.clampCalls, 0);
  assert.equal(petB.clampCalls, 1);
  assert.equal(persistCalls, 1);
});

test('dispose() clears the pending timer, removes both listeners, and nothing fires afterwards', () => {
  const { rescue, screen, timers, pets, persist } = setup();
  rescue.attach();
  screen.emit('display-removed', {}, { id: 1 });
  assert.equal(timers.pending.size, 1);
  const [pendingId, pendingEntry] = [...timers.pending.entries()][0];

  rescue.dispose();
  assert.equal(timers.pending.size, 0, 'pending timer must be cleared');
  assert.ok(timers.cleared.includes(pendingId), 'clearTimeout must be called with the pending id');
  for (const event of EXPECTED_EVENTS) assert.equal(screen.listenerCount(event), 0);
  assert.deepEqual(screen.eventNames(), []);

  // dispose 之后再来事件也不排程
  screen.emit('display-removed', {}, { id: 2 });
  screen.emit('display-metrics-changed', {}, { id: 2 }, ['bounds']);
  assert.equal(timers.pending.size, 0);

  // 即使被取消的回调仍被某个过期的真实定时器调用，也不得再动 pet 或落盘
  pendingEntry.fn();
  assert.deepEqual(pets.map(p => p.clampCalls), [0, 0]);
  assert.equal(persist(), 0);

  rescue.dispose(); // 幂等
  rescue.attach();  // dispose 是终态：退出路径之后不可复活
  assert.deepEqual(screen.eventNames(), []);
  assert.equal(timers.pending.size, 0);
});

test('persistPets or getPets throwing is contained and reported instead of escaping the timer', () => {
  {
    const pets = [makePet()];
    const { rescue, screen, timers, logged } = setup({
      pets,
      persistPets: () => { throw new Error('private persist failure'); },
    });
    rescue.attach();
    screen.emit('display-metrics-changed', {}, { id: 1 }, ['workArea']);
    assert.doesNotThrow(() => timers.fire());
    assert.equal(pets[0].clampCalls, 1);
    assert.equal(logged.length, 1);
    assert.match(logged[0].error.message, /private persist failure/);
  }
  {
    const timers = makeFakeTimers();
    const screen = new EventEmitter();
    let persistCalls = 0;
    const rescue = createDisplayRescue({
      screen,
      getPets: () => { throw new Error('private roster failure'); },
      persistPets: () => { persistCalls++; },
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      // 未注入 log：错误静默吞掉，也不能抛
    });
    rescue.attach();
    screen.emit('display-removed', {}, { id: 1 });
    assert.doesNotThrow(() => timers.fire());
    assert.equal(persistCalls, 0, 'without a roster there is nothing to persist');
  }
});

test('missing collaborators fail closed at construction', () => {
  const screen = new EventEmitter();
  const noop = () => {};
  assert.throws(() => createDisplayRescue(), TypeError);
  assert.throws(() => createDisplayRescue({ getPets: noop, persistPets: noop }), TypeError);
  assert.throws(() => createDisplayRescue({ screen, persistPets: noop }), TypeError);
  assert.throws(() => createDisplayRescue({ screen, getPets: noop }), TypeError);
  assert.deepEqual(screen.eventNames(), [], 'a rejected construction must not leave listeners behind');
});

// 主进程接线是源码文本断言（与 manager 渲染层 UI 断言同级的证据强度）：
// 保护"before-quit 里先 dispose 再 persistPets/清空 pets"这一顺序——顺序反了
// 会让去抖定时器把空列表写回磁盘，抹掉所有桌宠的位置记忆。
test('main wiring: rescue is attached after ready and disposed before before-quit persists', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  assert.match(source, /require\('\.\/display-rescue'\)/);
  assert.match(source, /displayRescue = createDisplayRescue\(\{[\s\S]*?getPets: \(\) => pets,[\s\S]*?persistPets,[\s\S]*?\}\);\s*displayRescue\.attach\(\);/);

  const beforeQuit = source.match(/app\.on\('before-quit', \(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(beforeQuit, 'before-quit handler must exist');
  // 只看代码，不看行注释：注释里提到 persistPets() 不能左右顺序判断
  const body = beforeQuit[1].replace(/^\s*\/\/.*$/gm, '');
  const disposeAt = body.indexOf('displayRescue.dispose()');
  const persistAt = body.indexOf('persistPets()');
  const clearAt = body.indexOf('pets = []');
  assert.ok(disposeAt >= 0, 'before-quit must dispose the display rescue');
  assert.ok(persistAt >= 0 && clearAt >= 0);
  assert.ok(disposeAt < persistAt, 'dispose must precede the final persistPets()');
  assert.ok(disposeAt < clearAt, 'dispose must precede pets = []');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { Brain } from '../../src/renderer/pet/brain.js';

function withRandom(value, callback) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return callback();
  } finally {
    Math.random = original;
  }
}

function pokeState(anchor, randomValue) {
  return withRandom(randomValue, () => {
    const brain = new Brain({ wander: true });
    brain.setRig({
      anchor,
      flip: true,
      motion: anchor === 'center' ? 'float' : 'walk',
      swayFrom: 0.5,
    });
    brain.onPoke();
    return brain.state;
  });
}

test('click reactions exclude the removed giggle action', () => {
  const samples = [0, 0.499999, 0.5, 0.999999];
  const grounded = [...new Set(samples.map(value => pokeState('feet', value)))].sort();
  const floating = [...new Set(samples.map(value => pokeState('center', value)))].sort();

  assert.deepEqual(grounded, ['hop', 'shake']);
  assert.deepEqual(floating, ['settle', 'shake']);
});

test('the removed giggle command cannot reactivate the old state', () => {
  const brain = new Brain({ wander: true });
  brain.onCommand('giggle');
  assert.equal(brain.state, 'idle');
});

test('hop motion does not force a blink when the independent blink timer is not due', () => {
  const brain = new Brain({ wander: true });
  brain.blinkTimer = 999;
  brain.onCommand('hop');
  brain.update(1 / 60, { atLeft: false, atRight: false });
  assert.equal(brain.state, 'hop');
  assert.equal(brain.blinkPhase, null);
  assert.equal(brain.blink, 1);
});

// Regression for the afterSign identity check: `codesign -d` prints its
// display output (TeamIdentifier= included) on stderr and leaves stdout empty,
// so a stdout-only capture can never see a real Developer ID and would let the
// ad-hoc repair silently overwrite a genuinely signed build. The decision logic
// is tested portably via the injectable runner; the live check runs only where
// a codesign binary and a platform-signed app actually exist.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const afterSign = require('../../build/after-sign.cjs');

const signedDisplay = [
  'Executable=/Applications/Poppet.app/Contents/MacOS/Poppet',
  'Identifier=com.sioyoo.poppet',
  'TeamIdentifier=QQ2XB4A1C2',
  'Signature size=4202',
].join('\n');

test('a Developer ID TeamIdentifier in the display output means "do not touch"', () => {
  assert.equal(afterSign.hasRealIdentity('/any.app', () => signedDisplay), true);
});

test('ad-hoc and linker signatures report TeamIdentifier "not set" and are not real identities', () => {
  for (const display of [
    'Identifier=com.sioyoo.poppet\nTeamIdentifier=not set\nSignature=adhoc',
    'Identifier=Electron\nTeamIdentifier=not set\n',
  ]) {
    assert.equal(afterSign.hasRealIdentity('/any.app', () => display), false);
  }
});

test('a codesign failure or empty capture is treated as "no real identity" rather than a crash', () => {
  assert.equal(afterSign.hasRealIdentity('/any.app', () => ''), false);
  assert.equal(afterSign.hasRealIdentity('/any.app', () => { throw new Error('ENOENT'); }), false);
});

test('the live default capture reads both streams, so TeamIdentifier lines are visible at all', { skip: process.platform !== 'darwin' }, t => {
  const candidates = [
    '/System/Applications/Calculator.app',
    '/System/Applications/TextEdit.app',
    '/Applications/Safari.app',
  ];
  const app = candidates.find(candidate => fs.existsSync(candidate));
  if (!app) return t.skip('no platform-signed application found on this Mac');

  const display = afterSign.displaySignature(app);
  assert.match(display, /TeamIdentifier=/,
    'codesign -d display output must be captured; stdout alone is empty and hides real identities');
  assert.equal(afterSign.hasRealIdentity(app), false,
    'Apple platform binaries are signed without a team identifier and must not be treated as Developer ID builds');
});

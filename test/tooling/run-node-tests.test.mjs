// Black-box coverage for tools/run-node-tests.mjs. Every scenario spawns the
// real runner against throwaway directories and files created under
// os.tmpdir(); the repository's own suites are never executed from here, so
// running this file through the runner cannot recurse into itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const runner = path.join(repoRoot, 'tools', 'run-node-tests.mjs');

function runRunner(args, { cwd = repoRoot, marker } = {}) {
  const env = { ...process.env };
  // node --test tags its child processes with NODE_TEST_CONTEXT. A nested
  // `node --test` that inherits the tag refuses to run any file and exits 0,
  // which would turn every scenario below into a vacuous pass. Delete the key;
  // assigning undefined would hand the child the string "undefined".
  delete env.NODE_TEST_CONTEXT;
  if (marker) env.POPPET_TOOLING_MARKER = marker;
  return spawnSync(process.execPath, [runner, ...args], { cwd, env, encoding: 'utf8' });
}

function makeRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `poppet-run-node-tests-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// The generated test appends one line per execution, so the marker file counts
// how many times the runner actually ran it rather than trusting exit codes.
function writePassingTest(file, tag) {
  fs.writeFileSync(file, [
    "import test from 'node:test';",
    "import fs from 'node:fs';",
    `test(${JSON.stringify(tag)}, () => {`,
    `  fs.appendFileSync(process.env.POPPET_TOOLING_MARKER, ${JSON.stringify(`${tag}\n`)});`,
    '});',
    '',
  ].join('\n'));
}

function writeFailingTest(file) {
  fs.writeFileSync(file, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('deliberately fails', () => { assert.equal(1, 2); });",
    '',
  ].join('\n'));
}

function markerLines(marker) {
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [];
}

test('no arguments prints a usage line that admits files and exits 2', () => {
  const result = runRunner([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node tools\/run-node-tests\.mjs <test-directory\|test-file>/);
});

test('a single regular test file runs exactly once and exits 0', (t) => {
  const root = makeRoot(t, 'single');
  const file = path.join(root, 'one.test.mjs');
  const marker = path.join(root, 'marker.txt');
  writePassingTest(file, 'one');

  const result = runRunner([file], { marker });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(markerLines(marker), ['one']);
});

test('a single test file with a failing assertion exits 1 from the test run itself', (t) => {
  const root = makeRoot(t, 'failing');
  const file = path.join(root, 'broken.test.mjs');
  writeFailingTest(file);

  const result = runRunner([file]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^# fail 1$/m);
  assert.doesNotMatch(result.stderr, /Required Node test|Node test file/);
});

test('a missing directory still exits 2 with the missing message', (t) => {
  const root = makeRoot(t, 'missing-dir');

  const result = runRunner([path.join(root, 'definitely-missing')]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Required Node test directory or file is missing: /);
});

test('a directory without test files still exits 2', (t) => {
  const root = makeRoot(t, 'empty-dir');
  const dir = path.join(root, 'suite');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'helper.mjs'), 'export const helper = 1;\n');

  const result = runRunner([dir]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Required Node test directory contains no tests: /);
});

test('a regular file that is not named like a test exits 2 with a naming message', (t) => {
  const root = makeRoot(t, 'not-a-test');
  const file = path.join(root, 'helper.mjs');
  fs.writeFileSync(file, 'export const helper = 1;\n');

  const result = runRunner([file]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Node test file is not named like a test .*: /);
  assert.doesNotMatch(result.stderr, /missing/i);
});

test('a nonexistent file path exits 2 with the missing message, not the naming message', (t) => {
  const root = makeRoot(t, 'missing-file');

  const result = runRunner([path.join(root, 'ghost.test.mjs')]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Required Node test directory or file is missing: /);
  assert.doesNotMatch(result.stderr, /not named like a test/);
});

test('a symbolic link to a test file is refused as an argument and skipped inside a directory', (t) => {
  const root = makeRoot(t, 'symlink');
  const target = path.join(root, 'real.test.mjs');
  const link = path.join(root, 'link.test.mjs');
  const marker = path.join(root, 'marker.txt');
  writePassingTest(target, 'real');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`file symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const asArgument = runRunner([link], { marker });
  assert.equal(asArgument.status, 2);
  assert.match(asArgument.stderr, /must be a regular file, not a symbolic link/);
  assert.deepEqual(markerLines(marker), []);

  // Unchanged directory behaviour: the walk only admits regular files, so the
  // link is ignored and the real file runs once.
  const asDirectory = runRunner([root], { marker });
  assert.equal(asDirectory.status, 0, asDirectory.stderr);
  assert.deepEqual(markerLines(marker), ['real']);
});

test('a directory and a separate file can be mixed in one invocation', (t) => {
  const root = makeRoot(t, 'mixed');
  const dir = path.join(root, 'suite');
  fs.mkdirSync(dir);
  const outside = path.join(root, 'outside.test.mjs');
  const marker = path.join(root, 'marker.txt');
  writePassingTest(path.join(dir, 'inside.test.mjs'), 'inside');
  writePassingTest(outside, 'outside');

  const result = runRunner([dir, outside], { marker });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(markerLines(marker).sort(), ['inside', 'outside']);
});

test('the same file passed repeatedly under different spellings runs once', (t) => {
  // realpath keeps the absolute spelling identical to what the child resolves
  // from its cwd (macOS tmpdir lives behind a /var -> /private/var link).
  const root = fs.realpathSync(makeRoot(t, 'dedupe'));
  const file = path.join(root, 'once.test.mjs');
  const marker = path.join(root, 'marker.txt');
  writePassingTest(file, 'once');

  // node --test itself only merges textually identical arguments, so a single
  // run of relative + absolute + absolute proves the runner deduplicated by
  // resolved path before spawning.
  const result = runRunner([path.basename(file), file, file], { cwd: root, marker });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(markerLines(marker), ['once']);
});

test('a file listed explicitly and again through its directory runs once', (t) => {
  const root = fs.realpathSync(makeRoot(t, 'dedupe-dir'));
  const dir = path.join(root, 'suite');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'once.test.mjs');
  const marker = path.join(root, 'marker.txt');
  writePassingTest(file, 'once');

  // Absolute file first, then its directory spelled relative to cwd: the walk
  // yields a relative path that node --test would not merge with the absolute
  // one, and the directory's own "contains no tests" check must still count
  // the file it discovered even though it is a repeat.
  const result = runRunner([file, path.basename(dir)], { cwd: root, marker });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(markerLines(marker), ['once']);
});

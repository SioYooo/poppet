// Cross-platform Node test discovery. Shell globs are intentionally avoided so
// Windows, macOS, and Linux execute the exact same test set. Each argument is a
// required test directory (walked recursively) or a single regular test file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('usage: node tools/run-node-tests.mjs <test-directory|test-file> [...]');
  process.exit(2);
}

const testName = /\.(?:test|spec)\.(?:js|mjs|cjs)$/i;
const files = [];

// A non-directory argument must be an existing regular file whose name matches
// the same pattern the directory walk uses. Symbolic links are refused with
// lstat, consistent with the walk (Dirent.isFile() is false for links) and the
// rest of the repository. Every refusal exits 2 like a missing directory.
function addTestFile(candidate) {
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      console.error(`Required Node test directory or file is missing: ${candidate}`);
    } else {
      console.error(`Required Node test path cannot be inspected (${error?.code || error?.message}): ${candidate}`);
    }
    process.exit(2);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    console.error(`Node test file must be a regular file, not a symbolic link or special file: ${candidate}`);
    process.exit(2);
  }
  if (!testName.test(path.basename(candidate))) {
    console.error(`Node test file is not named like a test (*.test.{js,mjs,cjs} or *.spec.{js,mjs,cjs}): ${candidate}`);
    process.exit(2);
  }
  files.push(candidate);
}

for (const root of roots) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    addTestFile(root);
    continue;
  }
  const before = files.length;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && testName.test(entry.name)) files.push(target);
    }
  }
  if (files.length === before) {
    console.error(`Required Node test directory contains no tests: ${root}`);
    process.exit(2);
  }
}

// The same file may arrive more than once (repeated argument, different
// spelling, or a file inside a directory that was also listed). Run it once,
// keeping the first spelling, without changing the per-directory checks above.
const unique = new Map();
for (const file of files) {
  const key = path.resolve(file);
  if (!unique.has(key)) unique.set(key, file);
}
files.splice(0, files.length, ...unique.values());

files.sort((a, b) => a.localeCompare(b, 'en'));
if (!files.length) {
  console.error(`No Node tests found under: ${roots.join(', ')}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

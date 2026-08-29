import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const collect = fileURLToPath(new URL('./collect-release-assets.mjs', import.meta.url));
const verify = fileURLToPath(new URL('./verify-release-assets.mjs', import.meta.url));

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('collects only the exact package version and verifies the release set idempotently', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = '1.2.3-alpha.4';
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ version })}\n`);
  fs.mkdirSync(path.join(root, 'dist'));

  const current = [
    `Poppet-${version}-arm64.dmg`,
    `Poppet-${version}-arm64-mac.zip`,
    `Poppet-${version}.dmg`,
    `Poppet-${version}-mac.zip`,
    `Poppet Setup ${version}.exe`,
    `Poppet ${version}.exe`,
  ];
  for (const name of current) fs.writeFileSync(path.join(root, 'dist', name), `current:${name}\n`);
  fs.writeFileSync(path.join(root, 'dist', 'Poppet-0.9.0.dmg'), 'stale\n');
  fs.writeFileSync(path.join(root, 'dist', 'Poppet 0.9.0.exe'), 'stale\n');

  for (const platform of ['macos', 'windows']) {
    const result = run(collect, [platform], root);
    assert.equal(result.status, 0, result.stderr);
  }
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const result = run(verify, ['release-assets'], root);
    assert.equal(result.status, 0, result.stderr);
  }

  const files = fs.readdirSync(path.join(root, 'release-assets')).sort();
  assert.deepEqual(files, [
    'Poppet-Windows-manifest.json',
    'Poppet-Windows-x64-installer.exe',
    'Poppet-Windows-x64-portable.exe',
    'Poppet-macOS-arm64.dmg',
    'Poppet-macOS-arm64.zip',
    'Poppet-macOS-manifest.json',
    'Poppet-macOS-x64.dmg',
    'Poppet-macOS-x64.zip',
    'SHA256SUMS',
  ]);
  const mac = JSON.parse(fs.readFileSync(path.join(root, 'release-assets', 'Poppet-macOS-manifest.json')));
  assert.ok(mac.files.every(file => file.sourceName.includes(version)));
});

test('verification rejects unexpected files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-assets-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'release-assets'));
  fs.writeFileSync(path.join(root, 'release-assets', 'unexpected.txt'), 'no\n');
  const result = run(verify, ['release-assets'], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release set mismatch/);
});

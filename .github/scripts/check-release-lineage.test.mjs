import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseRemoteTag } from './check-release-lineage.mjs';

const script = fileURLToPath(new URL('./check-release-lineage.mjs', import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('lightweight remote tag resolves its direct commit', () => {
  assert.equal(parseRemoteTag(`${A}\trefs/tags/v1.2.3-alpha.1\n`, 'v1.2.3-alpha.1'), A);
});

test('annotated remote tag resolves the peeled commit', () => {
  const output = `${A}\trefs/tags/v1.2.3-alpha.1\n${B}\trefs/tags/v1.2.3-alpha.1^{}\n`;
  assert.equal(parseRemoteTag(output, 'v1.2.3-alpha.1'), B);
});

test('missing or malformed remote tag fails closed', () => {
  assert.throws(() => parseRemoteTag('', 'v1.2.3-alpha.1'), /missing/);
  assert.throws(() => parseRemoteTag(`${A}\trefs/heads/main\n`, 'v1.2.3-alpha.1'), /unexpected/);
});

test('CLI accepts an annotated tag on origin/main and rejects an off-main tag', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(work);
  const run = (args, cwd = work, options = {}) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }).trim();
  run(['init', '-b', 'main']);
  run(['config', 'user.name', 'Poppet test']);
  run(['config', 'user.email', 'poppet-test@example.invalid']);
  fs.writeFileSync(path.join(work, 'file.txt'), 'main\n');
  run(['add', 'file.txt']);
  run(['commit', '-m', 'main']);
  const mainSha = run(['rev-parse', 'HEAD']);
  run(['tag', '-a', 'v1.2.3-alpha.1', '-m', 'alpha']);
  run(['init', '--bare', remote], root);
  run(['remote', 'add', 'origin', remote]);
  run(['push', 'origin', 'main', 'refs/tags/v1.2.3-alpha.1']);
  run(['fetch', 'origin', 'main:refs/remotes/origin/main']);

  const accepted = spawnSync(process.execPath, [
    script, '--event-sha', mainSha, '--tag', 'v1.2.3-alpha.1',
    '--main-ref', 'refs/remotes/origin/main', '--remote', 'origin',
  ], { cwd: work, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /RELEASE_LINEAGE_VERIFIED/);

  run(['switch', '--orphan', 'outside']);
  fs.writeFileSync(path.join(work, 'outside.txt'), 'outside\n');
  run(['add', 'outside.txt']);
  run(['commit', '-m', 'outside']);
  const outsideSha = run(['rev-parse', 'HEAD']);
  run(['tag', 'v1.2.3-alpha.2']);
  run(['push', 'origin', 'refs/tags/v1.2.3-alpha.2']);

  const rejected = spawnSync(process.execPath, [
    script, '--event-sha', outsideSha, '--tag', 'v1.2.3-alpha.2',
    '--main-ref', 'refs/remotes/origin/main', '--remote', 'origin',
  ], { cwd: work, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /not reachable/);
});

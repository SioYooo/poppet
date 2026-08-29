import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-release-readiness.mjs', import.meta.url));

const assetPaths = [
  'assets/characters/default/character.json',
  'assets/characters/default/icon.png',
  'assets/characters/default/parts.png',
  'assets/characters/default/pet.png',
  'assets/tray-fallback.png',
  'build/icon.icns',
  'build/icon.ico',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(t, version, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'SECURITY.md', 'SUPPORT.md',
  ]) fs.writeFileSync(path.join(root, file), 'fixture\n');

  for (const assetPath of assetPaths) {
    fs.mkdirSync(path.dirname(path.join(root, assetPath)), { recursive: true });
    fs.writeFileSync(path.join(root, assetPath), 'fixture');
  }
  if (options.addUninventoriedAsset) {
    fs.writeFileSync(
      path.join(root, 'assets/characters/default/uninventoried.png'), 'fixture',
    );
  }

  const assetRows = assetPaths.map(assetPath => `| \`${assetPath}\` | fixture |`).join('\n');
  fs.writeFileSync(path.join(root, 'ASSETS_LICENSE.md'), [
    'Status: VERIFIED',
    '',
    '| Path | Role |',
    '| --- | --- |',
    assetRows,
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, '.github'));
  fs.writeFileSync(path.join(root, '.github/release-policy.json'), JSON.stringify({
    schemaVersion: 2,
    publicRepositoryApproval: {
      status: 'VERIFIED', approvedBy: 'owner', approvedAt: '2026-08-19', evidence: 'fixture',
    },
    bundledArtwork: {
      status: 'VERIFIED',
      assets: assetPaths.map(assetPath => ({
        path: assetPath,
        sha256: sha256('fixture'),
        role: 'fixture role',
        provenance: 'fixture provenance',
        copyrightOwner: 'fixture owner',
        license: 'CC0-1.0',
        redistribution: 'VERIFIED',
        evidence: 'fixture evidence',
      })),
    },
    repositoryArtwork: {
      status: 'VERIFIED',
      assets: [],
    },
  }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'poppet',
    version,
    build: {
      files: [
        'src/**/*',
        'assets/characters/default/**/*',
        'assets/tray-fallback.png',
        'package.json',
        '!assets/source/**/*',
      ],
      mac: { icon: 'build/icon.icns' },
      win: { icon: 'build/icon.ico' },
    },
  }));
  return root;
}

function run(root, tag) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, GITHUB_REF_NAME: tag },
    encoding: 'utf8',
  });
}

// Minimal structurally-valid PNG whose chunk list contains a caBX (C2PA
// Content Credentials) chunk, as OpenAI gpt-image outputs do. CRCs are not
// validated by the readiness scanner, so zeroed CRCs keep the fixture simple.
function pngWithC2paChunk() {
  const chunk = (type, payload) => Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(payload.length); return b; })(),
    Buffer.from(type, 'latin1'),
    payload,
    Buffer.alloc(4),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('caBX', Buffer.from('jumb-c2pa-fixture', 'latin1')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a C2PA-manifest PNG recorded without generative-AI provenance blocks release', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const bytes = pngWithC2paChunk();
  fs.writeFileSync(path.join(root, 'assets/characters/default/pet.png'), bytes);

  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const record = policy.bundledArtwork.assets.find(
    asset => asset.path === 'assets/characters/default/pet.png',
  );
  record.sha256 = sha256(bytes);
  record.provenance = 'OWNER_CREATED_DERIVATIVE';
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /embeds a C2PA \(caBX\) provenance manifest but the record does not disclose generative-AI origin \(OWNER_CREATED_DERIVATIVE\)/,
  );
});

test('a C2PA-manifest PNG with disclosed generative-AI provenance passes', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const bytes = pngWithC2paChunk();
  fs.writeFileSync(path.join(root, 'assets/characters/default/pet.png'), bytes);

  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const record = policy.bundledArtwork.assets.find(
    asset => asset.path === 'assets/characters/default/pet.png',
  );
  record.sha256 = sha256(bytes);
  record.provenance = 'DERIVED_FROM_OWNER_AI_GENERATED';
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RELEASE_POLICY_VERIFIED/);
});

test('negated provenance wording does not satisfy the C2PA disclosure gate', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const bytes = pngWithC2paChunk();
  fs.writeFileSync(path.join(root, 'assets/characters/default/pet.png'), bytes);

  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const record = policy.bundledArtwork.assets.find(
    asset => asset.path === 'assets/characters/default/pet.png',
  );
  record.sha256 = sha256(bytes);
  record.provenance = 'NOT_AI_GENERATED';
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not disclose generative-AI origin \(NOT_AI_GENERATED\)/);
});

test('malformed PNG chunk structure blocks provenance scanning fail-closed', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  // 合法签名 + 声称超长的 chunk：扫描器不得把无法解析当成"干净"。
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from('IHDR', 'latin1'),
    Buffer.alloc(13),
  ]);
  fs.writeFileSync(path.join(root, 'assets/characters/default/pet.png'), bytes);

  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const record = policy.bundledArtwork.assets.find(
    asset => asset.path === 'assets/characters/default/pet.png',
  );
  record.sha256 = sha256(bytes);
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PNG chunk structure is malformed/);
});

test('exact prerelease tag and package version pass', (t) => {
  const result = run(fixture(t, '0.1.0-alpha.1'), 'v0.1.0-alpha.1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RELEASE_POLICY_VERIFIED/);
});

test('a packaged custom asset omitted from the inventory blocks release', (t) => {
  const root = fixture(t, '0.1.0-alpha.1', { addUninventoriedAsset: true });
  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /bundledArtwork\.assets: missing packaged custom asset \(assets\/characters\/default\/uninventoried\.png\)/,
  );
});

test('tampered bundled artwork bytes block release', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  fs.writeFileSync(path.join(root, assetPaths[0]), 'tampered fixture');

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bundledArtwork\.assets\[0\]\.sha256: digest mismatch/);
});

test('tampered repository artwork bytes block release', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const artworkPath = 'verified-root-art.png';
  fs.writeFileSync(path.join(root, artworkPath), 'fixture');

  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.repositoryArtwork.assets = [{
    path: artworkPath,
    sha256: sha256('fixture'),
    role: 'verified repository artwork',
    provenance: 'fixture provenance',
    copyrightOwner: 'fixture owner',
    license: 'CC0-1.0',
    redistribution: 'VERIFIED',
    evidence: 'fixture evidence',
  }];
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  fs.writeFileSync(path.join(root, artworkPath), 'tampered fixture');

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repositoryArtwork\.assets\[0\]\.sha256: digest mismatch/);
});

test('malformed artwork digest blocks release', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.bundledArtwork.assets[0].sha256 = 'not-a-sha256';
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /bundledArtwork\.assets\[0\]\.sha256: must be a lowercase 64-character SHA-256 digest/,
  );
});

test('missing inventoried artwork file blocks release', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  fs.unlinkSync(path.join(root, assetPaths[0]));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /bundledArtwork\.assets\[0\]\.path: path does not exist/,
  );
});

test('symbolic-link artwork path blocks release', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const assetPath = path.join(root, assetPaths[0]);
  const targetDirectory = path.join(root, 'symlink-target');
  fs.unlinkSync(assetPath);
  fs.mkdirSync(targetDirectory);
  fs.symlinkSync(
    targetDirectory,
    assetPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /bundledArtwork\.assets\[0\]\.path: not a regular file/,
  );
});

test('owner-created artwork still blocks when its licence scope is unconfirmed', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.bundledArtwork.assets[0].license = 'SCOPE_CONFIRMATION_REQUIRED';
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bundledArtwork\.assets\[0\]\.license: verified release evidence required/);
});

test('unverified repository-root artwork blocks public readiness', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  const artworkPath = 'unbundled-reference.PNG';
  fs.writeFileSync(path.join(root, artworkPath), 'fixture');

  const policyPath = path.join(root, '.github/release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.repositoryArtwork = {
    status: 'AUTHORIZATION_REQUIRED',
    assets: [{
      path: artworkPath,
      sha256: sha256('fixture'),
      role: 'unbundled repository artwork',
      provenance: 'UNVERIFIED',
      copyrightOwner: 'UNVERIFIED',
      license: 'UNVERIFIED',
      redistribution: 'UNVERIFIED',
      evidence: 'NOT_PROVIDED',
    }],
  };
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /repositoryArtwork: must be VERIFIED \(current: AUTHORIZATION_REQUIRED\)/,
  );
  assert.match(
    result.stderr,
    /repositoryArtwork\.assets\[0\]\.license: verified release evidence required/,
  );
});

test('repository-root artwork omitted from policy blocks public readiness', (t) => {
  const root = fixture(t, '0.1.0-alpha.1');
  fs.writeFileSync(path.join(root, 'uninventoried-root-art.png'), 'fixture');

  const result = run(root, 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /repositoryArtwork\.assets: missing repository-root artwork \(uninventoried-root-art\.png\)/,
  );
});

test('different prerelease sequence fails even when base version matches', (t) => {
  const result = run(fixture(t, '0.1.0-alpha.1'), 'v0.1.0-alpha.2');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not exactly match/);
});

test('stable or malformed package versions fail the prerelease gate', (t) => {
  const result = run(fixture(t, '0.1.0'), 'v0.1.0-alpha.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an allowed prerelease version/);
});

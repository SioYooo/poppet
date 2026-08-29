import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const platform = process.argv[2];
if (!['macos', 'windows'].includes(platform)) process.exitCode = 2;
if (process.exitCode) throw new Error('usage: collect-release-assets.mjs <macos|windows>');

const output = path.resolve('release-assets');
fs.mkdirSync(output, { recursive: true });
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json version is required');

// Match the exact current-version filenames emitted by electron-builder. This
// makes collection deterministic even when dist/ still contains an older local
// build; an old package must never be mistaken for the tagged package.
const sourceByTarget = platform === 'macos'
  ? new Map([
      ['Poppet-macOS-arm64.dmg', `Poppet-${pkg.version}-arm64.dmg`],
      ['Poppet-macOS-arm64.zip', `Poppet-${pkg.version}-arm64-mac.zip`],
      ['Poppet-macOS-x64.dmg', `Poppet-${pkg.version}.dmg`],
      ['Poppet-macOS-x64.zip', `Poppet-${pkg.version}-mac.zip`],
    ])
  : new Map([
      ['Poppet-Windows-x64-installer.exe', `Poppet Setup ${pkg.version}.exe`],
      ['Poppet-Windows-x64-portable.exe', `Poppet ${pkg.version}.exe`],
    ]);
const expected = [...sourceByTarget.keys()];
const missing = [...sourceByTarget.values()].filter(name => !fs.existsSync(path.join('dist', name)));
if (missing.length) throw new Error(`${platform} artifact mismatch; missing: ${missing.join(', ')}`);
const files = expected.map(name => {
  const sourceName = sourceByTarget.get(name);
  const bytes = fs.readFileSync(path.join('dist', sourceName));
  fs.writeFileSync(path.join(output, name), bytes);
  return {
    name, sourceName, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
});
const manifest = {
  schemaVersion: 1, platform,
  tag: process.env.GITHUB_REF_NAME ?? null,
  commit: process.env.GITHUB_SHA ?? null,
  files,
};
const manifestName = platform === 'macos'
  ? 'Poppet-macOS-manifest.json' : 'Poppet-Windows-manifest.json';
fs.writeFileSync(path.join(output, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`collected ${files.length} ${platform} artifacts`);

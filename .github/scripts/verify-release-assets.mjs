import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const directory = process.argv[2] ?? 'release-assets';
const binaries = [
  'Poppet-macOS-arm64.dmg', 'Poppet-macOS-arm64.zip',
  'Poppet-macOS-x64.dmg', 'Poppet-macOS-x64.zip',
  'Poppet-Windows-x64-installer.exe', 'Poppet-Windows-x64-portable.exe',
];
const manifests = ['Poppet-macOS-manifest.json', 'Poppet-Windows-manifest.json'];
const expected = [...binaries, ...manifests].sort();
const actual = fs.readdirSync(directory).sort();
const allowedActual = [...expected, 'SHA256SUMS'].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected) &&
    JSON.stringify(actual) !== JSON.stringify(allowedActual)) {
  throw new Error(`release set mismatch; found: ${actual.join(', ')}`);
}
const byPlatform = new Map();
for (const name of manifests) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error(`${name}: invalid schema`);
  const expectedPlatform = name.includes('macOS') ? 'macos' : 'windows';
  if (manifest.platform !== expectedPlatform) throw new Error(`${name}: platform mismatch`);
  if (process.env.GITHUB_REF_NAME && manifest.tag !== process.env.GITHUB_REF_NAME) throw new Error(`${name}: tag mismatch`);
  if (process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA) throw new Error(`${name}: commit mismatch`);
  const platformFiles = binaries.filter(file => (file.includes('macOS') ? 'macos' : 'windows') === expectedPlatform);
  if (!Array.isArray(manifest.files) || manifest.files.length !== platformFiles.length ||
      JSON.stringify(manifest.files.map(file => file.name).sort()) !== JSON.stringify(platformFiles.sort())) {
    throw new Error(`${name}: file inventory mismatch`);
  }
  for (const file of manifest.files) {
    if (!file || typeof file.sourceName !== 'string' || path.basename(file.sourceName) !== file.sourceName ||
        !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`${name}: invalid file record`);
    }
  }
  byPlatform.set(manifest.platform, manifest);
}
const macManifest = byPlatform.get('macos');
const windowsManifest = byPlatform.get('windows');
if (macManifest?.tag !== windowsManifest?.tag || macManifest?.commit !== windowsManifest?.commit) {
  throw new Error('platform manifest lineage mismatch');
}
for (const name of binaries) {
  const platform = name.includes('macOS') ? 'macos' : 'windows';
  const record = byPlatform.get(platform)?.files.find(file => file.name === name);
  const bytes = fs.readFileSync(path.join(directory, name));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!record || record.bytes !== bytes.length || record.sha256 !== sha256) {
    throw new Error(`${name}: manifest mismatch`);
  }
}
const lines = expected.map(name => {
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(directory, name))).digest('hex');
  return `${digest}  ${name}`;
});
fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
console.log(`verified ${expected.length} assets and wrote SHA256SUMS`);

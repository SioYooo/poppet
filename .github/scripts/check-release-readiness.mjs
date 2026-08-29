import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const errors = [];
const UNRESOLVED_VALUES = new Set([
  'AUTHORIZATION_REQUIRED',
  'HUMAN_AUTH_REQUIRED',
  'HUMAN_REQUIRED',
  'NOT_PROVIDED',
  'PROVENANCE_REQUIRED',
  'SCOPE_CONFIRMATION_REQUIRED',
  'UNKNOWN',
  'UNVERIFIED',
]);
const requiredFiles = [
  'LICENSE', 'ASSETS_LICENSE.md', 'THIRD_PARTY_NOTICES.md',
  'PRIVACY.md', 'SECURITY.md', 'SUPPORT.md',
];
for (const file of requiredFiles) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) errors.push(`${file}: missing`);
}

function json(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { errors.push(`${file}: ${error.message}`); return null; }
}

function verified(record, label, fields) {
  if (record?.status !== 'VERIFIED') {
    errors.push(`${label}: must be VERIFIED (current: ${record?.status ?? 'missing'})`);
    return;
  }
  for (const field of fields) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      errors.push(`${label}.${field}: evidence required`);
    }
  }
}

function normalizedRepoPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label}: must be a non-empty repository-relative path`);
    return null;
  }

  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    path.posix.isAbsolute(normalized) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.startsWith('./')
  ) {
    errors.push(`${label}: must be a normalized repository-relative path (${value})`);
    return null;
  }

  return normalized;
}

function regularFile(repoPath, label) {
  try {
    const stat = fs.lstatSync(repoPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      errors.push(`${label}: not a regular file (${repoPath})`);
      return false;
    }
    return true;
  } catch {
    errors.push(`${label}: path does not exist (${repoPath})`);
    return false;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

function verifySha256(repoPath, expectedSha256, label) {
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) {
    errors.push(`${label}.sha256: must be a lowercase 64-character SHA-256 digest`);
    return;
  }
  if (!regularFile(repoPath, `${label}.path`)) return;

  let actualSha256;
  try {
    actualSha256 = createHash('sha256').update(fs.readFileSync(repoPath)).digest('hex');
  } catch (error) {
    errors.push(`${label}.sha256: unable to read file bytes (${repoPath}): ${error.message}`);
    return;
  }
  if (actualSha256 !== expectedSha256) {
    errors.push(
      `${label}.sha256: digest mismatch (${repoPath}; expected ${expectedSha256}, actual ${actualSha256})`,
    );
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Closed set, not a substring match: a substring test would accept negations
// like NOT_AI_GENERATED. New disclosing values must be added here explicitly.
const AI_DISCLOSING_PROVENANCE = new Set([
  'OWNER_AI_GENERATED',
  'DERIVED_FROM_OWNER_AI_GENERATED',
  'GENERATED_FROM_OWNER_AI_GENERATED_ARTWORK',
]);

// Scans the WHOLE byte range (also past IEND, where a hidden manifest could
// sit) and reports malformed chunk structure instead of treating it as clean.
function pngC2paScan(repoPath) {
  let bytes;
  try {
    bytes = fs.readFileSync(repoPath);
  } catch {
    return { carries: false, malformed: false };
  }
  if (bytes.length < 20 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { carries: false, malformed: false };
  }
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return { carries: false, malformed: true };
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return { carries: false, malformed: true };
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'caBX') return { carries: true, malformed: false };
    offset += 12 + length;
  }
  return { carries: false, malformed: false };
}

// An asset whose bytes embed a signed C2PA manifest must say so in its
// provenance record. A record claiming direct human authorship over bytes that
// carry a generative-AI Content Credentials chunk is self-refuting evidence.
function checkGenerativeProvenanceDisclosure(repoPath, provenance, label) {
  if (!/\.png$/i.test(repoPath)) return;
  const scan = pngC2paScan(repoPath);
  if (scan.malformed) {
    errors.push(
      `${label}.path: PNG chunk structure is malformed; provenance scanning requires a well-formed file (${repoPath})`,
    );
    return;
  }
  if (!scan.carries) return;
  const value = typeof provenance === 'string' ? provenance.trim() : '';
  if (!AI_DISCLOSING_PROVENANCE.has(value)) {
    errors.push(
      `${label}.provenance: file embeds a C2PA (caBX) provenance manifest but the record does not disclose generative-AI origin (${value || 'missing'})`,
    );
  }
}

function filesBelow(repoDirectory, label) {
  let entries;
  try {
    entries = fs.readdirSync(repoDirectory, { withFileTypes: true });
  } catch {
    errors.push(`${label}: directory does not exist (${repoDirectory})`);
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.posix.join(repoDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${label}: symbolic links are not supported (${entryPath})`);
    } else if (entry.isDirectory()) {
      files.push(...filesBelow(entryPath, label));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function hasGlobMeta(value) {
  return ['*', '?', '[', ']', '{', '}'].some(character => value.includes(character));
}

function expandIncludedAssetPattern(pattern, label) {
  const recursiveSuffix = '/**/*';
  if (pattern.endsWith(recursiveSuffix)) {
    const repoDirectory = normalizedRepoPath(
      pattern.slice(0, -recursiveSuffix.length), label,
    );
    return repoDirectory ? filesBelow(repoDirectory, label) : [];
  }

  if (hasGlobMeta(pattern)) {
    errors.push(`${label}: unsupported custom-asset glob (${pattern})`);
    return [];
  }

  const repoPath = normalizedRepoPath(pattern, label);
  if (repoPath && regularFile(repoPath, label)) return [repoPath];
  return [];
}

function excludesAsset(exclusion, assetPath, label) {
  const recursiveSuffix = '/**/*';
  if (exclusion.endsWith(recursiveSuffix)) {
    const repoDirectory = normalizedRepoPath(
      exclusion.slice(0, -recursiveSuffix.length), label,
    );
    return repoDirectory
      ? assetPath === repoDirectory || assetPath.startsWith(`${repoDirectory}/`)
      : false;
  }

  if (hasGlobMeta(exclusion)) {
    errors.push(`${label}: unsupported custom-asset exclusion glob (${exclusion})`);
    return false;
  }

  return normalizedRepoPath(exclusion, label) === assetPath;
}

function packagedCustomAssets(pkg) {
  const files = pkg?.build?.files;
  if (!Array.isArray(files)) {
    errors.push('package.json build.files: must be an array');
    return [];
  }

  const included = new Set();
  const exclusions = [];
  for (const [index, entry] of files.entries()) {
    if (typeof entry !== 'string') {
      errors.push(`package.json build.files[${index}]: must be a string`);
      continue;
    }

    const excluded = entry.startsWith('!');
    const pattern = excluded ? entry.slice(1) : entry;
    if (!pattern.startsWith('assets/')) continue;

    if (excluded) {
      exclusions.push({ pattern, label: `package.json build.files[${index}]` });
      continue;
    }

    for (const assetPath of expandIncludedAssetPattern(
      pattern, `package.json build.files[${index}]`,
    )) included.add(assetPath);
  }

  for (const { pattern, label } of exclusions) {
    for (const assetPath of [...included]) {
      if (excludesAsset(pattern, assetPath, label)) included.delete(assetPath);
    }
  }

  for (const platform of ['mac', 'win']) {
    const label = `package.json build.${platform}.icon`;
    const repoPath = normalizedRepoPath(pkg?.build?.[platform]?.icon, label);
    if (repoPath && regularFile(repoPath, label)) included.add(repoPath);
  }

  return [...included].sort();
}

const REPOSITORY_ARTWORK_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.icns', '.ico', '.jpeg', '.jpg', '.png', '.svg',
  '.tif', '.tiff', '.webp',
]);

function repositoryRootArtwork() {
  const artwork = [];
  for (const entry of fs.readdirSync('.', { withFileTypes: true })) {
    const extension = path.extname(entry.name).toLowerCase();
    if (!REPOSITORY_ARTWORK_EXTENSIONS.has(extension)) continue;
    if (entry.isSymbolicLink()) {
      errors.push(`repositoryArtwork.assets: symbolic links are not supported (${entry.name})`);
    } else if (entry.isFile()) {
      artwork.push(entry.name);
    }
  }
  return artwork.sort();
}

function resolvedEvidence(record, field, label) {
  const value = record?.[field];
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    UNRESOLVED_VALUES.has(value.trim().toUpperCase())
  ) errors.push(`${label}.${field}: verified release evidence required`);
}

function comparePathSets(expected, actual, label, missingDescription, extraDescription) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const repoPath of expectedSet) {
    if (!actualSet.has(repoPath)) errors.push(`${label}: ${missingDescription} (${repoPath})`);
  }
  for (const repoPath of actualSet) {
    if (!expectedSet.has(repoPath)) errors.push(`${label}: ${extraDescription} (${repoPath})`);
  }
}

const policy = json('.github/release-policy.json');
if (policy?.schemaVersion !== 2) errors.push('release policy schemaVersion must be 2');
verified(policy?.publicRepositoryApproval, 'publicRepositoryApproval',
  ['approvedBy', 'approvedAt', 'evidence']);
if (policy?.bundledArtwork?.status !== 'VERIFIED') {
  errors.push(`bundledArtwork: must be VERIFIED (current: ${policy?.bundledArtwork?.status ?? 'missing'})`);
}

const pkg = json('package.json');
const packagedAssets = packagedCustomAssets(pkg);
const inventory = policy?.bundledArtwork?.assets;
if (!Array.isArray(inventory)) errors.push('bundledArtwork.assets: must be an array');

const inventoryPaths = [];
const seenInventoryPaths = new Set();
for (const [index, record] of (Array.isArray(inventory) ? inventory : []).entries()) {
  const label = `bundledArtwork.assets[${index}]`;
  const repoPath = normalizedRepoPath(record?.path, `${label}.path`);
  if (!repoPath) continue;
  if (seenInventoryPaths.has(repoPath)) {
    errors.push(`${label}.path: duplicate inventory record (${repoPath})`);
  } else {
    seenInventoryPaths.add(repoPath);
    inventoryPaths.push(repoPath);
  }

  verifySha256(repoPath, record?.sha256, label);
  checkGenerativeProvenanceDisclosure(repoPath, record?.provenance, label);
  if (typeof record?.role !== 'string' || record.role.trim() === '') {
    errors.push(`${label}.role: packaged role required`);
  }
  for (const field of ['provenance', 'copyrightOwner', 'license', 'evidence']) {
    resolvedEvidence(record, field, label);
  }
  if (record?.redistribution !== 'VERIFIED') {
    errors.push(`${label}.redistribution: must be VERIFIED`);
  }
}

comparePathSets(
  packagedAssets, inventoryPaths, 'bundledArtwork.assets',
  'missing packaged custom asset', 'non-packaged path present',
);

if (policy?.repositoryArtwork?.status !== 'VERIFIED') {
  errors.push(
    `repositoryArtwork: must be VERIFIED (current: ${policy?.repositoryArtwork?.status ?? 'missing'})`,
  );
}

const repositoryArtworkInventory = policy?.repositoryArtwork?.assets;
if (!Array.isArray(repositoryArtworkInventory)) {
  errors.push('repositoryArtwork.assets: must be an array');
}

const repositoryArtworkPaths = [];
const seenRepositoryArtworkPaths = new Set();
for (const [index, record] of (
  Array.isArray(repositoryArtworkInventory) ? repositoryArtworkInventory : []
).entries()) {
  const label = `repositoryArtwork.assets[${index}]`;
  const repoPath = normalizedRepoPath(record?.path, `${label}.path`);
  if (!repoPath) continue;
  if (repoPath.includes('/')) {
    errors.push(`${label}.path: repository-root artwork path required (${repoPath})`);
  }
  if (seenRepositoryArtworkPaths.has(repoPath)) {
    errors.push(`${label}.path: duplicate inventory record (${repoPath})`);
  } else {
    seenRepositoryArtworkPaths.add(repoPath);
    repositoryArtworkPaths.push(repoPath);
  }

  verifySha256(repoPath, record?.sha256, label);
  checkGenerativeProvenanceDisclosure(repoPath, record?.provenance, label);
  if (typeof record?.role !== 'string' || record.role.trim() === '') {
    errors.push(`${label}.role: repository role required`);
  }
  for (const field of ['provenance', 'copyrightOwner', 'license', 'evidence']) {
    resolvedEvidence(record, field, label);
  }
  if (record?.redistribution !== 'VERIFIED') {
    errors.push(`${label}.redistribution: must be VERIFIED`);
  }
}

comparePathSets(
  repositoryRootArtwork(), repositoryArtworkPaths, 'repositoryArtwork.assets',
  'missing repository-root artwork', 'non-root-artwork path present',
);

if (fs.existsSync('ASSETS_LICENSE.md')) {
  const assetsLicense = fs.readFileSync('ASSETS_LICENSE.md', 'utf8');
  const assetsDocStatus = assetsLicense.match(/^Status:\s*(\S+)\s*$/m)?.[1];
  if (assetsDocStatus !== 'VERIFIED') {
    errors.push(`ASSETS_LICENSE.md: Status must be VERIFIED (current: ${assetsDocStatus ?? 'missing'})`);
  }

  const documentedPaths = [...assetsLicense.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)]
    .map(match => match[1]);
  if (new Set(documentedPaths).size !== documentedPaths.length) {
    errors.push('ASSETS_LICENSE.md: duplicate inventory path');
  }
  comparePathSets(
    inventoryPaths, documentedPaths, 'ASSETS_LICENSE.md inventory',
    'missing policy path', 'path absent from policy',
  );
}

const tag = process.env.GITHUB_REF_NAME || process.argv.find(arg => arg.startsWith('v'));
const prereleaseVersion = /^\d+\.\d+\.\d+-(alpha|beta|rc)\.([1-9]\d*)$/;
if (pkg && !prereleaseVersion.test(pkg.version)) {
  errors.push(`package.json version ${pkg.version} is not an allowed prerelease version`);
}
if (tag) {
  const match = /^v(\d+\.\d+\.\d+-(alpha|beta|rc)\.[1-9]\d*)$/.exec(tag);
  if (!match) errors.push(`tag ${tag}: expected vX.Y.Z-alpha.N, -beta.N, or -rc.N`);
  else if (pkg && match[1] !== pkg.version) {
    errors.push(`tag version ${match[1]} does not exactly match package.json ${pkg.version}`);
  }
}

if (errors.length) {
  console.error('RELEASE_BLOCKED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('RELEASE_POLICY_VERIFIED');

// The public surface hardcodes the GitHub owner/repo slug in badges, clone
// commands, advisory URLs, and issue-template contact links. The clean-history
// publication route creates a NEW repository, so those strings are a rename
// away from pointing at a repository the reader cannot reach. This suite makes
// `package.json` `repository.url` the single declared slug and fails the build
// if any public-surface file disagrees, so a rename is one field plus whatever
// this test then lists — never a silent dead badge.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[/#?])/;
const ANY_REPO_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[/#?"'`\s)\],])/g;

// Files allowed to name a repository that is not Poppet's, and the exact
// upstream slugs each may name. Anything else is drift.
const FOREIGN_SLUGS = new Map([
  ['THIRD_PARTY_NOTICES.md', new Set(['electron/electron', 'nodejs/node'])],
]);

// Public-surface files that must keep carrying the slug; emptying one of them
// would otherwise make this suite pass vacuously.
const MUST_REFERENCE_SLUG = [
  'README.md',
  'SECURITY.md',
  '.github/ISSUE_TEMPLATE/config.yml',
];

function declaredSlug() {
  const url = pkg.repository?.url;
  assert.equal(typeof url, 'string', 'package.json must declare repository.url');
  const match = REPO_URL.exec(url);
  assert.ok(match, `package.json repository.url must be a github.com repository URL (${url})`);
  return `${match[1]}/${match[2]}`;
}

function scannedFiles() {
  // The public surface is the tracked file set, not whatever happens to sit in
  // a developer checkout: local-only files (see .gitignore) must not be judged
  // or be able to mask drift. Inside a checkout git ls-files is authoritative.
  // A git-archive export of the tracked set has no .git yet (it becomes a
  // repository only when the public repo is seeded), so there the equivalent
  // on-disk walk over the same roots is exact.
  const listing = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  if (listing.status !== 0) return walkedFiles();
  const files = [];
  for (const entry of listing.stdout.split('\0')) {
    if (!entry) continue;
    const relative = entry.split(path.sep).join('/');
    if (relative.includes('/') && !relative.startsWith('.github/') && !relative.startsWith('docs/')) continue;
    if (!/\.(?:md|ya?ml)$/i.test(relative)) continue;
    files.push(relative);
  }
  return files.sort();
}

function walkedFiles() {
  const files = [];
  const roots = ['.', '.github', 'docs'];
  const pending = roots.map((relative) => path.join(repoRoot, relative));
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const relative = path.relative(repoRoot, target).split(path.sep).join('/');
      if (entry.isDirectory()) {
        // Only descend the documentation and repository-metadata trees; build
        // output, dependencies, and test fixtures are not public surface.
        if (relative === '.github' || relative === 'docs' || relative.startsWith('.github/') || relative.startsWith('docs/')) {
          pending.push(target);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(?:md|ya?ml)$/i.test(entry.name)) continue;
      if (relative.includes('/') && !relative.startsWith('.github/') && !relative.startsWith('docs/')) continue;
      files.push(relative);
    }
  }
  return files.sort();
}

test('package.json declares exactly one public repository slug', () => {
  const slug = declaredSlug();
  assert.match(slug, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.equal(pkg.repository.type, 'git');
});

test('every public-surface GitHub URL uses the declared slug', () => {
  const slug = declaredSlug();
  const offenders = [];
  for (const relative of scannedFiles()) {
    const contents = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const allowed = FOREIGN_SLUGS.get(relative) ?? new Set();
    for (const match of contents.matchAll(ANY_REPO_URL)) {
      const found = `${match[1]}/${match[2]}`;
      if (found === slug || allowed.has(found)) continue;
      const line = contents.slice(0, match.index).split('\n').length;
      offenders.push(`${relative}:${line} -> ${found}`);
    }
  }
  assert.deepEqual(offenders, [], `public-surface GitHub URLs must use ${slug}`);
});

test('the files that carry the slug still carry it', () => {
  const slug = declaredSlug();
  for (const relative of MUST_REFERENCE_SLUG) {
    const contents = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.ok(
      contents.includes(`https://github.com/${slug}`),
      `${relative} must reference https://github.com/${slug}`,
    );
  }
});

test('slug-relative links point at files that exist', () => {
  const slug = declaredSlug();
  const targets = new Map([
    [`https://github.com/${slug}/actions/workflows/ci.yml`, '.github/workflows/ci.yml'],
    [`https://github.com/${slug}/blob/main/SUPPORT.md`, 'SUPPORT.md'],
  ]);
  const surface = scannedFiles()
    .map((relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8'))
    .join('\n');
  for (const [url, target] of targets) {
    if (!surface.includes(url)) continue;
    assert.ok(fs.existsSync(path.join(repoRoot, target)), `${url} points at missing ${target}`);
  }
});

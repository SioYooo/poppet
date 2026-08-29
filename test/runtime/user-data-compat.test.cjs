'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const {
  MIGRATION_MARKER,
  MIGRATION_MARKER_NAME,
  configureUserDataCompatibility,
} = require('../../src/main/user-data-compat');

function fixture(t, { lockResult = true } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-user-data-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: false }));
  const current = path.join(parent, 'Poppet');
  const legacy = path.join(parent, 'KTT');
  const calls = [];
  let userData = current;
  let appName = 'Poppet';
  const app = {
    getPath: name => {
      assert.equal(name, 'userData');
      return userData;
    },
    setPath: (name, value) => {
      assert.equal(name, 'userData');
      calls.push(['setPath', value]);
      userData = value;
    },
    setName: value => {
      calls.push(['setName', value]);
      appName = value;
    },
    requestSingleInstanceLock: () => {
      calls.push(['requestLock', appName, userData]);
      return lockResult;
    },
    releaseSingleInstanceLock: () => calls.push(['releaseLock', appName, userData]),
  };
  return {
    parent,
    current,
    legacy,
    calls,
    app,
    appState: () => ({ userData, appName }),
  };
}

function noDirectoryFsync() {}

function fsWith(overrides) {
  return new Proxy(fs, {
    get(target, key) {
      return Object.hasOwn(overrides, key) ? overrides[key] : target[key];
    },
  });
}

test('legacy data is copied under its old lock and atomically published as the Poppet profile', (t) => {
  const { current, legacy, calls, app, appState } = fixture(t);
  fs.mkdirSync(path.join(legacy, 'characters', 'saved'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"pets":[{"characterId":"saved"}]}');
  fs.writeFileSync(path.join(legacy, 'characters', 'saved', 'pet.png'), 'pet-bytes');
  fs.writeFileSync(path.join(legacy, 'Local State'), 'chromium-state');
  const transientSingletonFiles = [
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
    'lockfile',
  ];
  for (const name of transientSingletonFiles) {
    fs.writeFileSync(path.join(legacy, name), 'ephemeral');
  }

  const result = configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync });

  assert.deepEqual(result, { status: 'LEGACY_PROFILE_MIGRATED', userData: current });
  assert.deepEqual(appState(), { userData: current, appName: 'Poppet' });
  assert.equal(fs.readFileSync(path.join(current, 'settings.json'), 'utf8'),
    '{"pets":[{"characterId":"saved"}]}');
  assert.equal(fs.readFileSync(path.join(current, 'characters', 'saved', 'pet.png'), 'utf8'), 'pet-bytes');
  assert.equal(fs.readFileSync(path.join(current, 'Local State'), 'utf8'), 'chromium-state');
  for (const name of transientSingletonFiles) {
    assert.equal(fs.existsSync(path.join(current, name)), false);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current, MIGRATION_MARKER_NAME), 'utf8')),
    MIGRATION_MARKER);
  assert.equal(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8'),
    '{"pets":[{"characterId":"saved"}]}');
  assert.deepEqual(calls, [
    ['setName', 'KTT'],
    ['setPath', legacy],
    ['requestLock', 'KTT', legacy],
    ['setName', 'Poppet'],
    ['setPath', current],
    ['releaseLock', 'Poppet', current],
  ]);

  calls.length = 0;
  assert.deepEqual(configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
    { status: 'MIGRATED_PROFILE', userData: current });
  assert.deepEqual(calls, []);
});

test('a busy legacy profile is left untouched and prevents a fresh Poppet profile from starting', (t) => {
  const { current, legacy, calls, app, appState } = fixture(t, { lockResult: false });
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'settings.json'), 'saved');

  assert.deepEqual(configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
    { status: 'LEGACY_PROFILE_BUSY', userData: current });
  assert.deepEqual(appState(), { userData: current, appName: 'Poppet' });
  assert.equal(fs.existsSync(current), false);
  assert.equal(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8'), 'saved');
  assert.deepEqual(calls, [
    ['setName', 'KTT'],
    ['setPath', legacy],
    ['requestLock', 'KTT', legacy],
    ['setName', 'Poppet'],
    ['setPath', current],
  ]);
});

test('a current profile or a fresh install keeps the Poppet path', (t) => {
  {
    const { current, calls, app } = fixture(t);
    fs.mkdirSync(current);
    assert.deepEqual(configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
      { status: 'CURRENT_PROFILE', userData: current });
    assert.deepEqual(calls, []);
  }
  {
    const { current, calls, app } = fixture(t);
    assert.deepEqual(configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
      { status: 'FRESH_PROFILE', userData: current });
    assert.deepEqual(calls, []);
  }
});

// Electron creates the user-data directory before the main script is loaded, so
// every real start reaches the guard with the Poppet directory already present.
// The suite previously only ever built the state where it was absent, which no
// running Electron can produce, and that is how an unreachable migration branch
// stayed green: with a legacy directory beside it, the guard always failed
// closed and `migrateWithLegacyLock` could never run.
test('a pre-created Poppet directory does not block the legacy migration', (t) => {
  {
    const { current, legacy, app } = fixture(t);
    fs.mkdirSync(current);
    fs.mkdirSync(path.join(legacy, 'characters', 'saved'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'characters', 'saved', 'pet.json'), '{"id":"saved"}');
    fs.writeFileSync(path.join(legacy, 'settings.json'), '{"activeId":"saved"}');
    assert.deepEqual(configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
      { status: 'LEGACY_PROFILE_MIGRATED', userData: current });
    assert.equal(fs.readFileSync(path.join(current, 'characters', 'saved', 'pet.json'), 'utf8'),
      '{"id":"saved"}');
    assert.equal(fs.readFileSync(path.join(current, 'settings.json'), 'utf8'),
      '{"activeId":"saved"}');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(current, MIGRATION_MARKER_NAME), 'utf8')),
      MIGRATION_MARKER,
    );
  }
  {
    // Chromium writes its own bookkeeping into that directory even when a
    // previous start failed. It is not profile data and must not be carried
    // into the published profile.
    const { parent, current, legacy, app } = fixture(t);
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, 'Local State'), '{"uninstall_metrics":{}}');
    fs.mkdirSync(path.join(current, 'GPUCache'));
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'settings.json'), '{"activeId":"kept"}');
    assert.deepEqual(configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
      { status: 'LEGACY_PROFILE_MIGRATED', userData: current });
    assert.equal(fs.readFileSync(path.join(current, 'settings.json'), 'utf8'), '{"activeId":"kept"}');
    assert.equal(fs.existsSync(path.join(current, 'Local State')), false);
    assert.equal(fs.existsSync(path.join(current, 'GPUCache')), false);
    assert.deepEqual(fs.readdirSync(parent).sort(), ['KTT', 'Poppet']);
  }
});

test('a failed publish restores the pre-created directory and leaves legacy data alone', (t) => {
  const { parent, current, legacy, app } = fixture(t);
  fs.mkdirSync(current);
  fs.writeFileSync(path.join(current, 'Local State'), '{"uninstall_metrics":{}}');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"activeId":"kept"}');
  const fsImpl = fsWith({
    renameSync(from, to) {
      if (to === current && path.basename(from).startsWith('.poppet-user-data-migration-')
          && !path.basename(from).includes('displaced-')) {
        throw Object.assign(new Error('publish failed'), { code: 'EIO' });
      }
      return fs.renameSync(from, to);
    },
  });
  assert.throws(
    () => configureUserDataCompatibility({ app, fsImpl, syncDirectory: noDirectoryFsync }),
    error => error?.code === 'POPPET_USER_DATA_MIGRATION_FAILED',
  );
  assert.equal(fs.readFileSync(path.join(current, 'Local State'), 'utf8'), '{"uninstall_metrics":{}}');
  assert.equal(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8'), '{"activeId":"kept"}');
  assert.deepEqual(fs.readdirSync(parent).sort(), ['KTT', 'Poppet']);
});

test('unmarked dual profiles and unsafe roots fail closed', (t) => {
  for (const seed of [
    (dir) => fs.writeFileSync(path.join(dir, 'settings.json'), '{}'),
    (dir) => fs.mkdirSync(path.join(dir, 'characters')),
    (dir) => fs.writeFileSync(path.join(dir, 'settings.json.bak'), '{}'),
  ]) {
    const { current, legacy, app } = fixture(t);
    fs.mkdirSync(current);
    seed(current);
    fs.mkdirSync(legacy);
    assert.throws(
      () => configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
      error => error?.code === 'POPPET_USER_DATA_CONFLICT',
    );
  }
  {
    const { legacy, app } = fixture(t);
    fs.writeFileSync(legacy, 'not a directory');
    assert.throws(
      () => configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
      error => error?.code === 'POPPET_USER_DATA_UNSAFE',
    );
  }
  {
    const { current, legacy, app } = fixture(t);
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fsImpl = fsWith({
      lstatSync(candidate) {
        if (candidate === current) throw missing;
        assert.equal(candidate, legacy);
        return { isSymbolicLink: () => true, isDirectory: () => true };
      },
    });
    assert.throws(
      () => configureUserDataCompatibility({ app, fsImpl, syncDirectory: noDirectoryFsync }),
      error => error?.code === 'POPPET_USER_DATA_UNSAFE',
    );
  }
});

test('a non-Singleton symlink inside the legacy profile aborts migration and releases the old lock', (t) => {
  const { current, legacy, calls, app, appState } = fixture(t);
  fs.mkdirSync(legacy);
  const linked = path.join(legacy, 'linked-user-data');
  fs.writeFileSync(linked, 'placeholder');
  const fsImpl = fsWith({
    lstatSync(candidate) {
      if (candidate === linked) {
        return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
      }
      return fs.lstatSync(candidate);
    },
  });

  assert.throws(
    () => configureUserDataCompatibility({ app, fsImpl, syncDirectory: noDirectoryFsync }),
    error => error?.code === 'POPPET_USER_DATA_UNSAFE',
  );
  assert.equal(fs.existsSync(current), false);
  assert.equal(fs.readFileSync(linked, 'utf8'), 'placeholder');
  assert.deepEqual(appState(), { userData: current, appName: 'Poppet' });
  assert.deepEqual(calls.slice(-3), [
    ['setName', 'Poppet'],
    ['setPath', current],
    ['releaseLock', 'Poppet', current],
  ]);
  assert.equal(fs.readdirSync(path.dirname(current)).some(name =>
    name.startsWith('.poppet-user-data-migration-')), false);
});

test('copy or publish failure preserves legacy data, removes only the owned stage, and releases the lock', (t) => {
  const { current, legacy, calls, app } = fixture(t);
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'settings.json'), 'saved');
  const fsImpl = fsWith({
    renameSync() {
      const error = new Error('simulated publish failure');
      error.code = 'EACCES';
      throw error;
    },
  });

  assert.throws(
    () => configureUserDataCompatibility({ app, fsImpl, syncDirectory: noDirectoryFsync }),
    error => error?.code === 'POPPET_USER_DATA_MIGRATION_FAILED',
  );
  assert.equal(fs.existsSync(current), false);
  assert.equal(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8'), 'saved');
  assert.equal(fs.readdirSync(path.dirname(current)).some(name =>
    name.startsWith('.poppet-user-data-migration-')), false);
  assert.equal(calls.some(call => call[0] === 'releaseLock'), true);
});

test('a post-publish durability failure remains recoverable through the completed marker', (t) => {
  const { current, legacy, app } = fixture(t);
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'settings.json'), 'saved');
  const parent = path.dirname(current);
  const syncDirectory = candidate => {
    if (candidate === parent) throw new Error('simulated parent fsync failure');
  };

  assert.throws(
    () => configureUserDataCompatibility({ app, syncDirectory }),
    error => error?.code === 'POPPET_USER_DATA_MIGRATION_DURABILITY_UNCONFIRMED',
  );
  assert.equal(fs.readFileSync(path.join(current, 'settings.json'), 'utf8'), 'saved');
  assert.deepEqual(configureUserDataCompatibility({ app, syncDirectory: noDirectoryFsync }),
    { status: 'MIGRATED_PROFILE', userData: current });
});

test('profile migration resolves before the Poppet lock and busy legacy state short-circuits startup', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  const configure = source.indexOf('configureUserDataCompatibility({ app });');
  const lock = source.indexOf('app.requestSingleInstanceLock()');
  assert.ok(configure > 0 && configure < lock);
  assert.match(source,
    /userDataReady = profile\.status !== 'LEGACY_PROFILE_BUSY';[\s\S]*?if \(!userDataReady \|\| !app\.requestSingleInstanceLock\(\)\)/);
  assert.match(source,
    /if \(DEV_SMOKE\)[\s\S]*?configureSmokeUserData\(\);[\s\S]*?\} else \{[\s\S]*?configureUserDataCompatibility\(\{ app \}\);/);
});

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fsyncDirSync } = require('./storage');

const CURRENT_PRODUCT_NAME = 'Poppet';
// Compatibility-only identifier. Existing releases used this directory and,
// on Windows, this application name in Electron's process-singleton identity.
const LEGACY_PRODUCT_NAME = 'KTT';
const MIGRATION_MARKER_NAME = '.poppet-user-data-migration.json';
const MIGRATION_STAGE_PREFIX = '.poppet-user-data-migration-';
const MIGRATION_MARKER = Object.freeze({
  schemaVersion: 1,
  sourceProductName: LEGACY_PRODUCT_NAME,
  targetProductName: CURRENT_PRODUCT_NAME,
  strategy: 'copy-then-atomic-publish',
});
const LEGACY_SINGLETON_NAMES = new Set([
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  // Chromium's Windows ProcessSingleton uses this root-level transient file.
  'lockfile',
]);
const COPY_BUFFER_BYTES = 1024 * 1024;

// Poppet's own state inside the user-data directory: the character library and
// the settings file (library.js:29,33), that file's `.bak` and the transient
// `.settings.json.<pid>.<uuid>.tmp` sibling the atomic writer creates
// (storage.js:37), and the migration marker.
//
// Electron creates the user-data directory before this module is even loaded,
// and Chromium writes its own bookkeeping there even when startup then fails,
// so the directory existing can never mean "a Poppet profile is already here".
// Only one of these entries can. The prefix test deliberately over-matches:
// an unexpected `settings.json`-like name is treated as profile data and fails
// closed, which is the safe direction.
function isPoppetProfileEntry(name) {
  return name === 'characters'
    || name === MIGRATION_MARKER_NAME
    || /^\.?settings\.json/.test(name);
}

function holdsPoppetProfile(fsImpl, current) {
  return fsImpl.readdirSync(current).some(isPoppetProfileEntry);
}

function compatibilityError(code, message, cause) {
  const error = Object.assign(new Error(message), { code });
  if (cause !== undefined) error.cause = cause;
  return error;
}

function optionalOwnedDirectory(fsImpl, candidate, label) {
  let stat;
  try {
    stat = fsImpl.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw compatibilityError(
      'POPPET_USER_DATA_UNSAFE',
      `${label}必须是普通目录，Poppet 不会跟随链接或覆盖文件`,
    );
  }
  return stat;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertStableDirectory(fsImpl, candidate, expected, expectedNames, label) {
  const after = fsImpl.lstatSync(candidate);
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(expected, after)) {
    throw compatibilityError(
      'POPPET_USER_DATA_CHANGED_DURING_MIGRATION',
      `${label}在迁移期间被替换，Poppet 已停止启动`,
    );
  }
  const afterNames = fsImpl.readdirSync(candidate).sort();
  if (afterNames.length !== expectedNames.length
      || afterNames.some((name, index) => name !== expectedNames[index])) {
    throw compatibilityError(
      'POPPET_USER_DATA_CHANGED_DURING_MIGRATION',
      `${label}在迁移期间发生变化，Poppet 已停止启动`,
    );
  }
}

function copyStableRegularFile(fsImpl, source, destination, sourceStat) {
  if (!Number.isSafeInteger(sourceStat.size) || sourceStat.size < 0) {
    throw compatibilityError('POPPET_USER_DATA_UNSAFE', '旧版用户数据包含无法安全复制的文件');
  }

  const readFlags = fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0);
  const writeFlags = fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | fsImpl.constants.O_WRONLY;
  let sourceFd;
  let destinationFd;
  let destinationCreated = false;
  try {
    sourceFd = fsImpl.openSync(source, readFlags);
    const opened = fsImpl.fstatSync(sourceFd);
    if (!opened.isFile() || !sameFileSnapshot(sourceStat, opened)) {
      throw compatibilityError(
        'POPPET_USER_DATA_CHANGED_DURING_MIGRATION',
        '旧版用户数据文件在迁移期间被替换，Poppet 已停止启动',
      );
    }

    destinationFd = fsImpl.openSync(destination, writeFlags, sourceStat.mode & 0o777);
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(COPY_BUFFER_BYTES, opened.size)));
    let remaining = opened.size;
    while (remaining > 0) {
      const count = fsImpl.readSync(sourceFd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (count < 1) {
        throw compatibilityError(
          'POPPET_USER_DATA_CHANGED_DURING_MIGRATION',
          '旧版用户数据文件在迁移期间被截断，Poppet 已停止启动',
        );
      }
      let written = 0;
      while (written < count) {
        const writeCount = fsImpl.writeSync(destinationFd, buffer, written, count - written);
        if (writeCount < 1) {
          throw compatibilityError(
            'POPPET_USER_DATA_MIGRATION_FAILED',
            '无法完整写入 Poppet 用户数据迁移文件',
          );
        }
        written += writeCount;
      }
      remaining -= count;
    }
    if (fsImpl.readSync(sourceFd, buffer, 0, 1, null) !== 0) {
      throw compatibilityError(
        'POPPET_USER_DATA_CHANGED_DURING_MIGRATION',
        '旧版用户数据文件在迁移期间增长，Poppet 已停止启动',
      );
    }

    const openedAfter = fsImpl.fstatSync(sourceFd);
    const pathAfter = fsImpl.lstatSync(source);
    if (!openedAfter.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile()
        || !sameFileSnapshot(opened, openedAfter) || !sameFileSnapshot(opened, pathAfter)) {
      throw compatibilityError(
        'POPPET_USER_DATA_CHANGED_DURING_MIGRATION',
        '旧版用户数据文件在迁移期间发生变化，Poppet 已停止启动',
      );
    }
    fsImpl.fsyncSync(destinationFd);
  } catch (error) {
    if (destinationFd !== undefined) {
      try { fsImpl.closeSync(destinationFd); } catch {}
      destinationFd = undefined;
    }
    if (destinationCreated) {
      try {
        const stat = fsImpl.lstatSync(destination);
        if (stat.isFile() && !stat.isSymbolicLink()) fsImpl.unlinkSync(destination);
      } catch {}
    }
    throw error;
  } finally {
    if (destinationFd !== undefined) fsImpl.closeSync(destinationFd);
    if (sourceFd !== undefined) fsImpl.closeSync(sourceFd);
  }
}

function copyStableDirectory(fsImpl, pathImpl, source, destination, syncDirectory, { root = false } = {}) {
  const sourceStat = fsImpl.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw compatibilityError('POPPET_USER_DATA_UNSAFE', '旧版用户数据包含不安全的目录');
  }
  const names = fsImpl.readdirSync(source).sort();

  for (const name of names) {
    if (root && (LEGACY_SINGLETON_NAMES.has(name) || name === MIGRATION_MARKER_NAME)) continue;
    const from = pathImpl.join(source, name);
    const to = pathImpl.join(destination, name);
    const stat = fsImpl.lstatSync(from);
    if (stat.isSymbolicLink()) {
      throw compatibilityError(
        'POPPET_USER_DATA_UNSAFE',
        '旧版用户数据包含非 Chromium 单实例文件的链接，Poppet 不会跟随链接',
      );
    }
    if (stat.isDirectory()) {
      fsImpl.mkdirSync(to, { mode: 0o700 });
      copyStableDirectory(fsImpl, pathImpl, from, to, syncDirectory);
      fsImpl.chmodSync(to, stat.mode & 0o777);
    } else if (stat.isFile()) {
      copyStableRegularFile(fsImpl, from, to, stat);
    } else {
      throw compatibilityError(
        'POPPET_USER_DATA_UNSAFE',
        '旧版用户数据包含无法安全迁移的特殊文件',
      );
    }
  }

  assertStableDirectory(fsImpl, source, sourceStat, names, '旧版用户数据目录');
  syncDirectory(destination);
}

function writeMigrationMarker(fsImpl, pathImpl, stage) {
  const marker = pathImpl.join(stage, MIGRATION_MARKER_NAME);
  const bytes = Buffer.from(`${JSON.stringify(MIGRATION_MARKER, null, 2)}\n`, 'utf8');
  const flags = fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | fsImpl.constants.O_WRONLY;
  const fd = fsImpl.openSync(marker, flags, 0o600);
  try {
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function readStableMarker(fsImpl, marker, expected) {
  const flags = fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fsImpl.openSync(marker, flags);
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(expected, opened) || opened.size !== expected.size) {
      throw compatibilityError('POPPET_USER_DATA_UNSAFE', 'Poppet 用户数据迁移标记被替换');
    }
    const bytes = fsImpl.readFileSync(fd);
    const openedAfter = fsImpl.fstatSync(fd);
    const pathAfter = fsImpl.lstatSync(marker);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile()
        || !sameIdentity(opened, openedAfter) || !sameIdentity(opened, pathAfter)
        || openedAfter.size !== opened.size || pathAfter.size !== opened.size
        || bytes.length !== opened.size) {
      throw compatibilityError('POPPET_USER_DATA_UNSAFE', 'Poppet 用户数据迁移标记发生变化');
    }
    return bytes;
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

function hasCompletedMigrationMarker(fsImpl, pathImpl, current) {
  const marker = pathImpl.join(current, MIGRATION_MARKER_NAME);
  let stat;
  try {
    stat = fsImpl.lstatSync(marker);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 4096) {
    throw compatibilityError('POPPET_USER_DATA_UNSAFE', 'Poppet 用户数据迁移标记不安全');
  }
  let value;
  try {
    value = JSON.parse(readStableMarker(fsImpl, marker, stat).toString('utf8'));
  } catch {
    return false;
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(MIGRATION_MARKER).every(key => value[key] === MIGRATION_MARKER[key])
    && Object.keys(value).length === Object.keys(MIGRATION_MARKER).length;
}

function removeOwnedStage(fsImpl, pathImpl, parent, stage) {
  const resolvedParent = pathImpl.resolve(parent);
  const resolvedStage = pathImpl.resolve(stage);
  if (pathImpl.dirname(resolvedStage) !== resolvedParent
      || !pathImpl.basename(resolvedStage).startsWith(MIGRATION_STAGE_PREFIX)) return;
  try {
    const stat = fsImpl.lstatSync(resolvedStage);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fsImpl.rmSync(resolvedStage, { recursive: true, force: false });
    }
  } catch {}
}

// rename(2) publishes atomically only onto a free path, and Windows rejects an
// existing destination outright, so Electron's pre-created directory has to move
// out of the way before the staged profile can take its place. The target name
// is composed rather than created: mkdtemp would make the destination exist and
// break the rename on Windows. The `MIGRATION_STAGE_PREFIX` keeps it inside
// removeOwnedStage's ownership check.
function displaceCurrentDirectory(fsImpl, pathImpl, parent, current) {
  if (!optionalOwnedDirectory(fsImpl, current, 'Poppet 用户数据目录')) return null;
  const target = pathImpl.join(parent, `${MIGRATION_STAGE_PREFIX}displaced-${crypto.randomUUID()}`);
  fsImpl.renameSync(current, target);
  return target;
}

// Nothing is deleted before the publish succeeds: on any failure the pre-created
// directory goes back exactly where it was and the legacy profile stays the only
// authoritative copy.
function restoreDisplacedDirectory(fsImpl, pathImpl, parent, displaced, current) {
  if (!displaced) return;
  const resolved = pathImpl.resolve(displaced);
  if (pathImpl.dirname(resolved) !== pathImpl.resolve(parent)
      || !pathImpl.basename(resolved).startsWith(MIGRATION_STAGE_PREFIX)) return;
  try {
    if (optionalOwnedDirectory(fsImpl, current, 'Poppet 用户数据目录')) return;
    fsImpl.renameSync(resolved, current);
  } catch {}
}

function publishLegacyProfile({ fsImpl, pathImpl, legacy, current, syncDirectory }) {
  const parent = pathImpl.dirname(current);
  const stage = fsImpl.mkdtempSync(pathImpl.join(parent, MIGRATION_STAGE_PREFIX));
  let published = false;
  let displaced = null;
  try {
    copyStableDirectory(fsImpl, pathImpl, legacy, stage, syncDirectory, { root: true });
    writeMigrationMarker(fsImpl, pathImpl, stage);
    syncDirectory(stage);
    // Re-checked here, inside the legacy single-instance lock, so nothing can
    // turn the destination into a real profile between the branch in
    // configureUserDataCompatibility and this publish.
    if (optionalOwnedDirectory(fsImpl, current, 'Poppet 用户数据目录')
        && holdsPoppetProfile(fsImpl, current)) {
      throw compatibilityError(
        'POPPET_USER_DATA_CONFLICT',
        '迁移期间出现了含有资料的 Poppet 用户数据目录；为避免覆盖，启动已停止',
      );
    }
    displaced = displaceCurrentDirectory(fsImpl, pathImpl, parent, current);
    fsImpl.renameSync(stage, current);
    published = true;
    try {
      syncDirectory(parent);
    } catch (cause) {
      throw compatibilityError(
        'POPPET_USER_DATA_MIGRATION_DURABILITY_UNCONFIRMED',
        '用户数据已迁移到 Poppet，但无法确认目录持久化；请重新启动检查',
        cause,
      );
    }
    // The displaced directory held only Chromium bookkeeping, so it is dropped
    // once the new profile is durable. A durability failure above deliberately
    // leaves it: during an unconfirmed state an orphan stage directory is safer
    // than a deletion, and Chromium recreates whatever it needs on next start.
    if (displaced) removeOwnedStage(fsImpl, pathImpl, parent, displaced);
    return { status: 'LEGACY_PROFILE_MIGRATED', userData: current };
  } catch (error) {
    if (!published) {
      removeOwnedStage(fsImpl, pathImpl, parent, stage);
      restoreDisplacedDirectory(fsImpl, pathImpl, parent, displaced, current);
    }
    if (String(error?.code || '').startsWith('POPPET_')) throw error;
    throw compatibilityError(
      'POPPET_USER_DATA_MIGRATION_FAILED',
      '旧版用户数据无法安全迁移到 Poppet；旧数据保持不变',
      error,
    );
  }
}

function migrateWithLegacyLock({ app, fsImpl, pathImpl, legacy, current, syncDirectory }) {
  let legacyLockHeld = false;
  try {
    // Windows includes Browser::GetName() in Electron's singleton identity, so
    // the former name is as important as the former path when fencing old KTT.
    app.setName(LEGACY_PRODUCT_NAME);
    app.setPath('userData', legacy);
    if (!app.requestSingleInstanceLock()) {
      return { status: 'LEGACY_PROFILE_BUSY', userData: current };
    }
    legacyLockHeld = true;
    return publishLegacyProfile({ fsImpl, pathImpl, legacy, current, syncDirectory });
  } finally {
    // Restore the complete Poppet identity before releasing the legacy lock. The
    // caller immediately acquires Poppet's ordinary single-instance lock.
    let cleanupError = null;
    try { app.setName(CURRENT_PRODUCT_NAME); } catch (error) { cleanupError = error; }
    try { app.setPath('userData', current); } catch (error) { cleanupError ||= error; }
    if (legacyLockHeld) {
      try { app.releaseSingleInstanceLock(); } catch (error) { cleanupError ||= error; }
    }
    if (cleanupError) {
      throw compatibilityError(
        'POPPET_USER_DATA_IDENTITY_RESTORE_FAILED',
        '迁移后无法恢复完整的 Poppet 进程身份，启动已停止',
        cleanupError,
      );
    }
  }
}

function configureUserDataCompatibility({
  app,
  fsImpl = fs,
  pathImpl = path,
  syncDirectory = fsyncDirSync,
}) {
  const current = pathImpl.resolve(app.getPath('userData'));
  if (pathImpl.basename(current).toLowerCase() !== CURRENT_PRODUCT_NAME.toLowerCase()) {
    return { status: 'NONSTANDARD_PATH', userData: current };
  }

  const legacy = pathImpl.join(pathImpl.dirname(current), LEGACY_PRODUCT_NAME);
  const currentDirectory = optionalOwnedDirectory(fsImpl, current, 'Poppet 用户数据目录');
  const legacyDirectory = optionalOwnedDirectory(fsImpl, legacy, '旧版用户数据目录');

  if (currentDirectory && legacyDirectory) {
    if (hasCompletedMigrationMarker(fsImpl, pathImpl, current)) {
      return { status: 'MIGRATED_PROFILE', userData: current };
    }
    // Electron pre-creates this directory, so its existence alone is not a
    // profile. Only real Poppet state makes this an unmarked dual profile that
    // must fail closed; otherwise it holds nothing but Chromium bookkeeping and
    // the legacy migration below is still the correct action.
    if (holdsPoppetProfile(fsImpl, current)) {
      throw compatibilityError(
        'POPPET_USER_DATA_CONFLICT',
        'Poppet 与旧版用户数据目录都含有资料，但没有可信迁移标记；'
        + '请先备份并移走其中一个目录，再重新启动',
      );
    }
  }
  if (legacyDirectory) {
    return migrateWithLegacyLock({ app, fsImpl, pathImpl, legacy, current, syncDirectory });
  }
  return { status: currentDirectory ? 'CURRENT_PROFILE' : 'FRESH_PROFILE', userData: current };
}

module.exports = {
  CURRENT_PRODUCT_NAME,
  LEGACY_PRODUCT_NAME,
  MIGRATION_MARKER,
  MIGRATION_MARKER_NAME,
  configureUserDataCompatibility,
};

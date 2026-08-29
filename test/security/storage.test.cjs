'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const storage = require('../../src/main/storage');

test('JSON writes are atomic, keep last-good backup and recover corruption', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');

  storage.atomicWriteJsonSync(file, { version: 1 });
  storage.atomicWriteJsonSync(file, { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { version: 1 });

  fs.writeFileSync(file, '{broken');
  const diagnostics = [];
  assert.deepEqual(storage.readJsonWithBackupSync(file, null, {
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  }), { version: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1 });
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('settings.json.corrupt-')));
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'POPPET_JSON_RECOVERED');
  assert.match(diagnostics[0].primaryError, /JSON|position|property/i);
  assert.ok(diagnostics[0].preservedPrimary);
});

test('atomic JSON backup reuses the exact bounded read instead of reopening the pathname', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-backup-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.json');
  storage.atomicWriteJsonSync(file, { version: 1 });

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function(target, ...args) {
    if (path.resolve(String(target)) === path.resolve(file)) {
      throw new Error('the validated pathname was reopened');
    }
    return originalReadFileSync.call(this, target, ...args);
  };
  try {
    storage.atomicWriteJsonSync(file, { version: 2 });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { version: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2 });
});

test('both-invalid JSON copies preserve the primary and emit an actionable diagnostic', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-corrupt-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{broken-primary');
  fs.writeFileSync(file + '.bak', '{broken-backup');
  const fallback = { safe: true };
  const diagnostics = [];

  assert.equal(storage.readJsonWithBackupSync(file, fallback, {
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  }), fallback);
  assert.equal(fs.existsSync(file), false);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'POPPET_JSON_FALLBACK');
  assert.match(diagnostics[0].primaryError, /JSON|position|property/i);
  assert.match(diagnostics[0].backupError, /JSON|position|property/i);
  assert.ok(diagnostics[0].preservedPrimary);
  assert.equal(fs.readFileSync(diagnostics[0].preservedPrimary, 'utf8'), '{broken-primary');
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '{broken-backup');
});

test('exact serialized JSON byte limits fail before mutating the last-good file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-json-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.json');
  storage.atomicWriteJsonSync(file, { value: 'safe' }, { maxBytes: 64, label: 'metadata' });
  const before = fs.readFileSync(file);

  assert.throws(
    () => storage.atomicWriteJsonSync(file, { value: 'x'.repeat(64) }, { maxBytes: 64, label: 'metadata' }),
    /metadata exceeds 64 byte limit/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(file + '.bak'), false);
});

test('atomic replace leaves complete bytes and no temporary file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-replace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'value.bin');
  storage.atomicReplaceFileSync(file, Buffer.from('first'));
  storage.atomicReplaceFileSync(file, Buffer.from('second'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(dir), ['value.bin']);
});

test('bounded semantic JSON reads recover from oversized or unsafe primary files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppet-bounded-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.json');
  fs.writeFileSync(file + '.bak', JSON.stringify({ width: 16 }));
  fs.writeFileSync(file, ' '.repeat(2048));
  const options = {
    maxBytes: 1024,
    validate(value) {
      if (!Number.isInteger(value.width) || value.width > 100) throw new Error('unsafe width');
      return value;
    },
  };
  assert.deepEqual(storage.readJsonWithBackupSync(file, null, options), { width: 16 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { width: 16 });

  fs.writeFileSync(file, JSON.stringify({ width: 1e9 }));
  assert.deepEqual(storage.readJsonWithBackupSync(file, null, options), { width: 16 });
});

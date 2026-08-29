'use strict';
// 小型、同步、可审计的耐久写入原语。所有临时文件都和目标位于同一目录，
// 因而 rename 在同一文件系统内原子发布；JSON 会保留最后一份可解析备份。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fsyncDirSync(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows 不保证目录句柄可 fsync；文件本身已经 fsync，rename 仍保持原子性。
    if (process.platform !== 'win32') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function durableWriteFileSync(file, data, mode = 0o600) {
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function tempPathFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

function atomicReplaceFileSync(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  ensureDirSync(dir);
  const tmp = tempPathFor(file);
  try {
    durableWriteFileSync(tmp, data, mode);
    fs.renameSync(tmp, file);
    fsyncDirSync(dir);
  } catch (error) {
    try {
      const stat = fs.lstatSync(tmp);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

function readFileLimitedSync(file, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('JSON size limit is invalid');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error('JSON file is not a bounded regular file');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(file, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes
        || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error('JSON file changed before read');
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error('JSON file was truncated while reading');
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, null) !== 0) throw new Error('JSON file grew while reading');
    const after = fs.fstatSync(fd);
    const pathAfter = fs.lstatSync(file);
    if (after.size !== opened.size || pathAfter.isSymbolicLink()
        || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error('JSON file was replaced while reading');
    }
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function checkedJsonValue(value, validate) {
  if (typeof validate !== 'function') return value;
  const validated = validate(value);
  return validated === undefined ? value : validated;
}

function jsonOptions(options = {}) {
  return {
    maxBytes: Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes : 2 * 1024 * 1024,
    validate: options.validate,
    label: typeof options.label === 'string' && options.label ? options.label : 'JSON',
  };
}

function readJsonRecordSync(file, options = {}) {
  const normalized = jsonOptions(options);
  // `bytes` is the exact buffer parsed and semantically validated below. Callers that
  // promote it to a backup must reuse this buffer rather than reopening the pathname.
  const bytes = readFileLimitedSync(file, normalized.maxBytes);
  const value = checkedJsonValue(JSON.parse(bytes.toString('utf8')), normalized.validate);
  return { bytes, value };
}

function parseJsonFileSync(file, options = {}) {
  return readJsonRecordSync(file, options).value;
}

function encodeJson(value, options = {}) {
  const normalized = jsonOptions(options);
  const checked = checkedJsonValue(value, normalized.validate);
  const text = JSON.stringify(checked, null, 2);
  if (typeof text !== 'string') throw new Error(`${normalized.label} cannot be serialized`);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < 1 || bytes.length > normalized.maxBytes) {
    throw new Error(`${normalized.label} exceeds ${normalized.maxBytes} byte limit`);
  }
  return { bytes, value: checked };
}

function atomicWriteJsonSync(file, value, options = {}) {
  const encoded = encodeJson(value, options);
  const backup = file + '.bak';
  let previous = null;
  try {
    // 只把可解析的当前文件提升为备份，绝不拿已损坏内容覆盖最后一份好备份。
    previous = readJsonRecordSync(file, options).bytes;
  } catch {}
  // 当前文件有效时，备份失败也必须让整次更新失败，不能悄悄丢掉恢复点。
  if (previous) atomicReplaceFileSync(backup, previous);
  atomicReplaceFileSync(file, encoded.bytes);
  return encoded.value;
}

function preserveCorruptFileSync(file) {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const corrupt = `${file}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
  fs.renameSync(file, corrupt);
  fsyncDirSync(path.dirname(file));
  return corrupt;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function reportDiagnostic(options, diagnostic) {
  if (typeof options.onDiagnostic !== 'function') return;
  try {
    options.onDiagnostic(diagnostic);
  } catch {
    // Diagnostics must never turn a recoverable storage failure into an app failure.
  }
}

function readJsonWithBackupSync(file, fallback, options = {}) {
  const readOptions = jsonOptions(options);
  let primaryError;
  try {
    return parseJsonFileSync(file, readOptions);
  } catch (error) {
    primaryError = error;
  }

  const backup = file + '.bak';
  let recovered;
  let backupError;
  try {
    recovered = parseJsonFileSync(backup, readOptions);
  } catch (error) {
    backupError = error;
    let preservedPrimary = null;
    let preserveError = null;
    try {
      preservedPrimary = preserveCorruptFileSync(file);
    } catch (preserveFailure) {
      preserveError = preserveFailure;
    }
    // A missing primary and missing backup is the ordinary first-run state, not corruption.
    if (primaryError?.code !== 'ENOENT' || backupError?.code !== 'ENOENT') {
      reportDiagnostic(options, {
        code: 'POPPET_JSON_FALLBACK',
        file,
        backup,
        primaryError: errorMessage(primaryError),
        backupError: errorMessage(backupError),
        preservedPrimary,
        preserveError: preserveError ? errorMessage(preserveError) : null,
      });
    }
    return fallback;
  }
  let preservedPrimary = null;
  let preserveError = null;
  let repairError = null;
  try {
    preservedPrimary = preserveCorruptFileSync(file);
  } catch (error) {
    preserveError = error;
  }
  try {
    atomicReplaceFileSync(file, encodeJson(recovered, readOptions).bytes);
  } catch (error) {
    repairError = error;
    // 即使介质暂时只读，已成功解析的备份仍比静默回落到默认值可靠。
  }
  reportDiagnostic(options, {
    code: 'POPPET_JSON_RECOVERED',
    file,
    backup,
    primaryError: errorMessage(primaryError),
    preservedPrimary,
    preserveError: preserveError ? errorMessage(preserveError) : null,
    repairError: repairError ? errorMessage(repairError) : null,
  });
  return recovered;
}

module.exports = {
  ensureDirSync,
  fsyncDirSync,
  durableWriteFileSync,
  atomicReplaceFileSync,
  encodeJson,
  atomicWriteJsonSync,
  readJsonWithBackupSync,
};

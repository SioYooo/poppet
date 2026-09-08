'use strict';
// 角色库：每个角色一个目录，放在 userData/characters/<id>/ 下。
//   pet.png       角色精灵（已去背、已量化）
//   parts.png     眼/嘴部件图集（可能不存在——五官没检出时就只做整体动画）
//   icon.png      角色管理列表用的头像（不是系统托盘品牌图标）
//   character.json 元数据（尺寸、部件坐标、调色板、描边色…）
//
// 首次启动时把随应用打包的内置角色复制进来，用户从此可以随意删改。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const {
  LIMITS, isSafeCharacterId, assertCharacterId, safeChildPath,
  validateImportPayload, validateMetadataUpdate, validateCharacterMeta,
  validateRuntimeCharacterMeta,
  validateStoredCharacter, validateCharacterPngFiles, readRegularFileLimitedSync,
} = require('./security');
const {
  ensureDirSync, fsyncDirSync, durableWriteFileSync,
  encodeJson, atomicWriteJsonSync, readJsonWithBackupSync,
} = require('./storage');

const APP_ROOT = path.resolve(__dirname, '../..');
const BUILTIN_DIR = path.join(APP_ROOT, 'assets/characters');

function charactersDir() {
  return path.join(app.getPath('userData'), 'characters');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function stagingDir() {
  return path.join(charactersDir(), '.staging');
}

function trashDir() {
  return path.join(charactersDir(), '.trash');
}

function ownedDirectory(dir, label, { create = false } = {}) {
  let stat;
  let created = false;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) return null;
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      created = true;
    } catch (mkdirError) {
      // Another process may have created the path after lstat. Inspect that exact
      // path below rather than accepting mkdir's EEXIST as proof of ownership.
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
    }
    stat = fs.lstatSync(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} 必须是应用自有普通目录`);
  }
  if (created) fsyncDirSync(path.dirname(dir));
  return dir;
}

function ensureCharactersRoot() {
  ensureDirSync(app.getPath('userData'));
  return ownedDirectory(charactersDir(), '角色库目录', { create: true });
}

function existingCharactersRoot() {
  return ownedDirectory(charactersDir(), '角色库目录');
}

function ensureStagingRoot() {
  ensureCharactersRoot();
  return ownedDirectory(stagingDir(), '角色暂存目录', { create: true });
}

function existingStagingRoot() {
  const root = existingCharactersRoot();
  return root ? ownedDirectory(path.join(root, '.staging'), '角色暂存目录') : null;
}

function ensureTrashRoot() {
  ensureCharactersRoot();
  return ownedDirectory(trashDir(), '角色回收站目录', { create: true });
}

const DEFAULT_SETTINGS = {
  activeId: null,
  scale: 0.5,          // 精灵像素 -> 逻辑点的比例
  wander: true,        // 是否自己在桌面上溜达
  onboarded: false,    // 首启引导是否已展示（一次性）
  clickThrough: true,  // 非角色区域是否穿透点击
  alwaysOnTop: true,
  // 注意：setSettings 是全量写盘（{...getSettings(), ...patch}），
  // 也就是说任何跑过一次的用户，settings.json 里都存着当时的每一个默认值。
  // 之后再改 DEFAULT_SETTINGS 对他们没有任何作用——存着的旧值永远赢。
  // 所以这个键从 animationFps 改名成 fps：老的 12 自然作废，新默认值才能生效。
  fps: 60,             // 8~120，低了眨眼这类快动作会丢中间帧
  position: null,      // 旧字段：单只桌宠时的位置。迁移到 pets 之后不再读，但也不删——
                       // setSettings 是全量写盘，删了下次又会被 DEFAULT_SETTINGS 补回来。
  // 同时在屏幕上的桌宠。每项 { characterId, x, y }，x/y 为 null 表示用默认角落。
  // 这是"屏幕上有谁"的唯一真相；activeId / position 只在首次迁移时读一次。
  pets: null,
};

// 屏幕上最多放几只。每只都是一个独立的透明置顶 BrowserWindow，不是免费的。
const MAX_PETS = 6;

// 老用户的 settings.json 里只有 activeId + position，没有 pets。
// 按**形状**迁移而不是按版本号：setSettings 全量写盘，任何跑过一次的用户
// 都存着当时的每一个默认值，版本号靠不住。pets 一旦存在就是唯一真相。
function getPets() {
  const s = getSettings();
  if (Array.isArray(s.pets)) return s.pets.filter(p => p && p.characterId);
  if (s.activeId) {
    const pos = s.position || {};
    return [{ characterId: s.activeId, x: pos.x ?? null, y: pos.y ?? null }];
  }
  return [];
}

function setPets(pets) {
  return setSettings({ pets: pets.slice(0, MAX_PETS) });
}

// 主进程是 CommonJS，src/shared/parts.js 是 ESM，跨不过去，只能在这里复刻一份最小判断。
// 真相源是 shared/parts.js 的 capabilityOf()——改那边时这里必须同步。
// 三种历史形态都要认：漏掉任一种的后果是桌宠正常加载但永远不眨眼，且没有任何报错。
function hasExpressionParts(parts) {
  if (!parts) return false;
  if (Array.isArray(parts)) return parts.some(p => p && (p.role === 'eye' || p.role === 'mouth'));
  if (Array.isArray(parts.eyes)) return parts.eyes.some(Boolean) || !!parts.mouth;
  return !!(parts.eyeL || parts.eyeR || parts.mouth);
}

function logStorageDiagnostic(diagnostic) {
  const details = [
    `file=${diagnostic.file}`,
    diagnostic.primaryError && `primary=${diagnostic.primaryError}`,
    diagnostic.backupError && `backup=${diagnostic.backupError}`,
    diagnostic.preservedPrimary && `preserved=${diagnostic.preservedPrimary}`,
    diagnostic.preserveError && `preserveError=${diagnostic.preserveError}`,
    diagnostic.repairError && `repairError=${diagnostic.repairError}`,
  ].filter(Boolean).join(' ');
  console.warn(`[storage:${diagnostic.code}] ${details}`);
}

function readJSON(file, fallback, options = {}) {
  return readJsonWithBackupSync(file, fallback, {
    ...options,
    onDiagnostic: options.onDiagnostic || logStorageDiagnostic,
  });
}

// ASAR 中 lstat(虚拟条目) 与 open/fstat(外层 archive) 的 dev/ino 天生不同，不能复用
// userData 的 inode identity 防护。这里只允许读取应用自带的只读 assets/characters，
// 仍在 readFileSync 前后执行明确大小上限；任何 userData 路径都不得走这里。
function readTrustedBundledFile(file, maxBytes) {
  const root = path.resolve(BUILTIN_DIR);
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('内置素材路径越界');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error('内置素材不是受限普通文件');
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length < 1 || bytes.length > maxBytes) throw new Error('内置素材实际大小超过限制');
  return bytes;
}

function readTrustedBundledJSON(file, fallback, validate) {
  try {
    const value = JSON.parse(readTrustedBundledFile(file, LIMITS.MAX_METADATA_BYTES).toString('utf8'));
    return typeof validate === 'function' ? validate(value) : value;
  } catch {
    return fallback;
  }
}

function finiteCoordinate(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000);
}

// 旧 settings 没有版本号，继续按形状兼容，但任何会进入窗口尺寸/路径的值都先收窄。
function normalizeSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...DEFAULT_SETTINGS };
  if (raw.activeId === null || isSafeCharacterId(raw.activeId)) out.activeId = raw.activeId;
  if (typeof raw.scale === 'number' && Number.isFinite(raw.scale) && raw.scale >= 0.25 && raw.scale <= 2) out.scale = raw.scale;
  for (const key of ['wander', 'clickThrough', 'alwaysOnTop', 'onboarded']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  if (Number.isInteger(raw.fps) && raw.fps >= 8 && raw.fps <= 120) out.fps = raw.fps;
  if (raw.position && finiteCoordinate(raw.position.x) && finiteCoordinate(raw.position.y)) {
    out.position = { x: raw.position.x, y: raw.position.y };
  }
  if (raw.pets === null) out.pets = null;
  else if (Array.isArray(raw.pets)) {
    out.pets = raw.pets.slice(0, MAX_PETS).filter((pet) => pet && isSafeCharacterId(pet.characterId)
      && finiteCoordinate(pet.x) && finiteCoordinate(pet.y)).map((pet) => ({
      characterId: pet.characterId, x: pet.x, y: pet.y,
    }));
  }
  return out;
}

// getSettings 出现在 mousemove 邻近路径上（点击穿透切换、托盘刷新），
// 每次同步读盘+parse 是无谓的输入延迟来源。setSettings 是唯一写入方，
// 所以进程内缓存是安全的；normalizeSettings 每次都构造全新嵌套对象，
// 缓存不会与调用方共享可变引用，返回值再克隆一份防调用方回写污染。
let settingsCache = null;

function getSettings() {
  if (!settingsCache) {
    settingsCache = normalizeSettings(readJSON(settingsPath(), {}, {
      maxBytes: LIMITS.MAX_SETTINGS_BYTES,
      validate(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings 形状无效');
        return normalizeSettings(value);
      },
    }));
  }
  return structuredClone(settingsCache);
}

function setSettings(patch) {
  const next = normalizeSettings({ ...getSettings(), ...(patch || {}) });
  ensureDirSync(app.getPath('userData'));
  settingsCache = atomicWriteJsonSync(settingsPath(), next, {
    maxBytes: LIMITS.MAX_SETTINGS_BYTES,
    label: 'settings.json',
  });
  return structuredClone(settingsCache);
}

// 把打包进应用的内置角色复制到用户目录（只在该 id 尚不存在时）。
// 只认标了 builtin:true 的——assets/characters/ 下还躺着几个供开发期验证形态用的角色
// （悬浮、四足之类），它们不该出现在用户的角色库里。
function seedBuiltins() {
  if (!fs.existsSync(BUILTIN_DIR)) return;
  ensureCharactersRoot();
  for (const id of fs.readdirSync(BUILTIN_DIR)) {
    if (!isSafeCharacterId(id)) continue;
    const src = resolveExistingDirectory(BUILTIN_DIR, id);
    if (!src) continue;
    const meta = readTrustedBundledJSON(
      path.join(src, 'character.json'), null, validateRuntimeCharacterMeta);
    if (!meta || meta.builtin !== true) continue;
    const dst = resolveCharacterDir(id);
    if (fs.existsSync(dst)) continue;
    publishCopiedDirectory(src, dst);
  }
}

// 导出拦截原因对应的主进程侧用户可读说明（渲染器另有一份 hover 文案）。
const EXPORT_BLOCK_MESSAGES = {
  'legacy-schema': '旧格式角色无法导出：用原图重新创建一个新角色后即可导出',
  'missing-icon': '缺少头像文件（icon.png），无法导出',
};

// listCharacters 与 characterExportBundle 共用的读取：用接受 v0/v1 的运行时校验
// 读 character.json，再算出导出拦截原因。readJSON 带 corrupt-preservation 副作用
// （校验失败且无 .bak 时把文件改名为 .corrupt-*），只能留给真正无法解析/越界的
// 文件；"合法但不满足导出 schema"的判定必须在这条无副作用的路径上完成，
// 绝不能拿严格 v2 校验去触发它。
function readExportState(characterDir) {
  const meta = readJSON(path.join(characterDir, 'character.json'), null, {
    maxBytes: LIMITS.MAX_METADATA_BYTES,
    validate: validateRuntimeCharacterMeta,
  });
  if (!meta) return null;
  // 导出走严格 v2 校验并要求 icon.png；宽松加载（v0/v1 兼容、可缺 icon）
  // 能显示的角色不一定能导出。提前算出原因，渲染器才能解释而不是静默藏按钮。
  // 只报优先级最高的一个：内置品牌角色是许可证约束（哪怕它自己也没写
  // schemaVersion）；旧格式没有原地升级路径、只能重做角色，单独补 icon 无用，
  // 所以 legacy-schema 排在 missing-icon 之前。
  // v2 = 表情部件角色，v3 = 关节骨架角色。两者都是"当前格式"，
  // 只有 v0/v1 才是没有原地升级路径的旧格式。写成 `!== 2` 会把每一个
  // 骨架角色判成旧格式并静默禁止导出——而骨架角色恰恰是要拿来分发的那种。
  const exportBlockReason = meta.builtin ? 'builtin'
    : (meta.schemaVersion !== 2 && meta.schemaVersion !== 3) ? 'legacy-schema'
      : !fs.existsSync(path.join(characterDir, 'icon.png')) ? 'missing-icon'
        : null;
  return { meta, exportBlockReason };
}

function listCharacters() {
  const dir = existingCharactersRoot();
  if (!dir) return [];
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    if (!isSafeCharacterId(id)) continue; // .staging / .trash 以及异常目录都不可见
    const characterDir = resolveExistingCharacterDir(id);
    if (!characterDir) continue;
    const state = readExportState(characterDir);
    if (!state) continue;
    const { meta, exportBlockReason } = state;
    out.push({
      id,
      name: meta.name || id,
      builtin: !!meta.builtin,
      // 字段名为旧 renderer API 保留；语义是“至少有一种表情能力”。
      hasFace: hasExpressionParts(meta.parts),
      sprite: meta.sprite,
      iconDataURL: readImageDataURL(path.join(characterDir, 'icon.png')),
      // 与 (!meta.builtin && schemaVersion 是 2 或 3 && icon.png 存在) 等价；
      // 渲染器与 dev-capture 的 .poppetpack 往返只看这个布尔。
      exportable: exportBlockReason === null,
      exportBlockReason,
    });
  }
  return out.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1));
}

function readImageDataURL(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return 'data:image/png;base64,'
      + readRegularFileLimitedSync(file, LIMITS.MAX_GENERATED_FILE_BYTES, '角色图片').toString('base64');
  } catch {
    return null;
  }
}

// 开发期直接从源码目录读角色，用来验证那些故意不 seed 进用户库的形态样本
function loadBuiltinCharacter(id) {
  const dir = resolveExistingDirectory(BUILTIN_DIR, id);
  return dir ? loadFrom(dir, id) : null;
}

// 供桌宠窗口使用的完整数据：图片走 dataURL，免得 renderer 再去碰文件系统
function loadCharacter(id) {
  const dir = resolveExistingCharacterDir(id);
  return dir ? loadFrom(dir, id) : null;
}

function loadFrom(dir, id) {
  try {
    const pet = readRegularFileLimitedSync(
      path.join(dir, 'pet.png'), LIMITS.MAX_GENERATED_FILE_BYTES, 'pet.png');
    const partsPath = path.join(dir, 'parts.png');
    const parts = fs.existsSync(partsPath)
      ? readRegularFileLimitedSync(partsPath, LIMITS.MAX_GENERATED_FILE_BYTES, 'parts.png') : null;
    const files = { 'pet.png': pet };
    if (parts) files['parts.png'] = parts;
    const meta = readJSON(path.join(dir, 'character.json'), null, {
      maxBytes: LIMITS.MAX_METADATA_BYTES,
      validate: value => validateStoredCharacter(value, files).meta,
    });
    if (!meta) return null;
    return {
      id,
      meta,
      spriteDataURL: 'data:image/png;base64,' + pet.toString('base64'),
      atlasDataURL: parts ? 'data:image/png;base64,' + parts.toString('base64') : null,
    };
  } catch {
    return null;
  }
}

// 再兜一层：算出来的目录必须真的落在 characters/ 之下。
// 只用 startsWith 是不够的——characters-evil 也能通过前缀检查。
function resolveCharacterDir(id) {
  return safeChildPath(charactersDir(), id);
}

function resolveExistingDirectory(base, id) {
  const dir = safeChildPath(base, id);
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null;
  } catch {
    return null;
  }
}

function resolveExistingCharacterDir(id) {
  assertCharacterId(id);
  const root = existingCharactersRoot();
  return root ? resolveExistingDirectory(root, id) : null;
}

// .poppetpack 导出用：返回一个已保存角色的已验证 meta 与原始 PNG 字节。
// 内置品牌角色受 LicenseRef-Poppet-Noncommercial-Artwork-1.0 约束（禁止单独提取复用），
// 不允许被导出成可交换的角色包。
function characterExportBundle(id) {
  const dir = resolveExistingCharacterDir(id);
  if (!dir) throw new Error('角色不存在: ' + id);
  // 拒绝不能有任何文件系统副作用：先走无副作用的运行时读取算出拒绝原因，
  // 旧格式/内置/缺 icon 的角色在这里被拒，文件一个字节都不会动。严格 v2 校验
  // 只在 reason === null 之后对已解析对象直接调用，失败同样只是拒绝——
  // 不经 readJSON 的 validate 选项，就不会把"不满足导出 schema"的合法文件
  // 当成损坏文件改名成 .corrupt-*。
  const state = readExportState(dir);
  if (!state) throw new Error('角色 metadata 或素材已损坏: ' + id);
  if (state.exportBlockReason === 'builtin') {
    const error = new Error('内置品牌角色不允许导出为角色包');
    error.code = 'POPPET_PACK_BUILTIN_FORBIDDEN';
    throw error;
  }
  if (state.exportBlockReason) {
    throw notExportableError(state.exportBlockReason, EXPORT_BLOCK_MESSAGES[state.exportBlockReason]);
  }
  let meta;
  try {
    meta = validateCharacterMeta(state.meta);
  } catch (cause) {
    throw notExportableError('invalid-metadata', `角色数据不满足角色包格式：${cause.message}`, cause);
  }
  const read = name => readRegularFileLimitedSync(
    path.join(dir, name), LIMITS.MAX_GENERATED_FILE_BYTES, name);
  const raw = { 'pet.png': read('pet.png') };
  if (fs.existsSync(path.join(dir, 'parts.png'))) raw['parts.png'] = read('parts.png');
  raw['icon.png'] = read('icon.png');
  const files = validateCharacterPngFiles(meta, raw, { requireIcon: true });
  return { meta, files };
}

function notExportableError(reason, message, cause) {
  const error = new Error(message);
  error.code = 'POPPET_PACK_NOT_EXPORTABLE';
  error.reason = reason;
  if (cause) error.cause = cause;
  return error;
}

function characterIconDataURL(id) {
  const dir = resolveExistingCharacterDir(id);
  if (!dir) return null;
  // NativeImage must never receive a userData path: it would follow a leaf
  // symlink outside the character directory. Reuse the bounded O_NOFOLLOW read
  // and hand the main process owned bytes instead.
  return readImageDataURL(path.join(dir, 'icon.png'));
}

function removeOwnedStagingDir(dir) {
  let stagingRoot;
  try {
    stagingRoot = existingStagingRoot();
  } catch {
    return;
  }
  if (!stagingRoot) return;
  const root = path.resolve(stagingRoot);
  const relative = path.relative(root, path.resolve(dir));
  if (!/^[0-9a-f-]{36}$/i.test(relative) || path.dirname(relative) !== '.') return;
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(dir, { recursive: true, force: false });
  } catch {}
}

function publishCopiedDirectory(src, dst) {
  const characterRoot = ensureCharactersRoot();
  const stageRoot = ensureStagingRoot();
  const stage = path.join(stageRoot, crypto.randomUUID());
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    let total = 0;
    for (const name of fs.readdirSync(src)) {
      if (!['pet.png', 'parts.png', 'icon.png', 'character.json'].includes(name)) continue;
      const from = path.join(src, name);
      const maxBytes = name === 'character.json'
        ? LIMITS.MAX_METADATA_BYTES : LIMITS.MAX_GENERATED_FILE_BYTES;
      const bytes = readTrustedBundledFile(from, maxBytes);
      total += bytes.length;
      if (total > LIMITS.MAX_IMPORT_BYTES + LIMITS.MAX_METADATA_BYTES) throw new Error('内置角色文件过大');
      durableWriteFileSync(path.join(stage, name), bytes);
    }
    if (!fs.existsSync(path.join(stage, 'character.json')) || !fs.existsSync(path.join(stage, 'pet.png'))) {
      throw new Error('内置角色文件不完整');
    }
    fsyncDirSync(stage);
    fs.renameSync(stage, dst);
    fsyncDirSync(characterRoot);
  } catch (error) {
    removeOwnedStagingDir(stage);
    throw error;
  }
}

// payload: { name, meta, files: { 'pet.png': ArrayBuffer, ... } }
function importCharacter(payload) {
  const input = validateImportPayload(payload);
  const characterRoot = ensureCharactersRoot();
  const id = input.id || makeId(input.name || 'pet', characterRoot);
  const dir = safeChildPath(characterRoot, id);
  if (fs.existsSync(dir)) throw new Error('角色 id 已存在: ' + id);
  const meta = { ...input.meta, name: input.name || id, builtin: false, importedAt: new Date().toISOString() };
  const encodedMeta = encodeJson(meta, {
    maxBytes: LIMITS.MAX_METADATA_BYTES,
    validate: validateCharacterMeta,
    label: '角色 metadata',
  });
  const stageRoot = ensureStagingRoot();
  const stage = path.join(stageRoot, crypto.randomUUID());
  fs.mkdirSync(stage, { mode: 0o700 });
  let published = false;
  try {
    for (const [fileName, bytes] of Object.entries(input.files)) {
      durableWriteFileSync(path.join(stage, fileName), bytes);
    }
    durableWriteFileSync(path.join(stage, 'character.json'), encodedMeta.bytes);
    fsyncDirSync(stage);
    fs.renameSync(stage, dir);
    published = true;
    fsyncDirSync(characterRoot);
  } catch (error) {
    if (!published) {
      removeOwnedStagingDir(stage);
    } else {
      // rename 已完成而父目录 fsync 失败：当前进程能看到完整目录，但不能宣称 T4
      // durable。把 exact id 带回 main，后续只做幂等 finalize，不得重新 import。
      const uncertain = new Error('角色已发布，但持久化确认失败');
      uncertain.code = 'POPPET_IMPORT_DURABILITY_UNCONFIRMED';
      uncertain.persistedId = id;
      uncertain.stage = 'parent-directory-fsync';
      uncertain.cause = error;
      throw uncertain;
    }
    throw error;
  }
  return id;
}

function finalizeImportedCharacter(id) {
  assertCharacterId(id);
  const characterRoot = existingCharactersRoot();
  if (!characterRoot) {
    const error = new Error('待确认角色目录不存在');
    error.code = 'POPPET_IMPORT_RECOVERY_MISSING';
    throw error;
  }
  const exactDir = safeChildPath(characterRoot, id);
  let exactStat;
  try {
    exactStat = fs.lstatSync(exactDir);
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
    const error = new Error('待确认角色目录不存在');
    error.code = 'POPPET_IMPORT_RECOVERY_MISSING';
    throw error;
  }
  if (!exactStat.isDirectory() || exactStat.isSymbolicLink()) {
    const error = new Error('待确认角色无法通过完整性校验');
    error.code = 'POPPET_IMPORT_RECOVERY_INVALID';
    throw error;
  }
  const character = loadCharacter(id);
  if (!character) {
    const error = new Error('待确认角色无法通过完整性校验');
    error.code = 'POPPET_IMPORT_RECOVERY_INVALID';
    throw error;
  }
  try {
    fsyncDirSync(characterRoot);
  } catch (cause) {
    const error = new Error('角色持久化仍未确认');
    error.code = 'POPPET_IMPORT_DURABILITY_UNCONFIRMED';
    error.persistedId = id;
    error.stage = 'parent-directory-fsync';
    error.cause = cause;
    throw error;
  }
  return id;
}

// 只改元数据（比如动作方式），不动图片，省去重跑一遍管线
function updateCharacterMeta(id, patch) {
  const validated = validateMetadataUpdate({ id, patch });
  const dir = resolveExistingCharacterDir(validated.id);
  if (!dir) throw new Error('角色不存在: ' + validated.id);
  const file = path.join(dir, 'character.json');
  const character = loadFrom(dir, validated.id);
  if (!character) throw new Error('角色 metadata 或素材已损坏: ' + validated.id);
  // 骨架只能**编辑**，不能凭空补到一个 v2 角色上：那种角色没有骨骼图集，
  // 补上去的骨架每一根都会指向不存在的图集矩形。想要骨架就走角色包导入。
  if (validated.patch.skeleton !== undefined && character.meta.skeleton === undefined) {
    const error = new Error('这个角色不是骨架角色，无法添加骨架');
    error.code = 'POPPET_INVALID_INPUT';
    throw error;
  }
  const next = { ...character.meta, ...validated.patch };
  return atomicWriteJsonSync(file, next, {
    maxBytes: LIMITS.MAX_METADATA_BYTES,
    validate: validateRuntimeCharacterMeta,
    label: '角色 metadata',
  });
}

function deleteCharacter(id) {
  assertCharacterId(id);
  const dir = resolveExistingCharacterDir(id);
  if (!dir) throw new Error('角色不存在: ' + id);
  const characterRoot = ensureCharactersRoot();
  const trashRoot = ensureTrashRoot();
  const target = path.join(trashRoot, `${id}-${Date.now()}-${crypto.randomUUID()}`);
  fs.renameSync(dir, target);
  fsyncDirSync(characterRoot);
  fsyncDirSync(trashRoot);
  return true;
}

function makeId(name, characterRoot = charactersDir()) {
  // 保留所有 Unicode 字母与数字，中文名才不会被清成空串——
  // 否则每个中文角色都会退化成 pet / pet-2 / pet-3，目录里根本认不出谁是谁。
  let slug = String(name).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (!isSafeCharacterId(slug)) slug = 'pet';
  let id = slug, n = 2;
  while (fs.existsSync(safeChildPath(characterRoot, id))) id = `${slug}-${n++}`;
  return id;
}

// 拿一个能用的角色 id：优先设置里记的，否则第一个
function resolveActiveId() {
  const list = listCharacters();
  if (!list.length) return null;
  const wanted = getSettings().activeId;
  return list.some(c => c.id === wanted) ? wanted : list[0].id;
}

module.exports = {
  MAX_PETS, getPets, setPets,
  seedBuiltins, listCharacters, loadCharacter, loadBuiltinCharacter,
  importCharacter, finalizeImportedCharacter, deleteCharacter, updateCharacterMeta,
  getSettings, setSettings, resolveActiveId, charactersDir, characterIconDataURL,
  characterExportBundle,
};

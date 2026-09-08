'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { app, ipcMain, Tray, Menu, dialog, BrowserWindow, clipboard } = require('electron');

const { CH } = require('./channels');
const platform = require('./platform');
const lib = require('./library');
const { loadBrandTrayImage } = require('./brand-icon');
const { configureUserDataCompatibility } = require('./user-data-compat');
const { PetWindow } = require('./pet-window');
const { createDisplayRescue } = require('./display-rescue');
const { openManager, getManagerWindow } = require('./manager-window');
const { probeImageDimensions } = require('./image-probe');
const {
  LIMITS, assertCharacterId, assertImageBudget, validateImportPayload,
  validateMetadataUpdate, validateSettingsPatch, validateMove,
  validateBoolean, validateLog, noArguments, oneArgument, assertTrustedIpcFrame,
  safeIpcListener, readRegularFileLimitedSync,
} = require('./security');
const { PACK_LIMITS, parsePoppetpack, buildPoppetpack } = require('./pack');
const { atomicReplaceFileSync } = require('./storage');

const DEV = !app.isPackaged && process.argv.includes('--dev');
const DEV_SMOKE = DEV && [
  '--test-click', '--test-manager', '--test-manager-restart', '--test-multi',
].find(flag => process.argv.includes(flag));
// --isolated（npm run dev:isolated）：交互式开发，但 userData 是 runner 新建的临时
// 目录。smoke 标志优先：两者同时出现时仍是 DEV_SMOKE，smoke 语义不变。
const DEV_ISOLATED = DEV && !DEV_SMOKE && process.argv.includes('--isolated');
let userDataReady = true;
if (DEV_SMOKE) {
  configureSmokeUserData();
  // Windows CI/沙箱可能没有可加载的 GPU 子进程依赖。功能 smoke 只验证
  // Canvas/IPC/持久化语义，固定走 Chromium 软件 2D 路径可避免环境性崩溃。
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
} else if (DEV_ISOLATED) {
  // 与 smoke 共用同一条 fail-closed 校验链（tmpdir 直属、poppet-electron-smoke-
  // 前缀、真实目录、非符号链接），之后走正常交互式启动路径：不关硬件加速、
  // 不挂 smoke handler、不设超时；首启引导与 seedBuiltins 照常发生在隔离目录里。
  // 这里跳过 configureUserDataCompatibility（legacy 迁移守卫）的唯一理由是
  // userData 已被隔离到一个刚新建的临时目录，旁边不存在可迁移的旧版资料，
  // 守卫没有作用对象——这是"经隔离绕过"，不是放宽检查：非隔离启动仍由下面的
  // else 分支 fail-closed。（即便调用，它也只会因非标准路径名立即返回。）
  configureSmokeUserData();
} else {
  const profile = configureUserDataCompatibility({ app });
  userDataReady = profile.status !== 'LEGACY_PROFILE_BUSY';
}
// --capture <目录> [--demo]：dev 下自动抓帧核对渲染，实现见 dev-capture.js
const CAPTURE = DEV && process.argv.includes('--capture') ? {
  dir: argValue('--capture'),
  delay: Number(argValue('--capture-delay') || 2) * 1000,
  shots: Number(argValue('--capture-shots') || 6),
  interval: Number(argValue('--capture-interval') || 500),
  demo: process.argv.includes('--demo'),
} : null;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function configureSmokeUserData() {
  const candidate = process.env.POPPET_TEST_USER_DATA;
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = candidate && path.resolve(candidate);
  let stat = null;
  try { stat = resolved ? fs.lstatSync(resolved) : null; } catch {}
  const valid = resolved
    && path.dirname(resolved) === temporaryRoot
    && path.basename(resolved).startsWith('poppet-electron-smoke-')
    && stat?.isDirectory()
    && !stat.isSymbolicLink();
  if (!valid) throw new Error('Electron smoke tests require an isolated POPPET_TEST_USER_DATA directory');
  app.setPath('userData', resolved);
}

function runDevSmoke(label, factory) {
  Promise.resolve().then(factory).catch((error) => {
    console.error(`[${label}] 未处理异常: ${error?.stack || error}`);
    app.exit(1);
  });
}

function failMainStartup(error) {
  console.error(`[main] 启动失败: ${error?.stack || error}`);
  // 打包环境里 console.error 没有任何用户可见面；退出前必须弹一个真实的
  // 系统对话框，否则用户看到的只是"双击后什么都没发生"。
  // smoke/CI 是无人值守的：模态框没人点，会把干净的 exit(1) 拖成 90 秒
  // 超时误报，所以只在真实用户会话里弹。
  if (!DEV_SMOKE) {
    try {
      dialog.showErrorBox(
        'Poppet 无法启动',
        `启动过程中发生错误，应用即将退出。\n\n${error?.message || error}`,
      );
    } catch { /* 对话框本身失败时仍必须退出 */ }
  }
  app.exit(1);
}

// 屏幕上的每一只都是一个独立的 PetWindow。所有按窗口来的 IPC 都必须靠
// event.sender 找回是哪一只——拿全局的"当前那只"会串：拖 B 会动 A。
let pets = [];
let tray = null;
let quitting = false;
let displayRescue = null;

const petFromEvent = (e) => pets.find(p => p.win && !p.win.isDestroyed() && p.win.webContents === e.sender) || null;
const petOf = (characterId) => pets.find(p => p.characterId === characterId) || null;

// 只允许一个实例：第二次启动就把管理窗口拉出来，而不是再放一只宠物
if (!userDataReady || !app.requestSingleInstanceLock()) {
  if (DEV_SMOKE) {
    console.error(`[${DEV_SMOKE.slice(2)}] 无法取得隔离 profile 的单实例锁`);
    app.exit(1);
  } else {
    // 拿不到锁通常意味着另一个实例已在运行（它会亮出管理窗口）；但
    // LEGACY_PROFILE_BUSY 是迁移期的保护性拒绝，静默退出会让用户以为
    // 应用坏了。给一句可行动的解释再退。
    if (!userDataReady) {
      try {
        dialog.showErrorBox(
          'Poppet 暂时无法启动',
          '旧版本的资料目录正被占用（可能旧版本仍在运行）。\n' +
          '请先退出旧版本，然后重新打开 Poppet；你的角色数据不会丢失。',
        );
      } catch { /* 继续退出 */ }
    }
    app.quit();
  }
} else {
  app.on('second-instance', () => { openManager(); platform.focusApp(); });
}

app.whenReady().then(() => {
  platform.hideFromDock();
  lib.seedBuiltins();

  const settings = lib.getSettings();
  const id = lib.resolveActiveId();
  if (id && id !== settings.activeId) lib.setSettings({ activeId: id });

  // --character <id>：开发期直接指定角色，方便针对某一形态做验证
  // 先查用户库，再退回源码里的形态样本（那些故意没 seed 进用户库）
  const forced = DEV ? argValue('--character') : null;
  if (forced) {
    const c = lib.loadCharacter(forced) || lib.loadBuiltinCharacter(forced);
    if (c) spawnPet(c, null);
  } else {
    for (const entry of lib.getPets()) {
      const c = lib.loadCharacter(entry.characterId);
      if (c) spawnPet(c, entry);
    }
    // 老用户迁移过来是空的、或者角色被删光了：至少放一只，别开出个空桌面
    if (!pets.length && id) {
      const c = lib.loadCharacter(id);
      if (c) { spawnPet(c, null); persistPets(); }
    }
  }

  buildTray();

  // 首启引导（一次性）：真实首启路径是 seedBuiltins 保证必有一只宠、
  // 桌宠静默出现、无 dock 图标、Manager 永不自动打开——新用户没有任何
  // 线索知道可以拖拽/右键/去托盘。首启时打开 Manager 并让桌宠打个招呼。
  // DEV_SMOKE / --character / capture 路径不参与，避免污染测试与采集。
  if (!DEV_SMOKE && !forced && !CAPTURE) {
    const bootSettings = lib.getSettings();
    if (!bootSettings.onboarded) {
      lib.setSettings({ onboarded: true });
      openManager();
      const first = pets[0];
      if (first) {
        void first.waitForFirstFrame(8000)
          .then(() => { first.send(CH.PET_COMMAND, { action: 'greet' }); })
          .catch(() => { /* 首帧失败由 watchdog 处理，引导不额外报错 */ });
      }
    }
  }

  // 锁屏/休眠期间桌宠不可见，却仍以 60fps 逼 WindowServer 合成透明置顶
  // 窗口——这是常驻应用最大的一笔无谓电量。只暂停已过首帧确认的宠
  // （确认需要真实绘制，暂停未确认的会触发 5 秒 watchdog 误收）；恢复
  // fail-open：无条件发给每一只，未暂停者视为 no-op。lock 事件仅
  // macOS/Windows 提供，suspend/resume 补齐其余路径。
  {
    const { powerMonitor } = require('electron');
    const pausePets = () => {
      for (const p of pets) {
        if (p.isFirstFrameLive()) p.send(CH.PET_COMMAND, { action: 'power-pause' });
      }
    };
    const resumePets = () => {
      // 会议模式下解锁屏幕不恢复：用户显式要求隐藏，保持隐藏且保持暂停
      if (allPetsHiddenByUser) return;
      for (const p of pets) p.send(CH.PET_COMMAND, { action: 'power-resume' });
    };
    powerMonitor.on('lock-screen', pausePets);
    powerMonitor.on('suspend', pausePets);
    powerMonitor.on('unlock-screen', resumePets);
    powerMonitor.on('resume', resumePets);
  }

  // 显示器被拔掉/分辨率排列变化后，不溜达的桌宠会滞留在已消失的坐标上，
  // 此前只能靠用户碰巧点托盘"都回到屏幕右下角"。这里只复用已有的
  // clampToDisplay 语义，不引入新的定位算法；pets 会被重新赋值，必须传闭包。
  {
    const { screen } = require('electron');
    displayRescue = createDisplayRescue({
      screen,
      getPets: () => pets,
      persistPets,
      log: (message, error) => { if (DEV) console.error(`[display-rescue] ${message}:`, error); },
    });
    displayRescue.attach();
  }

  if (!pets.length) openManager(); // 库是空的，直接引导用户导入

  // 库是空的时候一只都没有，dev 工具要能接受这件事而不是崩在 undefined 上
  if (DEV && CAPTURE && pets[0]) require('./dev-capture').startCapture(pets[0], CAPTURE);
  if (DEV_SMOKE === '--test-click') {
    if (!pets[0]) {
      console.error('[click-test] ✗ 隔离 profile 中没有可测试的默认角色');
      app.exit(1);
      return;
    }
    runDevSmoke('click-test', () => require('./dev-capture').testClick(pets[0]));
  }
  if (DEV_SMOKE === '--test-multi') {
    runDevSmoke('multi-test', () => require('./dev-capture').testMulti({ spawnPet, pets: () => pets, lib }));
  }
  if (DEV_SMOKE === '--test-manager') {
    runDevSmoke('manager-test', () => require('./dev-capture').testManager({
      openManager,
      lib,
      pets: () => pets,
      spawnPet,
      despawnPet,
      importPackFromPath,
      sourcePath: path.join(__dirname, '../../assets/characters/default/pet.png'),
      artifactDir: path.join(__dirname, '../../.artifacts/manager'),
    }));
  }
  if (DEV_SMOKE === '--test-manager-restart') {
    runDevSmoke('manager-restart-test', () => require('./dev-capture').testManagerRestart({
      lib,
      pets: () => pets,
      artifactDir: path.join(__dirname, '../../.artifacts/manager'),
    }));
  }
  const mgrDir = DEV ? argValue('--capture-manager') : null;
  if (mgrDir) {
    const mgrSource = argValue('--capture-manager-source') ||
      path.join(__dirname, '../../assets/source/original.png');
    require('./dev-capture').captureManager(
      openManager, mgrDir, path.resolve(mgrSource));
  }
}).catch(failMainStartup);

// 托盘应用：关掉窗口不等于退出。订阅这个事件本身就阻止了默认的退出行为，
// 而且它不带 event 参数，别去碰 preventDefault。
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  // 必须先停掉显示器救援：它的去抖定时器若在下面 pets = [] 之后才触发，
  // 会把空列表 persistPets() 回磁盘，抹掉刚记下的每一只的位置。
  if (displayRescue) { displayRescue.dispose(); displayRescue = null; }
  // 记住每一只站在哪儿，下次启动各回各位，而不是全弹回右下角
  persistPets();
  const closingPets = pets;
  pets = [];
  for (const p of closingPets) p.destroy();
});

// ---------------- 桌宠实例管理 ----------------

function armFirstFrameWatchdog(p, timeoutMs) {
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  void p.waitForFirstFrame(boundedTimeout).then(() => {
    // 首帧在会议模式开启期间落定（导入进行中用户点了隐藏）：此刻补上
    // hide+pause，否则这只会以隐藏状态全速渲染，且没有任何暂停路径够得着它。
    if (allPetsHiddenByUser && pets.includes(p)) {
      p.send(CH.PET_COMMAND, { action: 'power-pause' });
      try { p.win?.hide(); } catch { /* 窗口销毁竞态 */ }
    }
  }).catch((error) => {
    if (quitting || !pets.includes(p)) return;
    // Cold restore does not have an IPC caller awaiting ensurePetReady(). Without
    // this independent gate a renderer boot failure leaves a blank window holding
    // a MAX_PETS slot forever. Cleanup is exact-instance and leaves sibling pets up.
    if (!despawnPetInstance(p)) return;
    try { updatePetRoster(); } catch (rosterError) {
      if (DEV) console.error('[pet] 首帧 watchdog 后更新 roster 失败:', rosterError);
    }
    if (DEV) console.error('[pet] 首帧 watchdog 清理空白窗口:', error?.code || error?.message);
    // 冷启动恢复没有 IPC 调用方等结果：如果 watchdog 把最后一只也收掉了，
    // 用户面前就是一个空桌面。打开管理窗口，至少给一个能继续操作的界面。
    if (!pets.length && !quitting) {
      try { openManager(); } catch (managerError) {
        if (DEV) console.error('[pet] watchdog 后打开管理窗口失败:', managerError);
      }
    }
  });
}

function spawnPet(character, saved, firstFrameTimeoutMs = 5000) {
  if (pets.length >= lib.MAX_PETS) return null;
  const p = new PetWindow(character, pets.length);
  p.onDrop = () => p.send(CH.PET_DROPPED);
  p.onUnavailable = () => {
    if (quitting) return;
    if (!despawnPetInstance(p)) return;
    try { updatePetRoster(); } catch (error) {
      if (DEV) console.error('[pet] unavailable 后更新 roster 失败:', error);
    }
  };
  try {
    p.create(lib.getSettings(), spriteSizeOf(character),
             saved && Number.isFinite(saved.x) ? saved : null);
    if (p._firstFrameTerminal) {
      p.destroy();
      return null;
    }
    // MAX_PETS 检查到 push 之间不能有 await；主进程同一 tick 内原子占住槽位。
    pets.push(p);
    armFirstFrameWatchdog(p, firstFrameTimeoutMs);
    return p;
  } catch (error) {
    p.destroy();
    if (DEV) console.error('[pet] 建窗失败:', error);
    return null;
  }
}

function despawnPetInstance(p, destroy = true) {
  if (!p || !pets.includes(p)) return false;
  pets = pets.filter(x => x !== p);
  if (destroy) p.destroy();
  return true;
}

function despawnPet(characterId) {
  const p = petOf(characterId);
  return despawnPetInstance(p);
}

// 把"屏幕上有谁、各在哪"写回设置。位置从窗口现读，不靠缓存——
// 拖拽是主进程直接 setPosition 的，renderer 那边并不知道最终落点。
function persistPets() {
  lib.setPets(pets.map(p => {
    const b = p.bounds();
    return { characterId: p.characterId, x: b ? b.x : null, y: b ? b.y : null };
  }));
}

function spriteSizeOf(character) {
  return character?.meta?.sprite || { width: 191, height: 400 };
}

// ---------------- 托盘 ----------------

function trayIconImage() {
  // 系统托盘是 Poppet 的品牌入口，不是当前桌宠的头像。免费 Core 始终使用
  // 打包内的金发默认角色；导入、切换或删除角色都不能间接改掉它。
  return loadBrandTrayImage({ existsSync: fs.existsSync, trayImage: platform.trayImage });
}

function buildTray() {
  const image = trayIconImage();
  if (!tray) {
    tray = new Tray(image);
    tray.setToolTip('Poppet 桌宠');
    // Windows 习惯左键单击直接开管理窗口；macOS 左键弹菜单
    if (platform.isWin) tray.on('click', () => { openManager(); platform.focusApp(); });
  } else {
    tray.setImage(image);
  }
  refreshTrayMenu();
}

// 会议模式：一键隐藏全部桌宠（窗口 hide + 渲染循环 power-pause）。
// 这是主进程显式的瞬态状态，不写入 settings；解锁屏幕时的 power-resume
// 会尊重它（保持隐藏就保持暂停）。
let allPetsHiddenByUser = false;

function hideAllPets() {
  allPetsHiddenByUser = true;
  for (const p of pets) {
    // 只暂停已过首帧确认的：pre-ack 的渲染必须继续，watchdog/ack 语义不变
    if (p.isFirstFrameLive()) p.send(CH.PET_COMMAND, { action: 'power-pause' });
    try { p.win?.hide(); } catch { /* 窗口销毁竞态 */ }
  }
  refreshTrayMenu();
}

function showAllPets() {
  allPetsHiddenByUser = false;
  for (const p of pets) {
    try { p.win?.show(); } catch { /* 窗口销毁竞态 */ }
    p.send(CH.PET_COMMAND, { action: 'power-resume' });
  }
  refreshTrayMenu();
}

function diagnosticsText() {
  const os = require('node:os');
  return [
    `Poppet v${app.getVersion()}`,
    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`,
    `${process.platform} ${os.release()} ${process.arch}`,
    `pets on screen: ${pets.length}`,
  ].join('\n');
}

function showAboutDialog() {
  const detail = `${diagnosticsText()}\n\nPoppet 本体永久免费。代码采用 PolyForm Noncommercial 1.0.0，禁止商用。随包美术单独采用 Poppet 非商业美术许可，禁止商用（见 ASSETS_LICENSE.md）。`;
  void dialog.showMessageBox({
    type: 'info',
    title: '关于 Poppet',
    message: `Poppet v${app.getVersion()}`,
    detail,
    buttons: ['关闭', '复制诊断信息'],
    defaultId: 0,
    cancelId: 0,
  }).then(({ response }) => {
    if (response === 1) clipboard.writeText(diagnosticsText());
  });
}

// 托盘与"右键桌宠"共用同一份菜单模板：两个入口必须永远一致，
// 绝不出现各自漂移的两套菜单。
function buildMenuTemplate() {
  const settings = lib.getSettings();
  const characters = lib.listCharacters();

  const onScreen = new Set(pets.map(p => p.characterId));
  const full = pets.length >= lib.MAX_PETS;

  return [
    { label: pets.length ? `屏幕上 ${pets.length} 只` : '尚未选择角色', enabled: false },
    { type: 'separator' },
    {
      // 勾选式而不是单选：多只可以同时在屏幕上，勾一个就多一只，取消勾选就收起来
      label: '在屏幕上',
      enabled: characters.length > 0,
      submenu: characters.map(c => ({
        label: c.name + (c.hasFace ? '' : '（无表情）'),
        type: 'checkbox',
        checked: onScreen.has(c.id),
        // 已满时只允许取消勾选，不允许再加
        enabled: onScreen.has(c.id) || !full,
        click: () => { void togglePet(c.id); },
      })).concat(full ? [{ type: 'separator' }, { label: `最多同时 ${lib.MAX_PETS} 只`, enabled: false }] : []),
    },
    { label: '角色管理…', click: () => { openManager(); platform.focusApp(); } },
    { type: 'separator' },
    {
      label: '大小',
      submenu: [
        ['小', 0.35], ['中', 0.5], ['大', 0.7], ['特大', 1.0],
      ].map(([label, scale]) => ({
        label, type: 'radio', checked: Math.abs(settings.scale - scale) < 0.01,
        click: () => applySettings({ scale }),
      })),
    },
    { label: '自己溜达', type: 'checkbox', checked: settings.wander, click: (i) => applySettings({ wander: i.checked }) },
    { label: '空白处点击穿透', type: 'checkbox', checked: settings.clickThrough, click: (i) => applySettings({ clickThrough: i.checked }) },
    ...(platform.loginItemSupported() ? [{
      label: '开机自动启动',
      type: 'checkbox',
      checked: platform.getLoginItemEnabled(),
      click: (i) => {
        platform.setLoginItemEnabled(i.checked);
        refreshTrayMenu();
        notifyLibChanged(); // Manager 的自启行随 refresh 重读系统真相
      },
    }] : []),
    {
      label: '隐藏全部桌宠（会议模式）',
      type: 'checkbox',
      checked: allPetsHiddenByUser,
      enabled: pets.length > 0 || allPetsHiddenByUser,
      click: (i) => { if (i.checked) hideAllPets(); else showAllPets(); },
    },
    { type: 'separator' },
    { label: '都打个招呼', click: () => { for (const p of pets) p.send(CH.PET_COMMAND, { action: 'greet' }); } },
    { label: '都回到屏幕右下角', click: () => { for (const p of pets) p.placeInitial(null); persistPets(); } },
    { type: 'separator' },
    { label: `关于 Poppet（v${app.getVersion()}）…`, click: showAboutDialog },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

// 勾上就多一只，取消就收起来。返回它现在在不在屏幕上。
async function togglePet(id) {
  if (petOf(id)) {
    despawnPet(id);
  } else {
    // 用户点名要看某只：会议模式显然结束了
    if (allPetsHiddenByUser) showAllPets();
    const result = await ensurePetReady(id);
    if (!result.ready) return false;
  }
  persistPets();
  lib.setSettings({ activeId: pets[0]?.characterId || null });  // 只为旧字段兼容；品牌托盘不跟角色走
  buildTray();
  notifyLibChanged();
  return !!petOf(id);
}

function updatePetRoster() {
  persistPets();
  lib.setSettings({ activeId: pets[0]?.characterId || null });
  buildTray();
  notifyLibChanged();
}

// 幂等 spawn-only：已经显示就只等待它的首帧；失败只清理这一实例。
// 角色数据每次从 library 重读，确保 renderer 收到的是 durable rename 后的 exact bytes。
async function ensurePetReady(id, timeoutMs = 5000, includeTiming = false) {
  // 让某只宠"就绪并显示"与会议模式互斥：导入/放出/重试任何一条路走到
  // 这里，说明用户此刻想看到桌宠——先整体退出隐藏，托盘勾选保持诚实，
  // 也避免新生宠独自可见、解锁恢复却被会议标志拦下的"可见但冻结"状态。
  if (allPetsHiddenByUser) showAllPets();
  let p = null;
  let spawnedHere = false;
  try {
    p = petOf(id);
    if (!p) {
      if (pets.length >= lib.MAX_PETS) {
        return spawnFailure(id, 'POPPET_MAX_PETS', `最多同时显示 ${lib.MAX_PETS} 只桌宠`);
      }
      const c = lib.loadCharacter(id);
      if (!c) return spawnFailure(id, 'POPPET_CHARACTER_LOAD_FAILED', '已保存的角色无法读取');
      p = spawnPet(c, null, timeoutMs);
      spawnedHere = true;
      if (!p) return spawnFailure(id, 'POPPET_PET_WINDOW_CREATE_FAILED', '桌宠窗口创建失败');
    }
    const firstFrame = await p.waitForFirstFrame(timeoutMs);
    if (!pets.includes(p) || !p.isFirstFrameLive()) {
      throw Object.assign(new Error('桌宠窗口在确认返回前不可用'), { code: 'POPPET_PET_NOT_LIVE' });
    }
    try {
      updatePetRoster();
    } catch (error) {
      if (spawnedHere) despawnPetInstance(p);
      try { updatePetRoster(); } catch {}
      return spawnFailure(id, 'POPPET_PET_ROSTER_UPDATE_FAILED', '桌宠已画出首帧，但状态同步失败；可以重试显示');
    }
    return {
      ready: true,
      persistedId: id,
      ...(includeTiming ? {
        timing: { T5: firstFrame.readyAt, visibleAt: firstFrame.visibleAt, clock: 'main-performance' },
      } : {}),
    };
  } catch (error) {
    let cleanupCode = null;
    try { despawnPetInstance(p); } catch { cleanupCode = 'POPPET_PET_CLEANUP_FAILED'; }
    try { updatePetRoster(); } catch { cleanupCode ||= 'POPPET_PET_ROSTER_UPDATE_FAILED'; }
    return spawnFailure(id, stablePoppetCode(error, 'POPPET_PET_FIRST_FRAME_FAILED'),
      '桌宠未能显示首帧；角色已保存，可以重试显示。', cleanupCode);
  }
}

function spawnFailure(id, errorCode, message, cleanupCode = null) {
  return {
    ready: false,
    persistedId: id || null,
    failureClass: 'SPAWN_FAILURE',
    errorCode,
    ...(cleanupCode ? { cleanupCode } : {}),
    message,
  };
}

function persistenceFailure(id, errorCode, message, recoveryMode) {
  return {
    ready: false,
    persisted: false,
    persistedId: id || null,
    failureClass: 'PERSISTENCE_FAILURE',
    errorCode,
    recoveryMode,
    message,
  };
}

function stablePoppetCode(error, fallback) {
  return typeof error?.code === 'string' && /^POPPET_[A-Z0-9_]+$/.test(error.code)
    ? error.code : fallback;
}

// 保留给内部调用者的「保存并使用」语义，但完成值现在表示首帧已确认。
async function addPet(id) {
  const result = await ensurePetReady(id);
  return result.ready;
}

function notifyLibChanged() {
  const mgr = getManagerWindow();
  if (!mgr || mgr.isDestroyed()) return false;
  const contents = mgr.webContents;
  if (!contents || contents.isDestroyed()) return false;
  try {
    contents.send(CH.LIB_CHANGED);
    return true;
  } catch (error) {
    // 通知是 best-effort：Manager 关闭与主进程完成 T5/T6 的回程可能并发，
    // renderer teardown 绝不能反向撤销已经首帧成功并持久化的桌宠。
    if (DEV) console.warn('[library] Manager unavailable during refresh:', error?.message || error);
    return false;
  }
}

function applySettings(patch) {
  const next = lib.setSettings(patch);
  // 大小是全局设置，每只都要按**自己的**精灵尺寸重算窗口，不能共用一个尺寸
  for (const p of pets) {
    if (patch.scale !== undefined) p.resize(next.scale, spriteSizeOf(p.character));
    p.send(CH.PET_SETTINGS, next);
  }
  if (patch.scale !== undefined) persistPets();
  refreshTrayMenu();
  notifyLibChanged();
}

// ---------------- IPC：桌宠窗口 ----------------

const MANAGER_HTML = path.join(__dirname, '../renderer/manager/index.html');
const PET_HTML = path.join(__dirname, '../renderer/pet/index.html');

function trustedManagerEvent(event) {
  const win = getManagerWindow();
  if (!win) throw new Error('管理窗口不可用');
  assertTrustedIpcFrame(event, win.webContents, MANAGER_HTML);
  return win;
}

function managerMeasurementEnabled(event) {
  try {
    const params = new URL(event.senderFrame?.url || '').searchParams;
    return params.get('poppetDev') === '1' || params.get('measurement') === '1';
  } catch {
    return false;
  }
}

function trustedPetEvent(event) {
  const pet = petFromEvent(event);
  if (!pet) throw new Error('桌宠窗口不可用');
  assertTrustedIpcFrame(event, pet.win.webContents, PET_HTML);
  return pet;
}

// 下面每一个都必须按 event.sender 找回是哪一只。
// 拿全局的"当前那只"在单只时看不出问题，多只同屏时就是拖 B 却动 A。
ipcMain.handle(CH.PET_READY, (e, ...args) => {
  const pet = trustedPetEvent(e);
  noArguments(args);
  return { character: pet.character || null, settings: lib.getSettings() };
});

ipcMain.handle(CH.PET_FRAME_READY, (e, ...args) => {
  const pet = trustedPetEvent(e);
  noArguments(args);
  // T5 在 main 收到 trusted、无参数、属于 exact PetWindow 的首次 ack 时打点。
  return pet.markFirstFrameReady();
});

ipcMain.on(CH.PET_SET_INTERACTIVE, safeIpcListener(CH.PET_SET_INTERACTIVE, (e, ...args) => {
  const pet = trustedPetEvent(e);
  const on = oneArgument(args, (value) => validateBoolean(value, 'interactive'));
  const s = lib.getSettings();
  // 关掉穿透就一直保持可交互，省得每帧来回切
  pet.setInteractive(s.clickThrough ? on : true);
}));

ipcMain.on(CH.PET_DRAG_START, safeIpcListener(CH.PET_DRAG_START,
  (e, ...args) => { noArguments(args); trustedPetEvent(e).startDrag(); }));
ipcMain.on(CH.PET_DRAG_END, safeIpcListener(CH.PET_DRAG_END, (e, ...args) => {
  noArguments(args);
  const p = trustedPetEvent(e);
  p.endDrag();
  persistPets();   // 只有它的槽位会变，其余照抄当前窗口位置
}));
ipcMain.handle(CH.PET_MOVE_BY, (e, ...args) => {
  const pet = trustedPetEvent(e);
  const { dx, dy } = oneArgument(args, validateMove);
  return pet.moveBy(dx, dy) ?? null;
});
ipcMain.handle(CH.PET_GET_BOUNDS, (e, ...args) => {
  noArguments(args);
  return trustedPetEvent(e).bounds() ?? null;
});
ipcMain.on(CH.PET_CONTEXT_MENU, safeIpcListener(CH.PET_CONTEXT_MENU, (e, ...args) => {
  noArguments(args);
  const p = trustedPetEvent(e);
  // popup 默认锚定当前光标：右键哪里菜单就出现在哪里。
  // 此前无参调用 tray.popUpContextMenu() 在 macOS 会把菜单弹到屏幕顶端
  // 的托盘图标处，右键桌宠看起来像"没反应"。
  Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: p.win });
}));
ipcMain.on(CH.PET_LOG, safeIpcListener(CH.PET_LOG, (e, ...args) => {
  const msg = oneArgument(args, validateLog);
  const p = trustedPetEvent(e);
  if (!DEV) return;
  console.log('[pet' + (pets.length > 1 && p ? ':' + p.characterId : '') + ']', msg);
}));

// ---------------- IPC：角色库 ----------------

ipcMain.handle(CH.LIB_LIST, (e, ...args) => {
  trustedManagerEvent(e);
  noArguments(args);
  return {
    characters: lib.listCharacters().map(c => ({ ...c, onScreen: !!petOf(c.id) })),
    settings: lib.getSettings(),
    maxPets: lib.MAX_PETS,
  };
});

ipcMain.handle(CH.FLOW_CLOCK, (e, ...args) => {
  trustedManagerEvent(e);
  noArguments(args);
  if (!managerMeasurementEnabled(e)) {
    throw Object.assign(new Error('计时接口仅在显式开发或测量会话中可用'), {
      code: 'POPPET_MEASUREMENT_DISABLED',
    });
  }
  return { mainNow: performance.now(), clock: 'main-performance' };
});

// LIB_IMPORT 与 PACK_IMPORT 共用的导入完成路径：持久化、durability 恢复、
// 以及等待首帧真实渲染的激活语义在两个入口之间必须完全一致。
async function completeImport(payload, measurement, T3) {
  if (payload.activate !== false && pets.length >= lib.MAX_PETS) {
    return {
      ...spawnFailure(null, 'POPPET_MAX_PETS', `最多同时显示 ${lib.MAX_PETS} 只桌宠`),
      persisted: false,
      ...(measurement ? { timing: { T3, clock: 'main-performance' } } : {}),
    };
  }
  let id;
  try {
    id = lib.importCharacter(payload);
  } catch (error) {
    if (DEV) console.error('[library] 导入持久化失败:', error);
    if (error?.persistedId) {
      return {
        id: error.persistedId,
        published: true,
        ...persistenceFailure(error.persistedId,
          stablePoppetCode(error, 'POPPET_IMPORT_DURABILITY_UNCONFIRMED'),
          '角色文件已完整写入，但持久化确认尚未完成；可以安全重试确认。',
          'finalize-import'),
        ...(measurement ? { timing: { T3, clock: 'main-performance' } } : {}),
      };
    }
    return {
      ...persistenceFailure(null, stablePoppetCode(error, 'POPPET_IMPORT_FAILED'),
        '角色保存失败；草稿仍保留，可以重试创建。', 'reimport'),
      ...(measurement ? { timing: { T3, clock: 'main-performance' } } : {}),
    };
  }
  const T4 = measurement ? performance.now() : null;
  if (payload.activate === false) {
    try { buildTray(); } catch (error) {
      return {
        id, persistedId: id, persisted: true,
        ...spawnFailure(id, 'POPPET_PET_ROSTER_UPDATE_FAILED', '角色已保存，但桌宠列表刷新失败'),
        ...(measurement ? { timing: { T3, T4, clock: 'main-performance' } } : {}),
      };
    }
    return {
      id, persistedId: id, persisted: true, ready: true,
      ...(measurement ? { timing: { T3, T4, T5: null, clock: 'main-performance' } } : {}),
    };
  }
  let activation;
  try {
    activation = await ensurePetReady(id, 5000, measurement);
  } catch (error) {
    if (DEV) console.error('[pet] 持久化后激活意外失败:', error);
    activation = spawnFailure(id, stablePoppetCode(error, 'POPPET_PET_SPAWN_FAILED'),
      '角色已经安全保存，但桌宠未能显示；可以重试显示。');
  }
  return {
    id, persistedId: id, persisted: true,
    ...activation,
    ...(measurement ? {
      timing: { T3, T4, ...(activation.timing || {}), clock: 'main-performance' },
    } : {}),
  };
}

ipcMain.handle(CH.LIB_IMPORT, async (e, ...args) => {
  trustedManagerEvent(e);
  const measurement = managerMeasurementEnabled(e);
  const T3 = measurement ? performance.now() : null;
  const payload = oneArgument(args, validateImportPayload);
  return completeImport(payload, measurement, T3);
});

// 对话框导入与拖放导入共用的按路径导入管线：有界读取 -> parsePoppetpack
// -> validateImportPayload -> completeImport，全部入口一条 fail-closed 路。
async function importPackFromPath(filePath) {
  let payload;
  try {
    const bytes = readRegularFileLimitedSync(
      filePath, PACK_LIMITS.MAX_ARCHIVE_BYTES, '角色包');
    const parsed = parsePoppetpack(bytes);
    const candidate = { meta: parsed.meta, files: parsed.files };
    if (parsed.name !== undefined) candidate.name = parsed.name;
    // 屏幕满员时仍要完成持久化（activate:false），别让用户选完文件后
    // 整个导入被丢弃；普通图片导入在 Manager 侧有同款前置闸门。
    if (pets.length >= lib.MAX_PETS) candidate.activate = false;
    payload = validateImportPayload(candidate);
  } catch (error) {
    if (DEV) console.error('[pack] 角色包解析失败:', error);
    return {
      ready: false, persisted: false, persistedId: null,
      failureClass: 'PACK_VALIDATION_FAILURE',
      errorCode: stablePoppetCode(error, 'POPPET_PACK_INVALID'),
      message: '角色包未通过校验，已原样拒绝。',
    };
  }
  const result = await completeImport(payload, false, null);
  if (payload.activate === false && result?.persisted) {
    return { ...result, spawnSkipped: true };
  }
  return result;
}

ipcMain.handle(CH.PACK_IMPORT, async (e, ...args) => {
  const win = trustedManagerEvent(e);
  noArguments(args);
  const res = await dialog.showOpenDialog(win ?? undefined, {
    title: '选择一个 Poppet 角色包',
    filters: [{ name: 'Poppet 角色包', extensions: ['poppetpack'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return importPackFromPath(res.filePaths[0]);
});

ipcMain.handle(CH.PACK_IMPORT_PATH, async (e, ...args) => {
  trustedManagerEvent(e);
  const filePath = oneArgument(args, (value) => {
    if (typeof value !== 'string' || !value || value.length > 4096
        || !value.toLowerCase().endsWith('.poppetpack')) {
      throw new Error('角色包路径无效');
    }
    return value;
  });
  return importPackFromPath(filePath);
});

ipcMain.handle(CH.LOGIN_ITEM_GET, (e, ...args) => {
  trustedManagerEvent(e);
  noArguments(args);
  return {
    supported: platform.loginItemSupported(),
    enabled: platform.getLoginItemEnabled(),
  };
});

ipcMain.handle(CH.LOGIN_ITEM_SET, (e, ...args) => {
  trustedManagerEvent(e);
  const enabled = oneArgument(args, (value) => {
    if (typeof value !== 'boolean') throw new Error('开机自启开关必须是布尔值');
    return value;
  });
  platform.setLoginItemEnabled(enabled);
  refreshTrayMenu();
  return {
    supported: platform.loginItemSupported(),
    enabled: platform.getLoginItemEnabled(),
  };
});

ipcMain.handle(CH.PACK_EXPORT, async (e, ...args) => {
  const win = trustedManagerEvent(e);
  const id = oneArgument(args, assertCharacterId);
  let archive;
  try {
    archive = buildPoppetpack(lib.characterExportBundle(id));
  } catch (error) {
    if (DEV) console.error('[pack] 导出组包失败:', error);
    // 把真实原因带给用户：损坏、已被删除、缺 icon、旧格式、内置角色各是不同的
    // 可行动信息，压成一句"未通过校验"会误导排查方向。POPPET_PACK_NOT_EXPORTABLE
    // 的 message 本身已是完整的中文说明（与 Manager 列表里的禁用态提示同源）。
    return {
      exported: false,
      errorCode: stablePoppetCode(error, 'POPPET_PACK_EXPORT_FAILED'),
      message: error?.code === 'POPPET_PACK_BUILTIN_FORBIDDEN'
        ? '内置品牌角色不允许导出为角色包。'
        : error?.code === 'POPPET_PACK_NOT_EXPORTABLE'
          ? `${error.message}。`
          : `导出失败：${error?.message || '角色数据未通过校验'}`,
    };
  }
  const res = await dialog.showSaveDialog(win ?? undefined, {
    title: '导出角色包',
    defaultPath: `${id}.poppetpack`,
    filters: [{ name: 'Poppet 角色包', extensions: ['poppetpack'] }],
  });
  if (res.canceled || !res.filePath) return null;
  try {
    // 合约要求的导出落盘方式：临时文件 + fsync + rename。
    atomicReplaceFileSync(res.filePath, archive, 0o644);
  } catch (error) {
    if (DEV) console.error('[pack] 导出写入失败:', error);
    return { exported: false, errorCode: 'POPPET_PACK_WRITE_FAILED',
      message: '角色包写入失败，目标文件未被替换。' };
  }
  return { exported: true, path: res.filePath };
});

ipcMain.handle(CH.LIB_FINALIZE_IMPORT, async (e, ...args) => {
  trustedManagerEvent(e);
  const measurement = managerMeasurementEnabled(e);
  const id = oneArgument(args, assertCharacterId);
  let T4;
  try {
    lib.finalizeImportedCharacter(id);
    if (measurement) T4 = performance.now();
  } catch (error) {
    if (DEV) console.error('[library] finalize import 失败:', error);
    const errorCode = stablePoppetCode(error, 'POPPET_IMPORT_DURABILITY_UNCONFIRMED');
    const terminalRecovery = ['POPPET_IMPORT_RECOVERY_MISSING', 'POPPET_IMPORT_RECOVERY_INVALID'].includes(errorCode);
    return {
      id, published: true,
      ...persistenceFailure(id, errorCode,
        terminalRecovery
          ? '待确认角色已丢失或损坏；请选择原图重新创建。'
          : '角色文件仍未完成持久化确认；可以再次重试。',
        terminalRecovery ? 'manual-recovery' : 'finalize-import'),
      ...(measurement ? { timing: { clock: 'main-performance' } } : {}),
    };
  }
  let activation;
  try {
    activation = await ensurePetReady(id, 5000, measurement);
  } catch (error) {
    activation = spawnFailure(id, stablePoppetCode(error, 'POPPET_PET_SPAWN_FAILED'),
      '角色已经安全保存，但桌宠未能显示；可以重试显示。');
  }
  return {
    id, persistedId: id, persisted: true, ...activation,
    ...(measurement ? {
      timing: { T4, ...(activation.timing || {}), clock: 'main-performance' },
    } : {}),
  };
});

ipcMain.handle(CH.LIB_DELETE, (e, ...args) => {
  trustedManagerEvent(e);
  const id = oneArgument(args, assertCharacterId);
  lib.deleteCharacter(id);
  // 被删的角色如果正在屏幕上，那只窗口必须一起收掉——
  // 素材都没了还留着窗口，它会拿着已经不存在的角色继续跑
  despawnPet(id);
  persistPets();
  lib.setSettings({ activeId: pets[0]?.characterId || null });
  buildTray();
  return true;
});

// 从管理界面点某个角色：在屏幕上就收起来，不在就放出来
ipcMain.handle(CH.LIB_ACTIVATE, (e, ...args) => {
  trustedManagerEvent(e);
  return togglePet(oneArgument(args, assertCharacterId));
});

ipcMain.handle(CH.LIB_ENSURE_ACTIVE, async (e, ...args) => {
  trustedManagerEvent(e);
  const id = oneArgument(args, assertCharacterId);
  return ensurePetReady(id, 5000, managerMeasurementEnabled(e));
});

ipcMain.handle(CH.LIB_LOAD, (e, ...args) => {
  trustedManagerEvent(e);
  return lib.loadCharacter(oneArgument(args, assertCharacterId));
});

ipcMain.handle(CH.LIB_UPDATE_META, (e, ...args) => {
  trustedManagerEvent(e);
  const { id, patch } = oneArgument(args, validateMetadataUpdate);
  lib.updateCharacterMeta(id, patch);
  // 改的角色正在屏幕上，就地下发新数据给**那一只**，用户不必重启就能看到
  const p = petOf(id);
  if (p) {
    p.character = lib.loadCharacter(id);
    p.send(CH.PET_CHARACTER, p.character);
    p.resize(lib.getSettings().scale, spriteSizeOf(p.character));
  }
  buildTray();
  return true;
});

ipcMain.handle(CH.LIB_PICK_FILE, async (e, ...args) => {
  const win = trustedManagerEvent(e);
  const measurement = managerMeasurementEnabled(e);
  noArguments(args);
  const res = await dialog.showOpenDialog(win ?? undefined, {
    title: '选择一张角色立绘',
    filters: [{ name: '图片', extensions: ['png', 'gif', 'webp', 'jpg', 'jpeg', 'bmp'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const T0 = measurement ? performance.now() : null;
  const file = res.filePaths[0];
  const bytes = readRegularFileLimitedSync(file, LIMITS.MAX_FILE_BYTES, '图片');
  const probe = probeImageDimensions(bytes);
  assertImageBudget(probe.width, probe.height, probe.frameCount ?? 1);
  return {
    name: path.basename(file, path.extname(file)).slice(0, 100),
    dataURL: `data:${probe.mime};base64,` + bytes.toString('base64'),
    width: probe.width,
    height: probe.height,
    size: bytes.length,
    mime: probe.mime,
    ...(measurement ? { timing: { T0, clock: 'main' } } : {}),
  };
});

ipcMain.handle(CH.SETTINGS_GET, (e, ...args) => {
  trustedManagerEvent(e);
  noArguments(args);
  return lib.getSettings();
});
ipcMain.handle(CH.SETTINGS_SET, (e, ...args) => {
  trustedManagerEvent(e);
  applySettings(oneArgument(args, validateSettingsPatch));
  return lib.getSettings();
});

module.exports = { refreshTrayMenu, importPackFromPath };

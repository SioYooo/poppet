'use strict';
// 开发期的自动截图与动作演示。桌宠窗口是透明无边框的，肉眼之外很难核对渲染，
// 这里按脚本依次触发每个动作并抓帧，就能离线看出哪一步不对。
//
//   npm run dev -- --capture <目录>                 定时抓几帧
//   npm run dev -- --capture <目录> --demo          按脚本走完所有动作再退出
//   npm run dev -- --capture-manager <目录> --capture-manager-source <图片>
//
// 只在 --dev 下加载，不进生产路径。

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { CH } = require('./channels');

// [动作, 触发后等待毫秒, 抓几帧, 帧间隔毫秒]
// 眨眼和落地都很快，必须小间隔连拍才抓得到中间过程。
const DEMO_SCRIPT = [
  ['idle', 300, 1, 0],
  ['blink', 0, 16, 20],   // 眨眼 0.32s，20ms 一帧才数得清中间帧
  ['hop', 0, 6, 90],
  ['drag', 200, 2, 120],
  ['land', 0, 6, 80],
  ['greet', 0, 7, 130],
  ['walk', 0, 10, 70],    // 步频 0.52s，70ms 一帧刚好覆盖一个完整步周期
  ['idle', 200, 1, 0],
];

function startCapture(pet, opts) {
  const { dir, delay, shots, interval, demo } = opts;
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;

  const shoot = async (tag) => {
    if (!pet?.win || pet.win.isDestroyed()) return false;
    try {
      const image = await pet.win.webContents.capturePage();
      const file = path.join(dir, `${String(n).padStart(2, '0')}-${tag}.png`);
      fs.writeFileSync(file, image.toPNG());
      const b = pet.bounds();
      // 顺手把姿态数值也打出来——透明窗口里看不出哪一项在动，有数才好调
      let pose = '';
      try {
        const p = await pet.win.webContents.executeJavaScript('window.__poppetDev && window.__poppetDev.pose()');
        if (p) pose = ` sway=${p.sway.toFixed(2)} dy=${p.offsetY.toFixed(1)} sy=${p.scaleY.toFixed(3)} rot=${p.rotate.toFixed(3)}`;
      } catch {}
      console.log(`[capture] ${path.basename(file)} pos=${b.x},${b.y}${pose}`);
      n++;
      return true;
    } catch (err) {
      console.error('[capture] 失败: ' + err.message);
      return false;
    }
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const run = async () => {
    await sleep(delay);
    if (demo) {
      for (const [action, wait, count, gap] of DEMO_SCRIPT) {
        pet.send(CH.PET_COMMAND, { action });
        if (wait) await sleep(wait);
        for (let i = 0; i < count; i++) {
          if (!await shoot(action)) return app.quit();
          if (gap) await sleep(gap);
        }
      }
    } else {
      for (let i = 0; i < shots; i++) {
        if (!await shoot('shot')) return app.quit();
        if (i < shots - 1) await sleep(interval);
      }
    }
    console.log(`[capture] 共 ${n} 帧 -> ${dir}`);
    app.quit();
  };

  run();
}

// 管理窗口的自动化核对：截初始态，再把一张图喂进导入流程，截处理结果。
async function captureManager(openManager, dir, sourcePngPath) {
  fs.mkdirSync(dir, { recursive: true });
  const win = openManager();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const shoot = async (tag) => {
    const image = await win.webContents.capturePage();
    const file = path.join(dir, tag + '.png');
    fs.writeFileSync(file, image.toPNG());
    console.log('[manager] ' + path.basename(file));
  };

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[manager-renderer] ${message}  (${String(source).split('/').pop()}:${line})`);
  });

  await new Promise(r => win.webContents.once('did-finish-load', r));
  await sleep(900);
  await shoot('1-列表');

  if (sourcePngPath && fs.existsSync(sourcePngPath)) {
    const dataURL = 'data:image/png;base64,' + fs.readFileSync(sourcePngPath).toString('base64');
    const res = await win.webContents.executeJavaScript(
      `window.__poppetDev.startDraft(${JSON.stringify(dataURL)}, '测试角色')
         .then(() => { const d = window.__poppetDev.getDraft();
           return { ok: !!d?.result, parts: (d?.result?.meta?.parts || []).map(x => x.role),
                    warnings: d?.result?.report?.warnings || [] }; })
         .catch(e => ({ ok: false, error: String(e && e.message || e) }))`);
    console.log('[manager] 导入结果 ' + JSON.stringify(res));
    await sleep(700);
    await shoot('2-处理结果');

    // 眨眼预览必须真的只改眼框内部。这个像素级 smoke 会同时抓住：
    // 按钮没接线、动画没画出来，以及框外的耳朵/镜框被误擦除。
    const blink = await win.webContents.executeJavaScript(`(async () => {
      const canvas = document.getElementById('preview');
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      document.getElementById('btn-toggle-boxes').click();
      await new Promise(r => setTimeout(r, 50));
      const before = cx.getImageData(0, 0, canvas.width, canvas.height).data;
      const eyes = window.__poppetDev.getDraft().result.meta.parts.filter(p => p.role === 'eye');
      document.getElementById('btn-play-blink').click();
      await new Promise(r => setTimeout(r, 250));
      const during = cx.getImageData(0, 0, canvas.width, canvas.height).data;
      let inside = 0, outside = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        let changed = false;
        for (let c = 0; c < 4; c++) if (before[i + c] !== during[i + c]) { changed = true; break; }
        if (!changed) continue;
        const inEye = eyes.some(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
        if (inEye) inside++; else outside++;
      }
      return {
        eyes: eyes.map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h, src: p.src })),
        inside, outside,
        hint: document.getElementById('preview-hint').textContent,
      };
    })()`);
    const blinkOk = blink.eyes.length > 0 && blink.inside > 0 && blink.outside === 0
      && blink.hint.includes('正在检查');
    console.log(`[manager] ${blinkOk ? '✓' : '✗'} 眨眼预览只改眼框内部 ${JSON.stringify(blink)}`);
    await shoot('2b-眨眼检查');
    await sleep(650);

    // 走完最后一步：保存 -> IPC -> 落盘 -> 切换角色。这是"任何人传图"这条链的终点。
    const saved = await win.webContents.executeJavaScript(
      `window.__poppetDev.save().then(() => ({ ok: true })).catch(e => ({ ok: false, error: String(e && e.message || e) }))`);
    await sleep(600);
    const dir2 = path.join(app.getPath('userData'), 'characters');
    const ids = fs.existsSync(dir2) ? fs.readdirSync(dir2) : [];
    console.log('[manager] 保存结果 ' + JSON.stringify(saved) + ' 角色库=' + JSON.stringify(ids));
    for (const id of ids) {
      const files = fs.readdirSync(path.join(dir2, id));
      console.log('           ' + id + ' -> ' + files.join(', '));
    }
    await shoot('3-保存后');

    // 错误路径：喂一张全透明图，管线会抛错，界面必须退回拖放区而不是停在空白编辑器
    const errCase = await win.webContents.executeJavaScript(`(async () => {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const before = window.confirm; window.confirm = () => true;
      const alertBak = window.alert; let alerted = null; window.alert = (m) => { alerted = m; };
      try { await window.__poppetDev.startDraft(c.toDataURL('image/png'), '空图'); }
      finally { window.alert = alertBak; window.confirm = before; }
      return {
        alerted: !!alerted,
        dropzoneVisible: !document.getElementById('dropzone').classList.contains('hidden'),
        editorHidden: document.getElementById('editor').classList.contains('hidden'),
      };
    })()`);
    const ok = errCase.alerted && errCase.dropzoneVisible && errCase.editorHidden;
    console.log(`[manager] ${ok ? '✓' : '✗'} 处理失败时退回拖放区 ${JSON.stringify(errCase)}`);

    // 只改属性模式：打开已保存角色，改成悬浮，落盘后应当只动 rig
    const props = await win.webContents.executeJavaScript(`(async () => {
      const list = await window.poppet.list();
      const id = list.characters[0].id;
      await window.__poppetDev.openProps(id);
      document.getElementById('rig-motion').value = 'float';
      document.getElementById('rig-motion').dispatchEvent(new Event('change'));
      document.getElementById('rig-flip').checked = false;
      document.getElementById('rig-flip').dispatchEvent(new Event('change'));
      await window.__poppetDev.save();
      const after = await window.poppet.load(id);
      return { id, rig: after.meta.rig, hasSprite: !!after.spriteDataURL, parts: window.__poppetDev.roles(after.meta) };
    })()`);
    const rigOk = props.rig.motion === 'float' && props.rig.anchor === 'center'
      && props.rig.flip === false && props.hasSprite
      && props.parts.includes('eye') && props.parts.includes('mouth');
    console.log(`[manager] ${rigOk ? '✓' : '✗'} 只改属性不动图片 ${JSON.stringify(props)}`);
    await shoot('4-属性编辑');

    // 删除部件：自动检测的另一半是"认错了能不能撤"。
    // 之前只能重新框、不能删，把纽扣认成眼睛的角色只有整张图重来这一条路。
    const del = await win.webContents.executeJavaScript(`(async () => {
      await window.__poppetDev.startDraft(${JSON.stringify(dataURL)}, '删除测试');
      const before = window.__poppetDev.roles(window.__poppetDev.getDraft().result.meta);
      document.querySelector('[data-part="eye1"]').click();
      document.getElementById('btn-del-part').click();
      const marked = JSON.parse(JSON.stringify(window.__poppetDev.getDraft().features || null));
      await window.__poppetDev.process();
      const after = window.__poppetDev.roles(window.__poppetDev.getDraft().result.meta);
      return { before, after, marked };
    })()`);
    const delOk = del.before.filter(r => r === 'eye').length === 2
      && del.after.filter(r => r === 'eye').length === 1
      && del.after.includes('mouth')
      && del.marked && del.marked.eyes[1] === null;   // 留空洞而不是压实
    console.log(`[manager] ${delOk ? '✓' : '✗'} 删除认错的部件 ${JSON.stringify(del)}`);

    // 可动部件的「提名 + 确认」。用四足动物（有尾巴有腿）才测得到，
    // 用户那张立绘本来就没有附肢，提名恒为空。
    const quad = path.join(path.dirname(sourcePngPath), 'test-quadruped.png');
    if (fs.existsSync(quad)) {
      const quadURL = 'data:image/png;base64,' + fs.readFileSync(quad).toString('base64');
      const sug = await win.webContents.executeJavaScript(`(async () => {
        await window.__poppetDev.startDraft(${JSON.stringify(quadURL)}, '候选测试');
        const meta = () => window.__poppetDev.getDraft().result.meta;
        const before = (meta().suggestions || []).map(s => s.sublabel);
        const blockVisible = !document.getElementById('suggest-block').classList.contains('hidden');
        const rows = document.querySelectorAll('#suggest-list li').length;
        // 第一条点「是」，第二条点「不是」
        document.querySelectorAll('#suggest-list li')[0].querySelector('.btn-primary').click();
        const li = document.querySelectorAll('#suggest-list li');
        li[li.length - 1].querySelector('button:last-child').click();
        const confirmed = meta().parts.filter(p => p.role === 'appendage');
        // 重新处理：人点过的选择必须活下来
        await window.__poppetDev.process();
        const after = meta().parts.filter(p => p.role === 'appendage');
        return {
          before, blockVisible, rows,
          confirmed: confirmed.map(p => p.id + ':' + p.source),
          afterReprocess: after.map(p => p.id + ':' + p.source),
          suggestionsLeft: (meta().suggestions || []).length,
        };
      })()`);
      const sugOk = sug.before.includes('tail') && sug.blockVisible && sug.rows === sug.before.length
        && sug.confirmed.length === 1 && sug.confirmed[0].endsWith(':user')
        && sug.afterReprocess.length === 1 && sug.afterReprocess[0].endsWith(':user');
      console.log(`[manager] ${sugOk ? '✓' : '✗'} 可动部件提名+确认 ${JSON.stringify(sug)}`);
      await shoot('6-可动部件候选');
    }

    // sprite sheet 切分：喂一张 6 帧横排的图，按 6x1 切开应当变成 6 帧动画
    const sheetPath = sourcePngPath.replace(/[^/]+$/, '') + 'sheet.png';
    const sheetFile = fs.existsSync(sheetPath) ? sheetPath : null;
    if (sheetFile) {
      const dataURL2 = 'data:image/png;base64,' + fs.readFileSync(sheetFile).toString('base64');
      const sliced = await win.webContents.executeJavaScript(`(async () => {
        await window.__poppetDev.startDraft(${JSON.stringify(dataURL2)}, '帧动画');
        const before = window.__poppetDev.getDraft().result.meta;
        document.getElementById('grid-cols').value = '6';
        document.getElementById('grid-rows').value = '1';
        document.getElementById('btn-slice').click();
        await new Promise(r => setTimeout(r, 400));
        const d = window.__poppetDev.getDraft();
        return {
          guessedCols: document.getElementById('grid-cols').value,
          beforeFrames: before.frames,
          afterFrames: d.result.meta.frames,
          frameSize: d.result.meta.sprite,
          sheetWidth: d.result.sprite.width,
          // 这一步紧跟在"只改属性"之后，正好检验模式切换有没有残留状态
          propsOnlyCleared: !document.body.classList.contains('props-only'),
        };
      })()`);
      const sliceOk = sliced.afterFrames && sliced.afterFrames.count === 6
        && sliced.sheetWidth === sliced.afterFrames.count * sliced.frameSize.width
        && sliced.propsOnlyCleared;
      console.log(`[manager] ${sliceOk ? '✓' : '✗'} sheet 切分 ${JSON.stringify(sliced)}`);
      await shoot('5-帧动画');
    }
  }
  app.quit();
}

async function waitForManagerHooks(win, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await win.webContents.executeJavaScript('!!window.__poppetDev?.startDraft')) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('manager development hooks did not become ready');
}

async function waitForPetDevEvidence(pet, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pet?.win || pet.win.isDestroyed()) break;
    try {
      const evidence = await pet.win.webContents.executeJavaScript(`(() => ({
        id: window.__poppetDev?.charId?.() || null,
        sourceDataURL: window.__poppetDev?.sourceDataURL?.() || null,
        atlasDataURL: window.__poppetDev?.atlasDataURL?.() || null,
        meta: window.__poppetDev?.meta?.() || null,
        frameReady: window.__poppetDev?.frameReady?.() === true,
      }))()`);
      if (evidence.id && evidence.sourceDataURL && evidence.frameReady) return evidence;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('pet development first-frame evidence did not become ready');
}

function metaContainsExact(actual, expected) {
  if (!actual || !expected) return false;
  return Object.keys(expected).every(key => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
}

function withSmokeDeadline(promise, label, timeoutMs = 20_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function testManager({ openManager, lib, pets, spawnPet, despawnPet, sourcePath, artifactDir, importPackFromPath }) {
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('manager smoke source must be a regular file');
  const sourceDataURL = 'data:image/png;base64,' + fs.readFileSync(sourcePath).toString('base64');
  fs.mkdirSync(artifactDir, { recursive: true });

  const beforeCharacters = lib.listCharacters().length;
  const beforePets = pets().length;
  let win = openManager();
  await waitForManagerHooks(win);
  const results = [];
  const check = (name, condition, detail) => {
    results.push(Boolean(condition));
    console.log(`[manager-test] ${condition ? '✓' : '✗'} ${name} ${JSON.stringify(detail)}`);
  };
  const capture = async (name) => {
    await win.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const image = await win.webContents.capturePage();
    const output = path.join(artifactDir, name);
    fs.writeFileSync(output, image.toPNG());
    console.log(`[manager-test] 截帧 ${path.relative(process.cwd(), output)}`);
  };

  // Cold restore has no Manager IPC waiter. A sprite decode failure must be
  // reaped by spawnPet's own first-frame watchdog without touching live siblings.
  const coldBaseSummary = lib.listCharacters()[0] || null;
  const coldBase = coldBaseSummary ? lib.loadCharacter(coldBaseSummary.id) : null;
  const coldPet = coldBase ? spawnPet({
    ...coldBase,
    id: 'cold-restore-watchdog-smoke',
    spriteDataURL: 'data:image/png;base64,AAAA',
  }, { x: 0, y: 0 }, 250) : null;
  const coldWindow = coldPet?.win || null;
  const coldDeadline = Date.now() + 2500;
  while (coldPet && pets().includes(coldPet) && Date.now() < coldDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  check('冷恢复空白窗口由首帧 watchdog 精确清槽且不影响其它桌宠',
    !!coldPet
      && !pets().includes(coldPet)
      && (!coldWindow || coldWindow.isDestroyed())
      && pets().length === beforePets,
    {
      spawned: !!coldPet,
      removed: !!coldPet && !pets().includes(coldPet),
      destroyed: !coldWindow || coldWindow.isDestroyed(),
      petDelta: pets().length - beforePets,
    });

  const accessibleRecovery = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const cx = canvas.getContext('2d');
    cx.fillStyle = '#222';
    cx.fillRect(8, 4, 16, 24);
    await window.__poppetDev.startDraft(canvas.toDataURL('image/png'), 'Accessible Recovery Smoke');
    const initialState = window.__poppetDev.flowState()?.state || null;
    if (initialState === 'needs-review') document.getElementById('readiness-action').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const blockIds = ['pixelize-block', 'expression-block', 'frames-block', 'rig-block',
      'preview-controls-block', 'diagnostics-block'];
    const scopedVisible = blockIds.filter(id =>
      getComputedStyle(document.getElementById(id)).display !== 'none');
    const targeted = document.body.classList.contains('targeted-recovery');
    const focused = document.activeElement?.id || null;
    const size = window.__poppetDev.getDraft()?.result?.meta?.sprite;
    const setRect = (x, y, w, h) => {
      document.getElementById('rect-part').value = 'eye0';
      document.getElementById('rect-x').value = x;
      document.getElementById('rect-y').value = y;
      document.getElementById('rect-w').value = w;
      document.getElementById('rect-h').value = h;
    };
    setRect(size?.width || 0, 0, 3, 3);
    document.getElementById('btn-apply-rect').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const invalidRejected = document.getElementById('rect-status').classList.contains('error')
      && document.getElementById('rect-x').getAttribute('aria-invalid') === 'true';
    setRect(0, 0, 3, 3);
    document.getElementById('btn-apply-rect').click();
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline
        && !/已应用到当前预览/.test(document.getElementById('rect-status').textContent)
        && window.__poppetDev.flowState()?.state !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const applied = /已应用到当前预览/.test(document.getElementById('rect-status').textContent)
      && window.__poppetDev.flowState()?.state === 'ready';
    document.getElementById('btn-show-all-advanced').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const fullVisible = blockIds.every(id =>
      getComputedStyle(document.getElementById(id)).display !== 'none');
    return { initialState, targeted, focused, scopedVisible, invalidRejected, applied, fullVisible };
  })()`);
  check('定向表情恢复只显示相关块，键盘坐标校验/应用且可显式展开全部 Advanced',
    accessibleRecovery.initialState === 'needs-review'
      && accessibleRecovery.targeted
      && accessibleRecovery.focused === 'btn-show-all-advanced'
      && JSON.stringify(accessibleRecovery.scopedVisible) === JSON.stringify(['expression-block'])
      && accessibleRecovery.invalidRejected
      && accessibleRecovery.applied
      && accessibleRecovery.fullVisible,
    accessibleRecovery);

  const original = await win.webContents.executeJavaScript(`(async () => {
    await window.__poppetDev.startDraft(${JSON.stringify(sourceDataURL)}, 'Manager Pixel Smoke');
    const beforeReview = window.__poppetDev.flowState();
    if (beforeReview?.state === 'needs-review') {
      document.getElementById('readiness-action').click();
      document.getElementById('btn-accept-review').click();
    }
    const advanced = document.getElementById('advanced-controls');
    const sourceCanvas = document.getElementById('source-preview');
    return {
      hasResult: !!window.__poppetDev.getDraft()?.result,
      beforeReview: beforeReview?.state || null,
      state: window.__poppetDev.flowState()?.state || null,
      advancedOpen: advanced.open,
      styles: [...document.querySelectorAll('.style-choice')].map(node => node.dataset.preset),
      selected: document.querySelector('.style-choice[aria-pressed="true"]')?.dataset.preset || null,
      sourceSize: [sourceCanvas.width, sourceCanvas.height],
      sourceVisible: getComputedStyle(document.getElementById('source-compare')).display !== 'none',
      createDisabled: document.getElementById('btn-save').disabled,
      timing: window.__poppetDev.flowState()?.timings || null,
    };
  })()`);
  check('默认仅三种样式、Original、Advanced 折叠且 readiness gate 可恢复',
    original.hasResult
      && ['ready', 'needs-review'].includes(original.beforeReview)
      && original.state === 'ready'
      && !original.advancedOpen
      && JSON.stringify(original.styles) === JSON.stringify(['original', 'classic', 'chunky'])
      && original.selected === 'original'
      && original.sourceVisible
      && Math.max(...original.sourceSize) <= 192
      && !original.createDisabled
      && original.timing?.clock?.mode === 'calibrated-cross-process'
      && Number.isFinite(original.timing?.clock?.calibrationUncertaintyMs)
      && ['T0', 'T1', 'T2'].every(key => Number.isFinite(original.timing?.markersMs?.[key]))
      && original.timing?.humanEndToEndTimeMs === null,
    { ...original, timing: {
      clock: original.timing?.clock,
      markers: Object.keys(original.timing?.markersMs || {}).filter(key =>
        Number.isFinite(original.timing.markersMs[key])),
      humanEndToEndTimeMs: original.timing?.humanEndToEndTimeMs,
    } });
  await capture('01-original.png');

  const pixelized = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.style-choice[data-preset="classic"]').click();
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      const state = window.__poppetDev.flowState()?.state;
      const meta = window.__poppetDev.getDraft()?.result?.meta?.source?.pixelize;
      if (state !== 'processing' && meta?.enabled && meta.preset === 'classic') {
        if (state === 'needs-review') document.getElementById('btn-accept-review').click();
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const advanced = document.getElementById('advanced-controls');
    advanced.open = true;
    await new Promise(resolve => setTimeout(resolve, 0));
    const retained = ['pixelize-block', 'expression-block', 'frames-block', 'rig-block',
      'preview-controls-block', 'diagnostics-block'].every(id => !!document.getElementById(id));
    const opened = advanced.open && document.body.classList.contains('advanced-open');
    advanced.open = false;
    await new Promise(resolve => setTimeout(resolve, 0));
    const draft = window.__poppetDev.getDraft();
    return {
      state: window.__poppetDev.flowState()?.state || null,
      meta: draft?.result?.meta?.source?.pixelize || null,
      sprite: draft?.result?.meta?.sprite || null,
      retained, opened, closed: !advanced.open,
      createDisabled: document.getElementById('btn-save').disabled,
    };
  })()`);
  check('现有像素风选择和全部高级恢复控件仍可用',
    pixelized.state === 'ready'
      && pixelized.meta?.enabled && pixelized.meta?.preset === 'classic'
      && pixelized.meta?.targetHeight === 128
      && pixelized.sprite?.height <= 128
      && pixelized.retained && pixelized.opened && pixelized.closed
      && !pixelized.createDisabled,
    pixelized);
  await capture('02-classic.png');

  const saved = await win.webContents.executeJavaScript(`(async () => {
    const expected = {
      spriteDataURL: window.__poppetDev.spriteDataURL(),
      atlasDataURL: window.__poppetDev.atlasDataURL(),
      meta: window.__poppetDev.resultMeta(),
    };
    const replies = await Promise.all([window.__poppetDev.save(), window.__poppetDev.save()]);
    const flow = window.__poppetDev.flowState();
    return {
      expected,
      readyReplies: replies.filter(reply => reply?.ready).length,
      state: flow?.state || null,
      persistedId: flow?.persistedId || null,
      timing: flow?.timings || null,
      timingIssues: flow?.timingIssues || null,
      editorVisible: !document.getElementById('editor').classList.contains('hidden'),
      statusTitle: document.getElementById('readiness-title').textContent,
    };
  })()`);

  const summary = lib.listCharacters().find(character => character.name === 'Manager Pixel Smoke');
  const loaded = summary ? lib.loadCharacter(summary.id) : null;
  const matchingPets = summary ? pets().filter(pet => pet.characterId === summary.id) : [];
  const livePet = matchingPets[0] || null;
  const runtime = livePet ? await waitForPetDevEvidence(livePet) : null;
  const timingOrder = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
  const timingValues = timingOrder.map(key => saved.timing?.markersMs?.[key]);
  const requiredTimingValues = timingValues.slice(0, 6);
  const timingOrdered = requiredTimingValues.every(Number.isFinite)
    && requiredTimingValues.every((value, index) => index === 0 || value >= requiredTimingValues[index - 1]);
  const t6Available = Number.isFinite(timingValues[6]);
  const t6Honest = t6Available
    ? timingValues[6] >= timingValues[5]
    : saved.timingIssues?.T6 === 'POPPET_CLOCK_INVERSION';
  const exactBytes = loaded?.spriteDataURL === saved.expected.spriteDataURL
    && (loaded?.atlasDataURL || null) === (saved.expected.atlasDataURL || null)
    && runtime?.sourceDataURL === loaded?.spriteDataURL
    && (runtime?.atlasDataURL || null) === (loaded?.atlasDataURL || null);
  const exactRuntimeMeta = JSON.stringify(runtime?.meta) === JSON.stringify(loaded?.meta)
    && JSON.stringify(livePet?.character?.meta) === JSON.stringify(loaded?.meta);
  check('并发 Create 单飞，exact persisted/runtime bytes 与 ack 后成功',
    lib.listCharacters().length === beforeCharacters + 1
      && pets().length === beforePets + 1
      && matchingPets.length === 1
      && saved.readyReplies === 2
      && saved.state === 'success'
      && saved.statusTitle === '创建成功'
      && saved.editorVisible
      && saved.persistedId === summary?.id
      && exactBytes
      && exactRuntimeMeta
      && metaContainsExact(loaded?.meta, saved.expected.meta)
      && runtime?.id === summary?.id
      && runtime?.frameReady
      && Number.isFinite(livePet?.firstFrameReadyAt)
      && livePet?.isFirstFrameLive()
      && saved.timing?.clock?.mode === 'calibrated-cross-process'
      && Number.isFinite(saved.timing?.clock?.calibrationUncertaintyMs)
      && saved.timing?.humanEndToEndTimeMs === null
      && timingOrdered
      && t6Honest,
    {
      characterDelta: lib.listCharacters().length - beforeCharacters,
      petDelta: pets().length - beforePets,
      matchingPets: matchingPets.length,
      readyReplies: saved.readyReplies,
      state: saved.state,
      exactBytes,
      exactRuntimeMeta,
      exactMeta: metaContainsExact(loaded?.meta, saved.expected.meta),
      timingKeys: timingOrder.filter(key => Number.isFinite(saved.timing?.markersMs?.[key])),
      clock: saved.timing?.clock,
      timingOrdered,
      t6Honest,
      timingIssues: saved.timingIssues,
    });

  // Keep the exact canonical timing record as an ignored, local-only artifact.
  // The committed milestone summary can be populated from this evidence instead
  // of copying rounded console prose or inventing values. It contains no image,
  // character id, path, filename, or user-entered name.
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'core-loop-flow-evidence.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenario: 'first-frame-before-success',
      status: results.at(-1) ? 'PASS' : 'FAIL',
      timing: saved.timing,
      timingIssues: saved.timingIssues,
      characterDelta: lib.listCharacters().length - beforeCharacters,
      petDelta: pets().length - beforePets,
      matchingPets: matchingPets.length,
      readyReplies: saved.readyReplies,
      exactBytes,
      exactRuntimeMeta,
      exactMeta: metaContainsExact(loaded?.meta, saved.expected.meta),
      firstFrameLive: !!(runtime?.frameReady && livePet?.isFirstFrameLive()),
    }, null, 2)}\n`);

  const unsupported = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const cx = canvas.getContext('2d');
    cx.fillStyle = '#ff0000'; cx.fillRect(0, 0, 16, 16);
    cx.fillStyle = '#00ff00'; cx.fillRect(16, 0, 16, 16);
    cx.fillStyle = '#0000ff'; cx.fillRect(0, 16, 16, 16);
    cx.fillStyle = '#ffff00'; cx.fillRect(16, 16, 16, 16);
    await window.__poppetDev.startDraft(canvas.toDataURL('image/png'), 'Unsupported Smoke');
    return {
      state: window.__poppetDev.flowState()?.state || null,
      createDisabled: document.getElementById('btn-save').disabled,
      actionVisible: !document.getElementById('readiness-action').classList.contains('hidden'),
      advancedOpen: document.getElementById('advanced-controls').open,
    };
  })()`);
  check('复杂背景明确 Unsupported 且只突出相关恢复入口',
    unsupported.state === 'unsupported' && unsupported.createDisabled
      && unsupported.actionVisible && !unsupported.advancedOpen,
    unsupported);

  const failure = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    await window.__poppetDev.startDraft(canvas.toDataURL('image/png'), 'Empty Smoke');
    const draft = window.__poppetDev.getDraft();
    const source = document.getElementById('source-preview');
    return {
      state: window.__poppetDev.flowState()?.state || null,
      hasDraft: !!draft,
      hasSource: !!draft?.source,
      hasResult: !!draft?.result,
      selection: draft?.pixelize?.preset || null,
      sourceSize: [source.width, source.height],
      createDisabled: document.getElementById('btn-save').disabled,
      editorVisible: !document.getElementById('editor').classList.contains('hidden'),
      actionVisible: !document.getElementById('readiness-action').classList.contains('hidden'),
    };
  })()`);
  check('初始处理失败保留 draft/source/selection 并提供恢复',
    failure.state === 'failed' && failure.hasDraft && failure.hasSource && !failure.hasResult
      && failure.selection === 'original' && Math.max(...failure.sourceSize) > 1
      && failure.createDisabled && failure.editorVisible && failure.actionVisible
      && lib.listCharacters().length === beforeCharacters + 1,
    failure);

  // TOCTOU 容量负路径：草稿 Ready 之后才把屏幕槽位填满，main 必须在落盘前
  // 再检查 MAX_PETS，且失败不能新增 library 记录。
  const capacityDraft = await withSmokeDeadline(win.webContents.executeJavaScript(`(async () => {
    const completed = await Promise.race([
      window.__poppetDev.startDraft(${JSON.stringify(sourceDataURL)}, 'Capacity Smoke')
        .then(value => ({ finished: true, value })),
      new Promise(resolve => setTimeout(() => resolve({ finished: false }), 10_000)),
    ]);
    const flow = window.__poppetDev.flowState();
    const current = window.__poppetDev.getDraft();
    return {
      ...completed,
      state: flow?.state || null,
      hasResult: !!current?.result,
      busyHidden: document.getElementById('busy').classList.contains('hidden'),
      managerVisible: document.visibilityState,
    };
  })()`), 'capacity draft');
  if (!capacityDraft.finished) {
    throw new Error(`capacity draft stalled: ${JSON.stringify(capacityDraft)}`);
  }
  if (capacityDraft.state === 'needs-review') {
    await win.webContents.executeJavaScript("document.getElementById('btn-accept-review').click()");
  }
  const fillerCharacter = lib.loadCharacter(lib.listCharacters()[0]?.id);
  const fillers = [];
  while (fillerCharacter && pets().length < lib.MAX_PETS) {
    const filler = spawnPet(fillerCharacter, null);
    if (!filler) break;
    fillers.push(filler);
  }
  const beforeCapacityImport = lib.listCharacters().length;
  const capacity = await withSmokeDeadline(win.webContents.executeJavaScript(`(async () => {
    const reply = await window.__poppetDev.save();
    const flow = window.__poppetDev.flowState();
    return {
      ready: reply?.ready === true,
      persisted: reply?.persisted === true,
      persistedId: flow?.persistedId || null,
      state: flow?.state || null,
      createDisabled: document.getElementById('btn-save').disabled,
    };
  })()`), 'capacity save');
  check('MAX_PETS 竞态在 T4 前失败且 library 不落盘',
    pets().length === lib.MAX_PETS
      && !capacity.ready && !capacity.persisted && !capacity.persistedId
      && capacity.state === 'failed' && capacity.createDisabled
      && lib.listCharacters().length === beforeCapacityImport,
    { ...capacity, pets: pets().length, libraryDelta: lib.listCharacters().length - beforeCapacityImport });
  for (const filler of fillers) filler.destroy();
  await new Promise(resolve => setTimeout(resolve, 150));

  // T4 后瞬时窗口失败：在新角色 durable 后、首帧确认前销毁 exact PetWindow。
  // Manager 必须拿到 persistedId，重试走 ensure-active 而不是再次 import。
  const beforeRetryImport = lib.listCharacters().length;
  await win.webContents.executeJavaScript(`(async () => {
    await window.__poppetDev.startDraft(${JSON.stringify(sourceDataURL)}, 'Retry Smoke');
    if (window.__poppetDev.flowState()?.state === 'needs-review') {
      document.getElementById('btn-accept-review').click();
    }
    window.__poppetRetrySave = window.__poppetDev.save();
    return true;
  })()`);
  let retrySummary = null;
  let failedPet = null;
  let failureLatched = false;
  const failureDeadline = Date.now() + 8000;
  while (Date.now() < failureDeadline && (!retrySummary || !failedPet)) {
    retrySummary = lib.listCharacters().find(character => character.name === 'Retry Smoke') || null;
    failedPet = retrySummary ? pets().find(pet => pet.characterId === retrySummary.id) || null : null;
    if (!retrySummary || !failedPet) await new Promise(resolve => setTimeout(resolve, 1));
  }
  if (failedPet) {
    failureLatched = failedPet.failFirstFrame(Object.assign(new Error('smoke-induced lifecycle close'), {
      code: 'POPPET_PET_CLOSED',
    }));
    failedPet.destroy();
  }
  const afterFailure = await win.webContents.executeJavaScript(`(async () => {
    await window.__poppetRetrySave;
    const flow = window.__poppetDev.flowState();
    return { state: flow?.state || null, persistedId: flow?.persistedId || null };
  })()`);
  const afterFailureCount = lib.listCharacters().length;
  const persistedOnce = retrySummary && afterFailure.persistedId === retrySummary.id
    && afterFailureCount === beforeRetryImport + 1;
  const retried = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('readiness-action').click();
    const deadline = performance.now() + 10000;
    let sawProcessing = false;
    while (performance.now() < deadline) {
      const state = window.__poppetDev.flowState()?.state;
      if (state === 'processing') sawProcessing = true;
      if (sawProcessing && state !== 'processing') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const flow = window.__poppetDev.flowState();
    return { state: flow?.state || null, persistedId: flow?.persistedId || null };
  })()`);
  const retryLive = retrySummary ? pets().filter(pet => pet.characterId === retrySummary.id) : [];
  const retryRuntime = retryLive[0] ? await waitForPetDevEvidence(retryLive[0]) : null;
  const retryLoaded = retrySummary ? lib.loadCharacter(retrySummary.id) : null;
  check('T4 后失败返回 persistedId，spawn-only retry 不重复 import',
    !!failedPet && failureLatched
      && afterFailure.state === 'failed' && persistedOnce
      && retried.state === 'success' && retried.persistedId === retrySummary?.id
      && lib.listCharacters().length === afterFailureCount
      && retryLive.length === 1
      && retryRuntime?.sourceDataURL === retryLoaded?.spriteDataURL,
    {
      intercepted: !!failedPet,
      failureLatched,
      afterFailure,
      retried,
      libraryDeltaAtT4: afterFailureCount - beforeRetryImport,
      libraryDeltaOnRetry: lib.listCharacters().length - afterFailureCount,
      livePets: retryLive.length,
      exactRuntime: retryRuntime?.sourceDataURL === retryLoaded?.spriteDataURL,
    });

  // library 单测注入真实 rename->parent-fsync failure；这里在 dev-only main 对象上
  // 等价地把一次已发布 id 转成 durability-unconfirmed，验证 IPC/Manager finalize 闭环。
  const beforeFinalizeImport = lib.listCharacters().length;
  const originalImportCharacter = lib.importCharacter;
  lib.importCharacter = function injectDurabilityUnconfirmed(payload) {
    const id = originalImportCharacter(payload);
    const error = new Error('dev-only durability uncertainty');
    error.code = 'POPPET_IMPORT_DURABILITY_UNCONFIRMED';
    error.persistedId = id;
    error.stage = 'parent-directory-fsync';
    throw error;
  };
  let finalizeFailure;
  try {
    finalizeFailure = await win.webContents.executeJavaScript(`(async () => {
      await window.__poppetDev.startDraft(${JSON.stringify(sourceDataURL)}, 'Finalize Smoke');
      if (window.__poppetDev.flowState()?.state === 'needs-review') {
        document.getElementById('btn-accept-review').click();
      }
      await window.__poppetDev.save();
      return window.__poppetDev.flowState();
    })()`);
  } finally {
    lib.importCharacter = originalImportCharacter;
  }
  const finalizeSummary = lib.listCharacters().find(character => character.name === 'Finalize Smoke') || null;
  const finalizeCountAfterPublish = lib.listCharacters().length;
  const finalizeBeforeT4 = finalizeFailure?.timings?.markersMs?.T4;
  const finalizeRecovered = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('readiness-action').click();
    const deadline = performance.now() + 10000;
    let sawProcessing = false;
    while (performance.now() < deadline) {
      const state = window.__poppetDev.flowState()?.state;
      if (state === 'processing') sawProcessing = true;
      if (sawProcessing && state !== 'processing') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return window.__poppetDev.flowState();
  })()`);
  const finalizePets = finalizeSummary
    ? pets().filter(pet => pet.characterId === finalizeSummary.id) : [];
  const finalizeRuntime = finalizePets[0] ? await waitForPetDevEvidence(finalizePets[0]) : null;
  const finalizeLoaded = finalizeSummary ? lib.loadCharacter(finalizeSummary.id) : null;
  check('rename 后 durability 未确认走 strict finalize，T4 延后且不重复 import',
    finalizeFailure?.state === 'failed'
      && finalizeFailure?.persistencePending
      && finalizeFailure?.recoveryMode === 'finalize-import'
      && finalizeFailure?.persistedId === finalizeSummary?.id
      && finalizeBeforeT4 === null
      && finalizeCountAfterPublish === beforeFinalizeImport + 1
      && finalizeRecovered?.state === 'success'
      && Number.isFinite(finalizeRecovered?.timings?.markersMs?.T4)
      && lib.listCharacters().length === finalizeCountAfterPublish
      && finalizePets.length === 1
      && finalizeRuntime?.sourceDataURL === finalizeLoaded?.spriteDataURL,
    {
      failureState: finalizeFailure?.state,
      recoveryMode: finalizeFailure?.recoveryMode,
      sameId: finalizeFailure?.persistedId === finalizeSummary?.id,
      T4BeforeFinalize: finalizeBeforeT4,
      T4AfterFinalize: finalizeRecovered?.timings?.markersMs?.T4,
      libraryDeltaAtPublish: finalizeCountAfterPublish - beforeFinalizeImport,
      libraryDeltaOnFinalize: lib.listCharacters().length - finalizeCountAfterPublish,
      pets: finalizePets.length,
      exactRuntime: finalizeRuntime?.sourceDataURL === finalizeLoaded?.spriteDataURL,
    });

  // Manager 在 Create 等待期间关闭：main 仍应完成 durable+首帧闭环；重开后只有
  // 一份角色/一只宠物。IPC reply 被丢弃也不能促成第二次 import。
  // dev-capture.js 不进 production package；这里临时 hold exact PetWindow 的首次 ack，
  // 消除“1ms polling 能否抢过 renderer”的调度抖动，释放后仍走真实 production 方法。
  const PetConstructor = pets()[0]?.constructor;
  const originalMarkFirstFrameReady = PetConstructor?.prototype?.markFirstFrameReady;
  let heldAckPet = null;
  let releaseHeldAck = null;
  if (typeof originalMarkFirstFrameReady !== 'function') {
    throw new Error('pending-close smoke requires a live PetWindow prototype');
  }
  PetConstructor.prototype.markFirstFrameReady = function heldFirstFrameForPendingClose() {
    if (this.character?.meta?.name !== 'Pending Close Smoke') {
      return originalMarkFirstFrameReady.call(this);
    }
    heldAckPet = this;
    return new Promise(resolve => {
      releaseHeldAck = () => resolve(originalMarkFirstFrameReady.call(this));
    });
  };
  let pendingBeforeClose = null;
  let pendingPetBeforeClose = null;
  let pendingAtClose = false;
  let managerClosedBeforeRelease = false;
  try {
    await win.webContents.executeJavaScript(`(async () => {
      await window.__poppetDev.startDraft(${JSON.stringify(sourceDataURL)}, 'Pending Close Smoke');
      if (window.__poppetDev.flowState()?.state === 'needs-review') {
        document.getElementById('btn-accept-review').click();
      }
      window.__poppetDev.save();
      return true;
    })()`);
    const pendingDeadline = Date.now() + 8000;
    while (Date.now() < pendingDeadline
        && (!pendingBeforeClose || !pendingPetBeforeClose || !releaseHeldAck)) {
      pendingBeforeClose = lib.listCharacters().find(character => character.name === 'Pending Close Smoke') || null;
      pendingPetBeforeClose = pendingBeforeClose
        ? pets().find(pet => pet.characterId === pendingBeforeClose.id) || null : null;
      if (!pendingBeforeClose || !pendingPetBeforeClose || !releaseHeldAck) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    pendingAtClose = !!pendingPetBeforeClose && heldAckPet === pendingPetBeforeClose
      && !pendingPetBeforeClose._firstFrameSettled && pendingPetBeforeClose.firstFrameReadyAt === null;
    const closingManager = win;
    const managerClosed = closingManager.isDestroyed()
      ? Promise.resolve()
      : new Promise(resolve => closingManager.once('closed', resolve));
    closingManager.close();
    const closedBeforeDeadline = await Promise.race([
      managerClosed.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
    managerClosedBeforeRelease = closedBeforeDeadline && closingManager.isDestroyed();
    // A smoke must classify a close regression instead of idling until the
    // outer 90-second process timeout. Destroy only this dev Manager after the
    // failed close deadline so the held first-frame reply can be released and
    // the exact failure is reported below.
    if (!managerClosedBeforeRelease && !closingManager.isDestroyed()) closingManager.destroy();
  } finally {
    PetConstructor.prototype.markFirstFrameReady = originalMarkFirstFrameReady;
    releaseHeldAck?.();
  }
  let pendingRuntimeBeforeReopen = null;
  try { if (pendingPetBeforeClose) pendingRuntimeBeforeReopen = await waitForPetDevEvidence(pendingPetBeforeClose); } catch {}
  win = openManager();
  await waitForManagerHooks(win);
  const pendingSummaries = lib.listCharacters().filter(character => character.name === 'Pending Close Smoke');
  const pendingPets = pendingSummaries[0]
    ? pets().filter(pet => pet.characterId === pendingSummaries[0].id) : [];
  const pendingLoaded = pendingSummaries[0] ? lib.loadCharacter(pendingSummaries[0].id) : null;
  let pendingRuntime = null;
  try { if (pendingPets[0]) pendingRuntime = await waitForPetDevEvidence(pendingPets[0]); } catch {}
  check('Create 等待中关闭 Manager，重开仍只有一份 durable 角色和 exact pet',
    pendingAtClose && managerClosedBeforeRelease && pendingRuntimeBeforeReopen?.frameReady
      && pendingSummaries.length === 1 && pendingPets.length === 1
      && pendingRuntime?.sourceDataURL === pendingLoaded?.spriteDataURL,
    {
      pendingAtClose,
      managerClosedBeforeRelease,
      ackBeforeReopen: pendingRuntimeBeforeReopen?.frameReady === true,
      characters: pendingSummaries.length,
      pets: pendingPets.length,
      exactRuntime: pendingRuntime?.sourceDataURL === pendingLoaded?.spriteDataURL,
    });

  const reopened = await win.webContents.executeJavaScript(`(async () => {
    const listed = await window.poppet.list();
    return {
      found: listed.characters.some(character => character.name === 'Manager Pixel Smoke'),
      onScreen: listed.characters.filter(character => character.onScreen).length,
      editorHidden: document.getElementById('editor').classList.contains('hidden'),
    };
  })()`);
  check('关闭并重开 Manager 不复制或收起已确认桌宠',
    reopened.found && reopened.editorHidden
      && lib.listCharacters().length === beforeCharacters + 4
      && pets().length === beforePets + 4
      && pets().filter(pet => pet.characterId === summary?.id).length === 1,
    { ...reopened, characters: lib.listCharacters().length, pets: pets().length });

  // .poppetpack 端到端往返：导出一个已保存角色 -> 按路径走真实导入管线
  // -> 新角色字节级一致。这是 pack IPC 管线（对话框/拖放共用的
  // importPackFromPath）此前缺失的执行级覆盖。
  {
    const packModule = require('./pack');
    const exportable = lib.listCharacters().find(character => character.exportable);
    let packResult = { ok: false };
    if (exportable && typeof importPackFromPath === 'function') {
      const bundle = lib.characterExportBundle(exportable.id);
      const archive = packModule.buildPoppetpack(bundle);
      const packFile = path.join(artifactDir, 'roundtrip.poppetpack');
      fs.writeFileSync(packFile, archive);
      const imported = await importPackFromPath(packFile);
      const importedId = imported?.persistedId || imported?.id || null;
      if (imported?.persisted && importedId && importedId !== exportable.id) {
        const reBundle = lib.characterExportBundle(importedId);
        const bytesEqual = Object.keys(bundle.files).every(name =>
          reBundle.files[name] && bundle.files[name].equals(reBundle.files[name]))
          && Object.keys(bundle.files).length === Object.keys(reBundle.files).length;
        packResult = {
          ok: bytesEqual && reBundle.meta.name === bundle.meta.name
            && (imported.ready === true || imported.spawnSkipped === true),
          importedId,
          bytesEqual,
          ready: imported.ready === true,
          spawnSkipped: imported.spawnSkipped === true,
        };
        // 清掉往返产物，别影响后续 restart 阶段的角色计数断言：
        // despawnPet 维护内存 roster 并销毁窗口；持久化名单由成功路径
        // app.quit() 的 before-quit persistPets 落盘。
        if (typeof despawnPet === 'function') despawnPet(importedId);
        lib.deleteCharacter(importedId);
      } else {
        packResult = { ok: false, imported };
      }
    } else {
      packResult = { ok: false, reason: 'no exportable character or importPackFromPath missing' };
    }
    check('.poppetpack 导出->按路径导入 字节级往返一致', packResult.ok, packResult);
  }

  // 关节骨架编辑器：走真实导入 IPC 造一个 v3 角色，用 openProps 打开它，
  // 确认面板真的出现、预览真的画出了像素、改动真的落盘再读得回来。
  // 单元测试到不了这里——面板依赖 canvas 与 ImageData，而"画出来了没有"
  // 只有真进程能回答。
  {
    const rig = await win.webContents.executeJavaScript(`(async () => {
    const png = (w, h, paint) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      paint(cx);
      return new Promise(res => c.toBlob(b => b.arrayBuffer().then(res), 'image/png'));
    };
    const block = (cx, x, y, w, h, color) => { cx.fillStyle = color; cx.fillRect(x, y, w, h); };
    const files = {
      'pet.png': await png(32, 48, cx => block(cx, 10, 16, 12, 32, '#2b47a8')),
      'parts.png': await png(32, 16, cx => {
        block(cx, 0, 0, 12, 16, '#2b47a8');   // 躯干
        block(cx, 14, 0, 4, 12, '#e0c0a0');   // 手臂
      }),
      'icon.png': await png(16, 16, cx => block(cx, 2, 2, 12, 12, '#2b47a8')),
    };
    const meta = {
      schemaVersion: 3,
      sprite: { width: 32, height: 48 },
      frames: null,
      atlas: { width: 32, height: 16 },
      parts: [], suggestions: [], footY: 47,
      outline: [0, 0, 0], palette: [[0, 0, 0]],
      rig: { motion: 'walk', anchor: 'feet', flip: true, swayFrom: null },
      source: {
        cropBBox: [0, 0, 31, 47], backgroundMode: 'alpha',
        originalSize: { width: 32, height: 48 },
        extraction: { contractVersion: 1, extractor: 'local-edge-v1', status: 'ready', mode: 'alpha' },
        pixelize: {
          enabled: false, preset: 'original', targetHeight: null, paletteSize: null,
          methodVersion: 'local-box-median-cut-v1', width: 32, height: 48, colors: 1,
          sharedPalette: false,
        },
      },
      skeleton: {
        angleStep: 15,
        bones: [
          { id: 'torso', parent: null, pivot: { x: 6, y: 16 }, anchor: { x: 16, y: 40 },
            z: 10, frame: { sx: 0, sy: 0, sw: 12, sh: 16 }, drivers: { breathe: 1 } },
          { id: 'armL', parent: 'torso', pivot: { x: 2, y: 1 }, anchor: { x: 6, y: -14 },
            z: 20, frame: { sx: 14, sy: 0, sw: 4, sh: 12 },
            drivers: { wave: -2 }, limit: [-150, 60] },
        ],
      },
    };
    const imported = await window.poppet.import({ name: '骨架冒烟', meta, files });
    const id = imported?.persistedId || imported?.id;
    if (!id) return { error: 'import 没有返回 id' };

    await window.__poppetDev.openProps(id);
    const panel = document.getElementById('skeleton-block');
    const canvas = document.getElementById('skel-canvas');
    const boneSelect = document.getElementById('skel-bone');
    const painted = () => {
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      const d = cx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
      return false;
    };
    // hidden=false 不等于看得见：面板住在一个 <details> 里，收起时它照样
    // 不可见，而 canvas 的后备存储仍然有像素，光看 hidden 会给出假绿。
    const shown = !panel.hidden && panel.offsetParent !== null
      && panel.getBoundingClientRect().height > 0
      && canvas.getBoundingClientRect().height > 0;
    const bones = boneSelect.options.length;
    const drewIdle = painted();

    // 切到招手姿势：手臂必须被转到别处，画面因此不同。
    const before = canvas.toDataURL();
    document.getElementById('skel-pose').value = 'wave';
    document.getElementById('skel-pose').dispatchEvent(new Event('change'));
    const poseChanged = canvas.toDataURL() !== before;

    // 选中手臂，把招手增益改掉，保存，再读回来核对。
    boneSelect.value = 'armL';
    boneSelect.dispatchEvent(new Event('change'));
    const waveInput = [...document.querySelectorAll('#skel-drivers input')]
      .find(i => i.previousElementSibling && i.previousElementSibling.textContent === '招手');
    if (!waveInput) return { error: '找不到招手增益输入框' };
    waveInput.value = '-1.5';
    waveInput.dispatchEvent(new Event('input'));
    document.getElementById('btn-skeleton-save').click();
    await new Promise(r => setTimeout(r, 400));
    const after = await window.poppet.load(id);
    const arm = after.meta.skeleton.bones.find(b => b.id === 'armL');
    return {
      id, shown, bones, drewIdle, poseChanged,
      savedGain: arm ? arm.drivers.wave : null,
      stillV3: after.meta.schemaVersion === 3,
      boneCount: after.meta.skeleton.bones.length,
    };
  })()`);
    check('骨架编辑器可见/预览/保存', rig.shown && rig.bones === 2 && rig.drewIdle
      && rig.poseChanged && rig.savedGain === -1.5 && rig.stillV3 && rig.boneCount === 2, rig);
    await capture('05-skeleton-editor.png');
    // 和角色包往返那条一样清掉产物：后面的 restart 阶段要对角色计数做断言。
    if (rig.id) {
      if (typeof despawnPet === 'function') despawnPet(rig.id);
      lib.deleteCharacter(rig.id);
    }
  }

  const bad = results.filter(result => !result).length;
  console.log(`[manager-test] ${results.length - bad}/${results.length} 通过`);
  if (bad) app.exit(1);
  else app.quit(); // exercise before-quit slot persistence before the restart phase
}

async function testManagerRestart({ lib, pets, artifactDir }) {
  const summary = lib.listCharacters().find(character => character.name === 'Manager Pixel Smoke');
  const loaded = summary ? lib.loadCharacter(summary.id) : null;
  const savedSlots = summary ? lib.getPets().filter(slot => slot.characterId === summary.id) : [];
  const matchingPets = summary ? pets().filter(pet => pet.characterId === summary.id) : [];
  const livePet = matchingPets[0] || null;
  let runtime = null;
  try { if (livePet) runtime = await waitForPetDevEvidence(livePet); } catch {}

  const exact = !!loaded && runtime?.sourceDataURL === loaded.spriteDataURL
    && (runtime?.atlasDataURL || null) === (loaded.atlasDataURL || null)
    && JSON.stringify(runtime?.meta) === JSON.stringify(loaded.meta)
    && JSON.stringify(livePet?.character?.meta) === JSON.stringify(loaded.meta);
  const results = [
    !!loaded && loaded.meta?.source?.pixelize?.preset === 'classic',
    savedSlots.length === 1,
    matchingPets.length === 1 && runtime?.id === summary?.id
      && runtime?.frameReady && livePet?.isFirstFrameLive(),
    exact,
  ];
  console.log(`[manager-restart-test] ${results[0] ? '✓' : '✗'} 重启后角色与 provenance 可回读`);
  console.log(`[manager-restart-test] ${results[1] ? '✓' : '✗'} 正常退出未清空唯一屏幕槽位`);
  console.log(`[manager-restart-test] ${results[2] ? '✓' : '✗'} exact renderer 首帧重新确认且无双宠`);
  console.log(`[manager-restart-test] ${results[3] ? '✓' : '✗'} restart runtime source 与 durable bytes 完全一致`);
  if (livePet?.win && results[2]) {
    fs.mkdirSync(artifactDir, { recursive: true });
    const image = await livePet.win.webContents.capturePage();
    const output = path.join(artifactDir, '03-restarted-pet.png');
    fs.writeFileSync(output, image.toPNG());
    console.log(`[manager-restart-test] 截帧 ${path.relative(process.cwd(), output)}`);
  }
  const bad = results.filter(result => !result).length;
  console.log(`[manager-restart-test] ${results.length - bad}/${results.length} 通过`);
  app.exit(bad ? 1 : 0);
}

// 回归测试：注入真实的 mousedown/mouseup 事件序列，而不是直接切状态。
// 单击曾经会被随后到达的 PET_DROPPED 踩成 land，只有走完整条真实路径才发现得了。
async function testClick(pet) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const win = pet.win;
  await sleep(2500);

  // 先取快照：启动后、任何鼠标事件之前的穿透状态。
  // 放到后面取会读到被鼠标事件切换过的值，测的就不是"初始化"了。
  const initialInteractive = pet.interactive;
  const initialCalls = pet.ignoreMouseCalls || 0;

  // 渲染节拍：目标帧率必须真的画出来，且帧间隔不能忽长忽短。
  // 曾经因为节流用"累加够一帧就清零"，60Hz 屏上每隔一帧丢一帧——
  // 实渲 38fps、dt 在 16.7/33.4ms 之间跳，跳跃和眨眼时肉眼可见地卡。
  // 必须在真的"跳 + 眨眼"期间测：闲置时姿态几乎不变，掉帧也看不出来。
  const pace = await win.webContents.executeJavaScript(`(async () => {
    window.__poppetPace.reset();
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      window.__poppetPetDev.act('hop');
      window.__poppetPetDev.act('blink');
      await new Promise(r => setTimeout(r, 250));
    }
    return window.__poppetPace.read();
  })()`);
  // 目标帧率不一定是显示器刷新率的整除数：100Hz 屏上要 60fps，
  // 只能在 50fps（每 2 个刷新画一次、dt 稳定）和 100fps 之间选，强行凑平均 60
  // 会让 dt 在 10/20ms 之间跳——正是要避免的抖动。所以判据是
  // "有没有跑满当前刷新率下最接近目标的那个均匀档"，而不是"有没有跑到目标值"。
  const bestCadence = pace.rafHz / Math.max(1, Math.ceil(pace.rafHz / pace.targetFps - 0.05));
  const cadenceOk = pace.samples > 30 && pace.fps >= bestCadence * 0.9;
  // dt 忽长忽短才是"卡"，帧率低一点反而不明显。
  const jitterOk = pace.dtMax / pace.dtMin < 1.35;

  // 共享 CI runner 的帧时钟不归我们管：托管 macOS 上实测 rafHz 59、dt 14.7~42.5ms，
  // 抖动比 2.89——那是虚拟机的调度噪声，不是渲染循环在卡。所以在 CI 上抖动只报不判。
  // 这是**缩小断言范围**，不是放宽阈值：阈值在开发机上一字未改，而它当初就是为一个
  // 真实缺陷加的（节流清零导致 60Hz 屏每隔一帧丢一帧）。把 1.35 调大才是毁掉这条守卫。
  // 代价要说清楚：CI 绿不等于"渲染顺滑"，那句话只有开发机的运行能证明。
  const onCI = !!process.env.CI;
  const paceOk = cadenceOk && (jitterOk || onCI);
  const jitterNote = jitterOk ? '' : onCI ? ',"jitter":"CI 不计入判定"' : ',"jitter":"超标"';
  console.log(`[click-test] ${paceOk ? '✓' : '✗'} 渲染节拍 ` +
    `{"best":${bestCadence.toFixed(0)},"fps":${pace.fps.toFixed(1)},"target":${pace.targetFps.toFixed(0)},` +
    `"dt":"${pace.dtMin.toFixed(1)}~${pace.dtMax.toFixed(1)}ms",` +
    `"rafHz":${pace.rafHz.toFixed(1)},"work":"${pace.workAvg.toFixed(2)}/${pace.workMax.toFixed(1)}ms",` +
    `"composeMiss":${pace.composeMiss}${jitterNote}}`);

  const results = [];
  const run = async (name, script) => {
    const got = await win.webContents.executeJavaScript(script);
    results.push({ name, ...got });
  };

  // 找一个落在角色身上的点：画布中心偏下必定是身体
  const hit = await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('stage');
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    for (let y = Math.round(c.height * 0.55); y < c.height; y += 4) {
      for (let x = Math.round(c.width * 0.3); x < c.width * 0.7; x += 4) {
        if (ctx.getImageData(x, y, 1, 1).data[3] > 8) return { x: x / dpr, y: y / dpr };
      }
    }
    return null;
  })()`);
  console.log('[click-test] 命中点 ' + JSON.stringify(hit));
  if (!hit) { console.error('[click-test] ✗ 找不到不透明像素'); return app.exit(1); }

  const fire = (type, dx, dy, button) => `window.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
    clientX: ${hit.x + dx}, clientY: ${hit.y + dy},
    screenX: ${1000 + dx}, screenY: ${1000 + dy}, button: ${button}, bubbles: true }))`;

  // 场景 1：原地单击 —— 应当进入 hop/shake 之一，而不是 land
  await win.webContents.executeJavaScript(fire('mousedown', 0, 0, 0));
  await sleep(60);
  await win.webContents.executeJavaScript(fire('mouseup', 0, 0, 0));
  await sleep(250); // 等 PET_DROPPED 绕一圈回来
  await run('单击', '({ state: window.__poppetDev.state() })');

  await sleep(1200);

  // 场景 2：拖拽后松手 —— 应当进入 land
  await win.webContents.executeJavaScript(fire('mousedown', 0, 0, 0));
  await sleep(60);
  await win.webContents.executeJavaScript(fire('mousemove', 40, 0, 0));
  await sleep(60);
  await win.webContents.executeJavaScript(fire('mouseup', 40, 0, 0));
  await sleep(250);
  await run('拖拽松手', '({ state: window.__poppetDev.state() })');

  // 场景 3：启动时的点击穿透初始化不能被"值没变"短路掉
  results.push({
    name: '穿透初始化',
    state: initialInteractive === false ? 'ok' : 'bad',
    calls: initialCalls,
  });

  const POKE = ['hop', 'shake'];
  let bad = paceOk ? 0 : 1;
  const CHECKS = {
    '单击': (r) => [POKE.includes(r.state), 'state 应为 ' + POKE.join('/')],
    '拖拽松手': (r) => [r.state === 'land', 'state 应为 land'],
    '穿透初始化': (r) => [r.state === 'ok' && r.calls >= 1, 'setIgnoreMouseEvents 应至少被调用过一次（实际 ' + r.calls + '）'],
  };
  for (const r of results) {
    const [ok, expect] = CHECKS[r.name](r);
    if (!ok) bad++;
    console.log(`[click-test] ${ok ? '✓' : '✗'} ${r.name} -> ${JSON.stringify(r)}` + (ok ? '' : `  ${expect}`));
  }
  const total = results.length + 1;
  console.log(`[click-test] ${total - bad}/${total} 通过`);
  app.exit(bad ? 1 : 0);
}

// 多只同屏的回归测试。
//
// 这个功能的典型失败模式是 IPC 路由错：所有按窗口来的 IPC 都必须靠 event.sender
// 找回是哪一只，拿全局的"当前那只"在单只时完全看不出问题，多只同屏就是**拖 B 却动 A**。
// --test-click 只有一只窗口，永远抓不到这类 bug，所以单独一套。
async function testMulti({ spawnPet, pets, lib }) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(2000);
  // 位置持久化 oracle 要比较一个原子拖拽事件前后的 exact bounds。隔离 smoke
  // profile 中先停用自主漫游，否则未被拖动的 A 可能在落盘后、读取前自己走一步，
  // 把正确的 per-window IPC 路由误报成失败。
  const stableSettings = lib.setSettings({ wander: false });
  for (const pet of pets()) pet.send(CH.PET_SETTINGS, stableSettings);
  await sleep(100);
  const results = [];
  const ok = (name, cond, detail) => {
    results.push(cond);
    console.log(`[multi-test] ${cond ? '✓' : '✗'} ${name} ${JSON.stringify(detail)}`);
  };

  // 放第二只。优先用本地形态样本；干净 checkout 只跟踪 default 时，克隆同一份
  // 已验证的 bundled bytes 并换一个 test-only id。这个 smoke 验证的是 event.sender
  // 隔离和逐窗口 roster，不应暗中依赖开发者机器上未跟踪的私有样本。
  const candidate = lib.loadBuiltinCharacter('cyclops')
    || lib.loadBuiltinCharacter('floater')
    || lib.loadBuiltinCharacter('default');
  const firstId = pets()[0]?.characterId;
  const second = candidate && candidate.id === firstId
    ? { ...candidate, id: 'multi-smoke-secondary' }
    : candidate;
  if (!second) { console.error('[multi-test] ✗ 没有可用的第二个角色'); return app.exit(1); }
  spawnPet(second, null);
  await sleep(1500);
  console.log('[multi-test] 落点 ' + JSON.stringify(pets().map(p => p.characterId + '@' + p.bounds().x + ',' + p.bounds().y)));

  const list = pets();
  if (list.length < 2) { console.error('[multi-test] ✗ 第二只没起来'); return app.exit(1); }
  const [A, B] = list;

  // 1) 每个窗口拿到的应当是**它自己**的角色
  const idA = await A.win.webContents.executeJavaScript('window.__poppetDev.charId && window.__poppetDev.charId()');
  const idB = await B.win.webContents.executeJavaScript('window.__poppetDev.charId && window.__poppetDev.charId()');
  ok('两个窗口各拿到自己的角色', idA && idB && idA !== idB, { A: idA, B: idB });

  // 2) 走真实 IPC 路径让 B 移动，A 必须纹丝不动
  const a0 = A.bounds(), b0 = B.bounds();
  // 往左移：默认落点在屏幕右下角，往右会被 clamp 吃掉，测出来"没动"是假阴性
  await B.win.webContents.executeJavaScript('window.pet.moveBy(-40, 0)');
  await sleep(300);
  const a1 = A.bounds(), b1 = B.bounds();
  ok('移动 B 不会带动 A',
    b1.x !== b0.x && a1.x === a0.x && a1.y === a0.y,
    { A: `${a0.x}->${a1.x}`, B: `${b0.x}->${b1.x}` });

  // 3) 拖拽 B 之后落盘：每只存的必须是**它自己**窗口的当前位置。
  //    不跟历史文件比——上一次运行残留的槽位会让断言变成在测环境而不是测代码。
  await B.win.webContents.executeJavaScript('window.pet.dragStart()');
  await sleep(120);
  await B.win.webContents.executeJavaScript('window.pet.dragEnd()');
  await sleep(300);
  const slots = lib.getPets();
  const live = pets().map(p => ({ id: p.characterId, ...p.bounds() }));
  const matches = live.every(l => {
    const slot = slots.find(s => s.characterId === l.id);
    return slot && slot.x === l.x && slot.y === l.y;
  });
  ok('落盘时每只各存各的位置',
    slots.length === live.length && matches && live[0].x !== live[1].x,
    { 窗口: live.map(l => `${l.id}@${l.x},${l.y}`), 落盘: slots.map(s => `${s.characterId}@${s.x},${s.y}`) });

  // 各自抓一帧：透明窗口截不到彼此，但能确认两只都真的画出了**各自**的角色
  const dir = '.artifacts/multi';
  fs.mkdirSync(dir, { recursive: true });
  for (const p of pets()) {
    const img = await p.win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, p.characterId + '.png'), img.toPNG());
    console.log(`[multi-test] 截帧 ${p.characterId}.png @${p.bounds().x},${p.bounds().y}`);
  }

  const bad = results.filter(r => !r).length;
  console.log(`[multi-test] ${results.length - bad}/${results.length} 通过`);
  app.exit(bad ? 1 : 0);
}

module.exports = {
  startCapture, captureManager, testManager, testManagerRestart, testClick, testMulti, DEMO_SCRIPT,
};

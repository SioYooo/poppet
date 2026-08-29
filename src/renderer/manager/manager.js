// 角色管理界面：导入图片 -> 跑通用管线 -> 预览/校准 -> 落盘。
// 图像处理放在这个 renderer 里做，因为它有 Canvas；主进程只负责存文件。

import { buildCharacter, DEFAULTS } from '../../shared/pipeline.js';
import { normalizeParts, eyesOf, mouthOf, SOURCE_USER } from '../../shared/parts.js';
import {
  normalizeSkeleton, drawOrder, resolvePose, boneTransforms, frameFor,
  DRIVERS, DRIVER_NAMES,
} from '../../shared/skeleton.js';
import { waitForVisiblePaint, recordVisiblePaintTiming } from '../../shared/visible-paint.js';

// macOS 用内嵌式标题栏，需要自绘一条拖动区；Windows 有原生标题栏，那条要收起来
document.documentElement.dataset.platform = window.poppet.platform;

const $ = (id) => document.getElementById(id);
const QUERY = new URLSearchParams(location.search);
const POPPET_DEV = QUERY.get('poppetDev') === '1';
const FLOW_MEASUREMENT_ENABLED = POPPET_DEV || QUERY.get('measurement') === '1';

const el = {
  list: $('character-list'),
  dropzone: $('dropzone'),
  editor: $('editor'),
  preview: $('preview'),
  sourcePreview: $('source-preview'),
  sourceCompare: $('source-compare'),
  resultPreviewLabel: $('result-preview-label'),
  previewHint: $('preview-hint'),
  report: $('report'),
  pixelizePreset: $('pixelize-preset'),
  pixelizePalette: $('pixelize-palette'),
  pixelizeHint: $('pixelize-hint'),
  save: $('btn-save'),
  cancel: $('btn-cancel'),
  readinessCard: $('readiness-card'),
  readinessTitle: $('readiness-title'),
  readinessDetail: $('readiness-detail'),
  readinessAction: $('readiness-action'),
  advanced: $('advanced-controls'),
  advancedSummary: $('advanced-summary'),
  showAllAdvanced: $('btn-show-all-advanced'),
  expressionBlock: $('expression-block'),
  acceptReview: $('btn-accept-review'),
  rectPart: $('rect-part'),
  rectX: $('rect-x'),
  rectY: $('rect-y'),
  rectW: $('rect-w'),
  rectH: $('rect-h'),
  rectStatus: $('rect-status'),
  styleChoices: [...document.querySelectorAll('.style-choice')],
  name: $('char-name'),
  busy: $('busy'),
  busyText: $('busy-text'),
  scale: $('set-scale'),
  wander: $('set-wander'),
  clickThrough: $('set-clickthrough'),
  fps: $('set-fps'),
  loginItemRow: $('login-item-row'),
  loginItem: $('set-login-item'),
  rigMotion: $('rig-motion'),
  rigAnchor: $('rig-anchor'),
  rigFlip: $('rig-flip'),
  rigSway: $('rig-sway'),
  framesHint: $('frames-hint'),
  gridCols: $('grid-cols'),
  gridRows: $('grid-rows'),
  clipsRow: $('clips-row'),
  clipsHint: $('clips-hint'),
  clipIdle: $('clip-idle'),
  clipWalk: $('clip-walk'),
  clipDrag: $('clip-drag'),
  clipGreet: $('clip-greet'),
  suggestBlock: $('suggest-block'),
  suggestList: $('suggest-list'),
};

const DEFAULT_RIG = { anchor: 'feet', flip: true, motion: 'walk', swayFrom: 0.5 };

const ctx = el.preview.getContext('2d', { willReadFrequently: true });
ctx.imageSmoothingEnabled = false;
const sourceCtx = el.sourcePreview.getContext('2d');
sourceCtx.imageSmoothingEnabled = false;

// 当前正在编辑的导入任务
let draft = null;   // { source, result, name, features, previewScale }
let armedPart = null;
let showBoxes = false;
let dragBox = null;
let animTimer = null;
let previewFrame = 0;
let framePlayTimer = null;
let pendingShowBoxes = null;
let processEpoch = 0;
let loadEpoch = 0;
let saveInFlight = null;
let readinessAction = null;
let libraryCapacity = { onScreen: 0, maxPets: 6 };
let mainClock = null;

const PART_COLORS = { eye0: '#ff5fd2', eye1: '#5fd2ff', mouth: '#7cff9b' };
// 候选按类别配色，跟已确认的部件区分开（候选画虚线，确认后画实线）
const SUGGEST_COLORS = { tail: '#ff8a5f', 'ear/ahoge': '#5fb8ff', leg: '#ffd24a', 'wing/fin': '#8affa0' };
const SUGGEST_LABEL = { tail: '尾巴？', 'ear/ahoge': '耳朵 / 呆毛？', leg: '腿？', 'wing/fin': '翅膀 / 鳍？' };
const PART_LABEL = { eye0: '眼睛①', eye1: '眼睛②', mouth: '嘴' };

const FLOW_LABEL = {
  processing: '处理中',
  ready: '可以创建了',
  'needs-review': '需要确认',
  unsupported: '暂不支持的图片',
  failed: '失败（草稿已保留，可重试）',
  success: '创建成功',
};

function localFlowNow() {
  return performance.now();
}

// Renderer 与 main 的 performance.now() 各自单调、但原点不同。用五次严格
// 无参数 round-trip 中 RTT 最小的一次校准偏移，后续 T0-T6 全映射到 main 域；
// uncertainty 只留在内存/返回值里，不写盘、不发遥测。
async function calibrateMainClock() {
  if (!FLOW_MEASUREMENT_ENABLED) return null;
  if (mainClock) return mainClock;
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const before = localFlowNow();
    const sample = await window.poppet.flowClock();
    const after = localFlowNow();
    if (!sample || !Number.isFinite(sample.mainNow)) throw new Error('计时校准失败');
    samples.push({ rtt: after - before, offset: sample.mainNow - (before + after) / 2 });
  }
  samples.sort((a, b) => a.rtt - b.rtt);
  mainClock = { offset: samples[0].offset, uncertaintyMs: samples[0].rtt / 2 };
  return mainClock;
}

async function flowNow(localMark = localFlowNow()) {
  if (!FLOW_MEASUREMENT_ENABLED) return null;
  const clock = await calibrateMainClock();
  return localMark + clock.offset;
}

function afterVisiblePaint() {
  // Chromium may suspend requestAnimationFrame for an occluded/backgrounded
  // Manager window. UI sequencing must not leave import or recovery promises
  // pending forever merely because another window covers the Manager.
  return waitForVisiblePaint();
}

async function recordPaintTiming(target, key, painted) {
  if (!FLOW_MEASUREMENT_ENABLED) return null;
  return recordVisiblePaintTiming(target, key, painted, flowNow);
}

function setReadiness(state, detail, action = null) {
  if (draft) draft.flowState = state;
  el.readinessCard.dataset.state = state;
  el.readinessTitle.textContent = FLOW_LABEL[state] || state;
  el.readinessDetail.textContent = detail || '';
  readinessAction = typeof action?.run === 'function' ? action.run : null;
  el.readinessAction.textContent = action?.label || '';
  el.readinessAction.classList.toggle('hidden', !readinessAction);

  const canCreate = !!draft?.result && state === 'ready' && !saveInFlight;
  el.save.disabled = !canCreate;
  el.save.textContent = draft?.propsOnly
    ? '保存设置'
    : state === 'success' ? '已创建'
      : saveInFlight ? '创建中…' : '创建桌宠';
  const frozen = state === 'processing' || state === 'success' || !!draft?.persistedId;
  for (const button of el.styleChoices) button.disabled = frozen;
  for (const control of el.advanced.querySelectorAll('input, select, button')) control.disabled = frozen;
  el.name.disabled = frozen && !draft?.propsOnly;
  if (el.pixelizePreset) el.pixelizePreset.disabled = frozen;
  if (el.pixelizePalette) {
    const preset = el.pixelizePreset?.value || 'original';
    el.pixelizePalette.disabled = frozen || preset === 'original';
  }
}

el.readinessAction.addEventListener('click', () => { if (readinessAction) void readinessAction(); });

function openExpressionRecovery() {
  document.body.classList.add('targeted-recovery');
  el.advanced.open = true;
  document.body.classList.add('advanced-open');
  document.querySelectorAll('.recovery-target').forEach(node => node.classList.remove('recovery-target'));
  el.expressionBlock.classList.add('recovery-target');
  showBoxes = true;
  if (draft?.result) drawPreview(1, 1);
  loadRectEditor();
  el.showAllAdvanced.focus();
}

function leaveTargetedRecovery() {
  document.body.classList.remove('targeted-recovery');
  document.querySelectorAll('.recovery-target').forEach(node => node.classList.remove('recovery-target'));
}

el.showAllAdvanced.addEventListener('click', () => {
  leaveTargetedRecovery();
  el.advanced.open = true;
  document.body.classList.add('advanced-open');
  el.advancedSummary.focus();
});

function focusVisiblePetToggle() {
  document.querySelector('.char-item.active .char-on')?.focus();
}

function classifyDraftReadiness() {
  if (!draft) return;
  if (draft.propsOnly) {
    setReadiness('ready', '动作设置可以保存；不会重新处理角色图片。');
    return;
  }
  if (draft.persistedId && draft.createFailure) {
    const manualRecovery = draft.recoveryMode === 'manual-recovery';
    const prefix = manualRecovery
      ? '角色持久化恢复无法继续，当前草稿仍冻结；'
      : draft.persistencePending
        ? '角色文件已完整写入，编辑已冻结，但耐久性尚未确认；'
        : '角色已按当前预览安全保存，编辑已冻结；';
    setReadiness('failed', `${prefix}${draft.createFailure}`, {
      label: manualRecovery ? '选择另一张图片'
        : draft.persistencePending ? '重试持久化确认' : '重试显示桌宠',
      run: manualRecovery ? pickFile : retryPersistedPet,
    });
    return;
  }
  if (draft.createFailure) {
    setReadiness('failed', draft.createFailure, {
      label: '重试创建', run: retryCreate,
    });
    return;
  }
  if (!draft.result) {
    setReadiness('failed', draft.lastProcessError || '处理没有完成；原图和当前选择仍保留。', {
      label: '重试处理', run: retryProcessing,
    });
    return;
  }
  const extraction = draft.result.meta?.source?.extraction;
  if (extraction?.status === 'needs-advanced-extraction') {
    setReadiness('unsupported', '背景过于复杂，当前本地工具不会冒险猜测。请改用透明或简单背景图片。', {
      label: '选择另一张图片', run: pickFile,
    });
    return;
  }
  if (libraryCapacity.onScreen >= libraryCapacity.maxPets && !draft.persistedId) {
    setReadiness('needs-review', `屏幕上已有 ${libraryCapacity.maxPets} 只桌宠；请先收起一只。`, {
      label: '定位到屏幕角色', run: focusVisiblePetToggle,
    });
    return;
  }
  if (draft.pendingFeatureEdits) {
    setReadiness('needs-review', '表情框有尚未应用的修改；先重新处理预览。', {
      label: '继续表情修正', run: openExpressionRecovery,
    });
    return;
  }
  const multi = (draft.result.meta?.frames?.count || 1) > 1;
  const ambiguous = draft.result.report?.warnings?.some(message => /自动五官存在相近候选/.test(message));
  const noEyes = !multi && eyesOf(draft.result.meta?.parts).length === 0;
  if (!draft.reviewAccepted && !draft.features && (ambiguous || noEyes)) {
    const reason = ambiguous
      ? '自动表情检测有相近候选；请检查眨眼预览，必要时重框。'
      : '没有可靠识别到眼睛；可以手动重框，或确认创建一个不眨眼的桌宠。';
    setReadiness('needs-review', reason, {
      label: '检查表情区域', run: openExpressionRecovery,
    });
    return;
  }
  setReadiness('ready', '预览已准备好。创建后会等桌宠真正画出首帧再确认成功。');
}

el.advanced.addEventListener('toggle', () => {
  document.body.classList.toggle('advanced-open', el.advanced.open);
  if (!el.advanced.open) {
    showBoxes = false;
    leaveTargetedRecovery();
    if (draft?.result) drawPreview(1, 1);
  }
});


// ============================================================
// 角色列表 / 设置
// ============================================================

// 不可导出的原因（主进程 LIB_LIST 的 exportBlockReason）-> 用户能照着做的说明。
// 旧格式（v0/v1）角色没有原地升级路径：改名/动作设置只合并 name/rig，既不会补
// schemaVersion 也不会生成 icon.png；真正能修的是用原图重新创建一个角色——
// 创建管线固定写 schemaVersion 2，并且总是附带 icon.png。
const EXPORT_BLOCK_HINTS = {
  'legacy-schema': '旧格式角色无法导出：用原图重新创建一个新角色后即可导出',
  'missing-icon': '缺少头像文件，无法导出',
};

async function refresh() {
  const { characters, settings, maxPets } = await window.poppet.list();
  const onScreen = characters.filter(c => c.onScreen).length;
  libraryCapacity = { onScreen, maxPets: maxPets || 6 };
  el.list.innerHTML = '';
  if (!characters.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = '还没有角色，先导入一张图片吧。';
    el.list.appendChild(li);
  }
  for (const c of characters) {
    const li = document.createElement('li');
    // 「在屏幕上」是多选而不是单选——多只可以同时出现
    li.className = 'char-item' + (c.onScreen ? ' active' : '');
    // 导出按钮三态：可导出 -> 正常；非内置但被拦 -> disabled 并说明怎么修；
    // 内置 -> 不渲染（品牌角色禁导出是许可证约束，不摆一个永远点不动的入口）。
    const exportBlocked = !c.exportable && !c.builtin;
    li.innerHTML = `
      <img alt="">
      <div class="char-meta">
        <div class="char-name"></div>
        <div class="char-sub"></div>
      </div>
      <button class="char-on" title="放到屏幕上 / 收起来"></button>
      <button class="char-props" title="动作设置">⚙</button>
      ${c.exportable ? '<button class="char-export" title="导出角色包（.poppetpack）">⇪</button>'
        : exportBlocked ? '<button class="char-export" disabled>⇪</button>' : ''}
      <button class="char-del" title="删除">✕</button>`;
    li.querySelector('img').src = c.iconDataURL || '';
    li.querySelector('.char-name').textContent = c.name;
    li.querySelector('.char-sub').textContent =
      `${c.sprite?.width ?? '?'}×${c.sprite?.height ?? '?'} · ${c.hasFace ? '有表情' : '无表情'}${c.builtin ? ' · 内置' : ''}` +
      (c.onScreen ? ' · 在屏幕上' : '');
    const onBtn = li.querySelector('.char-on');
    const full = !c.onScreen && onScreen >= (maxPets || 6);
    onBtn.textContent = c.onScreen ? '收起' : '放出来';
    onBtn.setAttribute('aria-label', `${c.onScreen ? '收起' : '放出'}角色 ${c.name}`);
    onBtn.disabled = full;
    if (full) onBtn.title = `最多同时 ${maxPets} 只`;
    const toggle = (e) => {
      e.stopPropagation();
      if (!full) window.poppet.activate(c.id).then(refresh).catch(error => {
        console.error('切换桌宠失败:', error);
      });
    };
    onBtn.addEventListener('click', toggle);
    li.addEventListener('click', toggle);
    li.querySelector('.char-props').addEventListener('click', (e) => {
      e.stopPropagation();
      openProps(c.id);
    });
    li.querySelector('.char-props').setAttribute('aria-label', `编辑角色 ${c.name} 的动作设置`);
    const exportBtn = li.querySelector('.char-export');
    if (exportBtn && c.exportable) {
      exportBtn.setAttribute('aria-label', `导出角色 ${c.name} 为角色包`);
      exportBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!c.exportable || exportBtn.disabled) return; // 与 disabled 态一致地 fail-closed
        try {
          const r = await window.poppet.exportPack(c.id);
          if (!r) return; // 用户取消
          if (!r.exported) { alert(r.message || '导出失败'); return; }
          alert(`已导出角色包：\n${r.path}`);
        } catch (error) {
          console.error('导出角色包失败:', error);
          alert('导出失败，角色数据未通过校验。');
        }
      });
    } else if (exportBtn) {
      // disabled 的导出按钮不挂任何处理器：点它永远不会发起导出 IPC。
      const hint = EXPORT_BLOCK_HINTS[c.exportBlockReason] || '当前版本无法导出';
      exportBtn.title = hint;
      exportBtn.setAttribute('aria-label', `角色 ${c.name} 无法导出：${hint}`);
    }
    li.querySelector('.char-del').setAttribute('aria-label', `删除角色 ${c.name}`);
    li.querySelector('.char-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (characters.length <= 1) { alert('至少要留一个角色。'); return; }
      if (!confirm(`删除「${c.name}」？${c.onScreen ? '\n它正在屏幕上，会一起收掉。' : ''}`)) return;
      await window.poppet.remove(c.id);
      refresh();
    });
    el.list.appendChild(li);
  }

  void refreshLoginItem(); // 托盘或系统设置里改过也要跟上（函数声明有提升）
  el.scale.value = String(settings.scale);
  el.wander.checked = !!settings.wander;
  el.clickThrough.checked = !!settings.clickThrough;
  // 手改 settings.json 得到的自定义帧率（8~120）也要如实显示，
  // 不能被下拉框静默吞成第一项。旧的自定义项先清掉，避免逐次刷新堆积。
  for (const option of [...el.fps.options]) {
    if (option.dataset.custom) option.remove();
  }
  const fpsValue = String(settings.fps ?? 60);
  if (![...el.fps.options].some(option => option.value === fpsValue)) {
    const custom = document.createElement('option');
    custom.value = fpsValue;
    custom.dataset.custom = '1';
    custom.textContent = `自定义（${fpsValue} fps）`;
    el.fps.appendChild(custom);
  }
  el.fps.value = fpsValue;
  if (draft && !['processing', 'success'].includes(draft.flowState)) classifyDraftReadiness();
}

el.scale.addEventListener('change', () => window.poppet.setSettings({ scale: Number(el.scale.value) }));
el.wander.addEventListener('change', () => window.poppet.setSettings({ wander: el.wander.checked }));
el.clickThrough.addEventListener('change', () => window.poppet.setSettings({ clickThrough: el.clickThrough.checked }));
el.fps.addEventListener('change', () => window.poppet.setSettings({ fps: Number(el.fps.value) }));
// 开机自启：系统登录项是唯一真相（主进程现读现写，不存 settings 副本）。
// 未打包的开发运行不支持——整行隐藏，不摆一个不生效的开关。
async function refreshLoginItem() {
  try {
    const r = await window.poppet.getLoginItem();
    el.loginItemRow.hidden = !r?.supported;
    if (r?.supported) el.loginItem.checked = !!r.enabled;
  } catch {
    el.loginItemRow.hidden = true;
  }
}
el.loginItem.addEventListener('change', async () => {
  const wanted = el.loginItem.checked;
  try {
    const r = await window.poppet.setLoginItem(wanted);
    el.loginItem.checked = !!r?.enabled; // 以系统回读为准
    if (!!r?.enabled !== wanted) {
      alert('系统未接受开机自启设置的修改，请在系统设置的登录项里调整。');
    }
  } catch {
    void refreshLoginItem();
  }
});
void refreshLoginItem();
window.poppet.onChanged(refresh);

// ============================================================
// 导入
// ============================================================

$('btn-add').addEventListener('click', pickFile);
$('btn-pick').addEventListener('click', pickFile);
$('btn-import-pack').addEventListener('click', async () => {
  try {
    let r = await window.poppet.importPack();
    if (!r) return; // 用户取消
    // rename 已完成但父目录 fsync 未确认：与保存流程一致，做一次幂等确认。
    if (r.persistedId && !r.persisted && r.recoveryMode === 'finalize-import') {
      r = await window.poppet.finalizeImport(r.persistedId);
    }
    if (!r.persisted) {
      alert(r.message || '角色包未通过校验，已原样拒绝。');
    } else if (r.spawnSkipped) {
      alert('角色包已导入并保存；屏幕上已有 6 只桌宠，先收起一只再放出它。');
    } else if (!r.ready) {
      alert(r.message || '角色已保存，但桌宠未能显示；可以在列表中手动放出。');
    }
    refresh();
  } catch (error) {
    console.error('导入角色包失败:', error);
    alert('角色包导入失败。');
    refresh();
  }
});

async function pickFile() {
  try {
    const picked = await window.poppet.pickFile();
    if (picked) await startDraft(picked.dataURL, picked.name, picked);
  } catch (err) {
    alert('读取失败：' + err.message);
  }
}

// 拖放
for (const evt of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.add('dragover'); });
}
for (const evt of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.remove('dragover'); });
}
// 拖放反馈：任何被拒绝的拖入都要说一句为什么，静默忽略等于"应用坏了"。
let dzFeedbackTimer = null;
function showDropFeedback(message) {
  const node = document.getElementById('dz-feedback');
  // 编辑器打开时拖放区整个隐藏，内联反馈没人看得见——退回 alert。
  if (!node || el.dropzone.classList.contains('hidden')) { alert(message); return; }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(dzFeedbackTimer);
  dzFeedbackTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

async function importDroppedPack(file) {
  try {
    let r = await window.poppet.importPackAtPath(file);
    if (!r) { showDropFeedback('无法读取拖入的角色包文件。'); return; }
    if (r.persistedId && !r.persisted && r.recoveryMode === 'finalize-import') {
      r = await window.poppet.finalizeImport(r.persistedId);
    }
    if (!r.persisted) {
      showDropFeedback(r.message || '角色包未通过校验，已原样拒绝。');
    } else if (r.spawnSkipped) {
      showDropFeedback('角色包已导入并保存；屏幕上已有 6 只桌宠，先收起一只再放出它。');
    } else if (!r.ready) {
      showDropFeedback(r.message || '角色已保存，但桌宠未能显示；可以在列表中手动放出。');
    } else {
      showDropFeedback('角色包已导入，桌宠已出现在桌面。');
    }
    refresh();
  } catch (error) {
    console.error('拖放导入角色包失败:', error);
    showDropFeedback('角色包导入失败。');
    refresh();
  }
}

el.dropzone.addEventListener('drop', async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (/\.poppetpack$/i.test(file.name)) { void importDroppedPack(file); return; }
  if (!file.type.startsWith('image/')) {
    showDropFeedback('不支持的文件类型：请拖入 PNG / GIF / WebP / JPG 图片，或 .poppetpack 角色包。');
    return;
  }
  try {
    const T0Local = FLOW_MEASUREMENT_ENABLED ? localFlowNow() : null;
    const picked = await fileToDataURL(file);
    await startDraft(picked.dataURL, file.name.replace(/\.[^.]+$/, ''), {
      ...picked, ...(FLOW_MEASUREMENT_ENABLED ? { timing: { T0Local } } : {}),
    });
  } catch (err) {
    alert('读取失败：' + err.message);
  }
});
// 窗口任意处丢文件也接住，别让浏览器把图片当页面打开；
// 角色包丢在窗口任何位置（包括编辑器打开时）都应当被导入而不是被吞掉。
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.poppetpack$/i.test(file.name)) void importDroppedPack(file);
});

// 进入任一编辑模式前先清干净。startDraft 和 openProps 都不走 closeEditor，
// 不统一重置的话，上一模式的 props-only class、armedPart、离屏缓存会漏到下一个草稿里
// （表现为：先点⚙看过某个角色，再拖新图进来，重框按钮整组是隐藏的）。
function resetEditorState() {
  processEpoch++; // 使已经过了异步让步点的旧任务失效，不能覆盖新草稿
  stopAnim();
  armedPart = null;
  dragBox = null;
  previewFrame = 0;
  _spriteCanvas = null;
  _atlasCanvas = null;
  _atlasSpans = null;
  document.querySelectorAll('.btn-chip').forEach(b => b.classList.remove('armed'));
  document.body.classList.remove('props-only');
  document.body.classList.remove('advanced-open');
  leaveTargetedRecovery();
  el.advanced.open = false;
  showBoxes = false;
  setRectStatus('');
  for (const input of [el.rectX, el.rectY, el.rectW, el.rectH]) {
    input.value = '';
    input.removeAttribute('aria-invalid');
  }
  el.previewHint.textContent = '';
  el.sourcePreview.width = 1;
  el.sourcePreview.height = 1;
  el.resultPreviewLabel.textContent = '处理后 · Original 默认管线';
  syncPixelizeControls({ enabled: false, preset: 'original' });
  el.pixelizeHint.textContent = '';
  el.suggestBlock.classList.add('hidden');
  el.suggestList.innerHTML = '';
  el.cancel.textContent = '取消';
  setReadiness('processing', '正在准备原图预览…');
}

async function startDraft(dataURL, name, preflight = null) {
  const acceptedLocal = FLOW_MEASUREMENT_ENABLED
    ? preflight?.timing?.T0Local ?? localFlowNow() : null;
  const acceptedMain = FLOW_MEASUREMENT_ENABLED && preflight?.timing?.clock === 'main'
    ? preflight.timing.T0 : null;
  const clockPromise = FLOW_MEASUREMENT_ENABLED ? calibrateMainClock() : null;
  const epoch = ++loadEpoch;
  busy('读取图片…');
  try {
    assertDataURLBudget(dataURL);
    if (preflight?.width && preflight?.height) assertImageDimensions(preflight.width, preflight.height, 1);
    // GIF 先走 ImageDecoder，避免同一份压缩数据同时解出 <img> 与全帧两套像素副本。
    const gif = await decodeFrames(dataURL, DEFAULTS.maxFrames);
    const single = gif ? gif[0] : await dataURLToImageData(dataURL, preflight);
    if (epoch !== loadEpoch) return false;
    const clock = clockPromise ? await clockPromise : null;
    if (epoch !== loadEpoch) return false;
    const nextDraft = {
      single,                       // 原图，重新切分网格时要用
      source: gif || single,        // 交给管线的：多帧就是数组
      name: name || '新角色', features: null, result: null,
      pixelize: { enabled: false, preset: 'original' },
      reviewAccepted: false,
      pendingFeatureEdits: false,
      createFailure: null,
      persistedId: null,
      flowState: 'processing',
      timings: clock ? {
        T0: Number.isFinite(acceptedMain) ? acceptedMain : acceptedLocal + clock.offset,
        clock: { domain: 'main-performance', uncertaintyMs: clock.uncertaintyMs },
      } : {},
      timingIssues: {},
    };
    resetEditorState();
    draft = nextDraft;
    syncPixelizeControls(draft.pixelize);
    el.name.value = name || '新角色';
    updateFramesUI();
    // 先把编辑器显示出来再跑管线：layoutPreview 要量容器尺寸，
    // 而 .hidden 是 display:none，在它上面量到的是 0，预览缩放会算错。
    el.dropzone.classList.add('hidden');
    el.editor.classList.remove('hidden');
    renderSourcePreview();
    idle();
    const sourcePainted = await afterVisiblePaint();
    if (epoch !== loadEpoch || draft !== nextDraft) return false;
    await recordPaintTiming(draft, 'T1', sourcePainted);
    setReadiness('processing', '原图已显示，正在生成像素预览…');
    try {
      await process();
      return !!draft?.result;
    } catch {
      return false;
    }
  } catch (err) {
    if (epoch !== loadEpoch) return false;
    if (draft) classifyDraftReadiness();
    alert('读取失败：' + err.message);
    return false;
  } finally {
    if (epoch === loadEpoch && draft?.flowState !== 'processing') idle();
  }
}

async function process({ remapFeatures = false } = {}) {
  busy('分析中…');
  const epoch = ++processEpoch;
  const targetDraft = draft;
  if (!targetDraft || targetDraft.persistedId) { idle(); return null; }
  setReadiness('processing', targetDraft.result ? '正在更新预览；旧预览会保留到新结果完成。' : '正在分析原图…');
  const previousRig = targetDraft.result ? readRig() : null;
  // 让浏览器有机会把忙碌遮罩画出来，再进同步的密集计算
  await new Promise(r => setTimeout(r, 16));
  try {
    if (draft !== targetDraft || epoch !== processEpoch) return null;
    _spriteCanvas = null;   // 精灵变了，离屏缓存作废
    const previousSize = targetDraft.result?.meta?.sprite || null;
    const previousFeatures = remapFeatures ? cloneFeatureSet(targetDraft.features) : null;
    const previousAppendages = remapFeatures && Array.isArray(targetDraft.confirmedAppendages)
      ? targetDraft.confirmedAppendages.map(part => ({ ...part })) : null;
    const options = {
      ...(!remapFeatures && targetDraft.features ? { features: targetDraft.features } : {}),
      // 作者标注的片段跟着草稿走，重新处理时不丢；帧数变了由管线按新帧数裁剪。
      ...(targetDraft.clips ? { clips: targetDraft.clips } : {}),
      pixelize: targetDraft.pixelize,
      deadline: Date.now() + DEFAULTS.processingTimeoutMs,
      shouldCancel: () => draft !== targetDraft || epoch !== processEpoch,
    };
    let result = buildCharacter(targetDraft.source, options);
    let nextFeatures = previousFeatures;
    let nextAppendages = previousAppendages;
    if (draft !== targetDraft || epoch !== processEpoch) return null;
    if (remapFeatures && previousSize) {
      const nextSize = result.meta.sprite;
      if (previousFeatures) {
        nextFeatures = scaleFeatureSet(previousFeatures, previousSize, nextSize);
        result = buildCharacter(targetDraft.source, { ...options, features: nextFeatures });
      }
      if (previousAppendages) {
        nextAppendages = previousAppendages.map(part => scaleRect(part, previousSize, nextSize));
      }
    }
    if (draft !== targetDraft || epoch !== processEpoch) return null;
    if (remapFeatures) {
      targetDraft.features = nextFeatures;
      if (nextAppendages) targetDraft.confirmedAppendages = nextAppendages;
    }
    targetDraft.result = result;
    if (previousRig) targetDraft.result.meta.rig = previousRig;
    fillRig(targetDraft.result.meta.rig);
    targetDraft.pendingFeatureEdits = false;
    targetDraft.lastProcessError = null;
    targetDraft.createFailure = null;
    reapplyAppendages();
    renderSuggestions();
    renderReport(draft.result.report);
    renderPixelizeSummary(draft.result.meta.source.pixelize);
    renderSourcePreview();
    layoutPreview();
    drawPreview(1, 1);
    startFramePlayback();
    classifyDraftReadiness();
    const previewPainted = await afterVisiblePaint();
    if (FLOW_MEASUREMENT_ENABLED && draft === targetDraft
        && epoch === processEpoch && !Object.hasOwn(targetDraft.timings, 'T2')) {
      await recordPaintTiming(targetDraft, 'T2', previewPainted);
    }
    return result;
  } catch (error) {
    if (draft !== targetDraft || epoch !== processEpoch) return null;
    targetDraft.lastProcessError = error?.message || '处理失败';
    setReadiness('failed', `处理失败；原图、样式选择${targetDraft.result ? '和上一个可用预览' : ''}已保留。`, {
      label: '重试处理', run: retryProcessing,
    });
    el.previewHint.textContent = `处理失败，可重试或调整高级选项：${targetDraft.lastProcessError}`;
    throw error;
  } finally {
    if (epoch === processEpoch) idle();
  }
}

function cloneFeatureSet(features) {
  if (!features) return null;
  return {
    eyes: (features.eyes || []).map(rect => rect ? { ...rect } : null),
    mouth: features.mouth ? { ...features.mouth } : null,
  };
}

function scaleRect(rect, from, to) {
  if (!rect || !from?.width || !from?.height || !to?.width || !to?.height) return rect;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const x = Math.max(0, Math.min(to.width - 1, Math.round(rect.x * sx)));
  const y = Math.max(0, Math.min(to.height - 1, Math.round(rect.y * sy)));
  const x1 = Math.max(x + 1, Math.min(to.width, Math.round((rect.x + rect.w) * sx)));
  const y1 = Math.max(y + 1, Math.min(to.height, Math.round((rect.y + rect.h) * sy)));
  return { ...rect, x, y, w: x1 - x, h: y1 - y };
}

function scaleFeatureSet(features, from, to) {
  return {
    eyes: (features.eyes || []).map(rect => rect ? scaleRect(rect, from, to) : null),
    mouth: features.mouth ? scaleRect(features.mouth, from, to) : null,
  };
}

const PIXELIZE_LABEL = {
  tiny: 'Tiny', chunky: 'Chunky', classic: 'Classic', soft: 'Detailed',
};

function readPixelizeControls() {
  const preset = el.pixelizePreset.value;
  if (preset === 'original') return { enabled: false, preset: 'original' };
  const palette = el.pixelizePalette.value;
  return {
    enabled: true,
    preset,
    ...(palette === 'auto' ? {} : { paletteSize: Number(palette) }),
  };
}

function syncPixelizeControls(value) {
  if (!el.pixelizePreset || !el.pixelizePalette) return;
  const preset = value?.enabled === false ? 'original' : (value?.preset || 'original');
  el.pixelizePreset.value = preset;
  el.pixelizePalette.value = Number.isSafeInteger(value?.paletteSize) ? String(value.paletteSize) : 'auto';
  const frozen = draft?.flowState === 'processing' || draft?.flowState === 'success' || !!draft?.persistedId;
  el.pixelizePreset.disabled = frozen;
  el.pixelizePalette.disabled = frozen || preset === 'original';
  for (const button of el.styleChoices) {
    const selected = button.dataset.preset === preset;
    button.setAttribute('aria-pressed', String(selected));
  }
}

function renderPixelizeSummary(meta) {
  if (!meta?.enabled) {
    el.pixelizeHint.textContent = '当前保持原图管线；不会对旧角色意外启用像素化。';
    el.resultPreviewLabel.textContent = '处理后 · Original 默认管线';
    return;
  }
  const label = PIXELIZE_LABEL[meta.preset] || meta.preset;
  el.pixelizeHint.textContent = `${label}：真实输出 ${meta.width}×${meta.height}，${meta.colors} 色，二值透明边缘。`;
  el.resultPreviewLabel.textContent = `处理后 · ${label} ${meta.width}×${meta.height}`;
}

async function applyPixelizeControls() {
  if (!draft || draft.propsOnly || draft.persistedId || draft.flowState === 'processing') return;
  const next = readPixelizeControls();
  draft.pixelize = next;
  draft.reviewAccepted = false;
  syncPixelizeControls(next);
  el.pixelizeHint.textContent = '正在更新预览…';
  draft._stamp = (draft._stamp || 0) + 1;
  _atlasCanvas = null;
  try {
    await process({ remapFeatures: true });
  } catch (error) {
    // buildCharacter 只在完整成功后才替换 draft.result，失败时保留旧预览与手工框。
    syncPixelizeControls(draft.pixelize);
    el.previewHint.textContent = '这个样式处理失败；选择仍保留，可重试，上一个预览未丢失：' + error.message;
  }
}

for (const node of [el.pixelizePreset, el.pixelizePalette]) {
  node.addEventListener('change', () => { void applyPixelizeControls(); });
}
for (const button of el.styleChoices) {
  button.addEventListener('click', () => {
    if (!draft || button.disabled) return;
    el.pixelizePreset.value = button.dataset.preset || 'original';
    void applyPixelizeControls();
  });
}

$('btn-cancel').addEventListener('click', closeEditor);
$('btn-save').addEventListener('click', save);

function closeEditor() {
  loadEpoch++;
  resetEditorState();
  // 骨架面板只属于"正在编辑的那个骨架角色"。不收起来的话，
  // 关掉编辑器再导入一张普通图片，面板还挂在上一只角色的骨架上。
  hideSkeletonPanel();
  draft = null;
  el.editor.classList.add('hidden');
  el.dropzone.classList.remove('hidden');
}

function runSaveSingleFlight(factory) {
  if (saveInFlight) return saveInFlight;
  const target = draft;
  saveInFlight = Promise.resolve().then(factory).finally(() => {
    saveInFlight = null;
    if (draft === target && !['processing', 'success'].includes(target?.flowState)) {
      classifyDraftReadiness();
    }
  });
  return saveInFlight;
}

function save() {
  if (!draft?.result) {
    if (draft) classifyDraftReadiness();
    return Promise.resolve(null);
  }
  if (draft.flowState !== 'ready') {
    classifyDraftReadiness();
    return Promise.resolve(null);
  }
  const target = draft;
  const activatedAt = FLOW_MEASUREMENT_ENABLED ? localFlowNow() : null;
  return runSaveSingleFlight(() => performSave(target, activatedAt));
}

async function recordT6(target) {
  if (!FLOW_MEASUREMENT_ENABLED) return;
  const raw = await flowNow();
  target.timings.T6Raw = raw;
  target.timingIssues ||= {};
  delete target.timingIssues.T6;
  if (!Number.isFinite(raw)) {
    target.timings.T6 = null;
    target.timingIssues.T6 = 'POPPET_T6_UNAVAILABLE';
    return;
  }
  if (Number.isFinite(target.timings.T5) && raw < target.timings.T5) {
    // Renderer/main clock calibration has finite uncertainty. Preserve the raw
    // observation for diagnosis, but never clamp it into fabricated ordering.
    target.timings.T6 = null;
    target.timingIssues.T6 = 'POPPET_CLOCK_INVERSION';
    return;
  }
  target.timings.T6 = raw;
}

async function performSave(target, activatedAt) {
  if (draft !== target || !target?.result) return null;
  busy(target.propsOnly ? '保存中…' : '创建中…');
  setReadiness('processing', target.propsOnly ? '正在保存动作设置…' : '正在保存并等待桌宠首帧…');
  try {
    if (target.propsOnly) {
      await window.poppet.updateMeta(target.id, {
        rig: readRig(),
        name: (el.name.value || '').trim() || target.name,
      });
      closeEditor();
      await refresh();
      return { ready: true, id: target.id };
    }

    if (FLOW_MEASUREMENT_ENABLED) target.timings.T3 = await flowNow(activatedAt);
    const r = target.result;
    const files = { 'pet.png': await imageToArrayBuffer(r.sprite), 'icon.png': await imageToArrayBuffer(r.icon) };
    if (r.atlas) files['parts.png'] = await imageToArrayBuffer(r.atlas);
    const response = await window.poppet.import({
      name: (el.name.value || '').trim() || target.name,
      meta: { ...r.meta, rig: readRig() },
      files,
    });
    if (draft !== target) return response;

    target.persistedId = response?.persistedId || response?.id || null;
    if (target.persistedId) {
      // 角色已在主进程持久化：全尺寸原图 / GIF 全帧源（照片输入可达
      // ~64+64MiB）不再被任何路径需要——retryCreate 只在没有 persistedId
      // 时走 save()（用的是 result，不是 source），重处理/重切网格都被
      // persistedId 闸门挡住，两处兜底读点（updateFramesUI /
      // renderSourcePreview）对 null 安全。及时释放，别让像素陪着
      // 成功页面一直活到窗口关闭。
      target.single = null;
      target.source = null;
    }
    target.recoveryMode = response?.recoveryMode || null;
    target.persistencePending = response?.recoveryMode === 'finalize-import' && !response?.persisted;
    if (FLOW_MEASUREMENT_ENABLED && Number.isFinite(response?.timing?.T4)) {
      target.timings.T4 = response.timing.T4;
    }
    if (FLOW_MEASUREMENT_ENABLED && Number.isFinite(response?.timing?.T5)) {
      target.timings.T5 = response.timing.T5;
    }
    if (!response?.ready) {
      target.createFailure = response?.message || '角色已经安全保存，但桌宠还没有画出首帧。';
      classifyDraftReadiness();
      await refresh();
      return response;
    }

    await recordT6(target);
    target.createFailure = null;
    setReadiness('success', '桌宠已出现在桌面！可以直接拖动它，右键它打开菜单；在左侧列表勾选可同时放出最多 6 只。');
    el.cancel.textContent = '完成';
    const successPainted = await afterVisiblePaint();
    await recordPaintTiming(target, 'successVisibleAt', successPainted);
    await refresh();
    return { ...response, timing: { ...target.timings } };
  } catch (error) {
    if (draft === target) {
      target.createFailure = error?.message || '创建失败；草稿仍保留。';
      setReadiness('failed', `创建失败；原图、选择和草稿都已保留。${target.createFailure}`, {
        label: target.persistedId ? '重试显示桌宠' : '重试创建',
        run: target.persistedId ? retryPersistedPet : retryCreate,
      });
    }
    return { ready: false, persistedId: target.persistedId || null, message: target.createFailure };
  } finally {
    idle();
  }
}

function retryProcessing() {
  if (!draft || draft.persistedId) return Promise.resolve(null);
  draft.lastProcessError = null;
  return process({ remapFeatures: !!draft.result }).catch(() => null);
}

function retryCreate() {
  if (!draft || draft.persistedId) return retryPersistedPet();
  draft.createFailure = null;
  classifyDraftReadiness();
  return draft.flowState === 'ready' ? save() : Promise.resolve(null);
}

function retryPersistedPet() {
  if (!draft?.persistedId) return Promise.resolve(null);
  const target = draft;
  return runSaveSingleFlight(async () => {
    busy('正在重新显示桌宠…');
    setReadiness('processing', target.persistencePending
      ? '正在重新确认本地持久化，完成后才会显示桌宠…'
      : '角色已保存，正在重新等待桌宠首帧…');
    try {
      const response = target.persistencePending
        ? await window.poppet.finalizeImport(target.persistedId)
        : await window.poppet.ensureActive(target.persistedId);
      if (draft !== target) return response;
      target.recoveryMode = response?.recoveryMode || null;
      target.persistencePending = response?.recoveryMode === 'finalize-import' && !response?.persisted;
      if (FLOW_MEASUREMENT_ENABLED && Number.isFinite(response?.timing?.T4)) {
        target.timings.T4 = response.timing.T4;
      }
      if (!response?.ready) {
        target.createFailure = response?.message || '桌宠仍未画出首帧，可以再次重试。';
        classifyDraftReadiness();
        return response;
      }
      if (FLOW_MEASUREMENT_ENABLED && Number.isFinite(response?.timing?.T5)) {
        target.timings.T5 = response.timing.T5;
      }
      await recordT6(target);
      target.createFailure = null;
      setReadiness('success', '已保存的桌宠已在桌面画出首个非空帧。');
      el.cancel.textContent = '完成';
      const successPainted = await afterVisiblePaint();
      await recordPaintTiming(target, 'successVisibleAt', successPainted);
      await refresh();
      return { ...response, timing: { ...target.timings } };
    } catch (error) {
      if (draft === target) {
        target.createFailure = error?.message || '桌宠仍未画出首帧，可以再次重试。';
        classifyDraftReadiness();
      }
      return { ready: false, persistedId: target.persistedId, message: target.createFailure };
    } finally {
      idle();
    }
  });
}

// —— 多帧素材控件 ——

function frameCount() {
  return Array.isArray(draft?.source) ? draft.source.length : 1;
}

// "4-11" / "4" -> [4, 11]。空串表示"这段不标注"，与非法输入区分开：
// 前者是作者的选择（回落到待机），后者要报错，不能默默当成没写。
function parseClipRange(text, count) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(raw);
  if (!m) return 'bad';
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'bad';
  if (start < 0 || end < start || end >= count) return 'range';
  return [start, end];
}

function collectClips(count) {
  const fields = [['idle', el.clipIdle], ['walk', el.clipWalk], ['drag', el.clipDrag], ['greet', el.clipGreet]];
  const clips = {};
  for (const [name, input] of fields) {
    const parsed = parseClipRange(input.value, count);
    if (parsed === null) continue;
    if (parsed === 'bad') return { error: `${input.previousElementSibling?.textContent || name} 的区间要写成 0-3 这样的形式。` };
    if (parsed === 'range') return { error: `${input.previousElementSibling?.textContent || name} 的区间超出 0-${count - 1}。` };
    clips[name] = parsed;
  }
  return { clips: Object.keys(clips).length ? clips : null };
}

function showClips(meta, n) {
  el.clipsRow.hidden = n < 2;
  if (n < 2) return;
  const clips = (meta && meta.frames && meta.frames.clips) || {};
  const set = (input, name) => {
    if (document.activeElement === input) return;   // 别覆盖正在输入的内容
    const r = clips[name];
    input.value = r ? (r[0] === r[1] ? String(r[0]) : `${r[0]}-${r[1]}`) : '';
  };
  set(el.clipIdle, 'idle'); set(el.clipWalk, 'walk');
  set(el.clipDrag, 'drag'); set(el.clipGreet, 'greet');
  const named = Object.keys(clips);
  el.clipsHint.textContent = named.length
    ? `已分段：${named.join('、')}。没标注的状态会回落到待机段。`
    : `帧号 0-${n - 1}。不分段就整条循环；标了待机与走路，走动时才会播走路那几帧。`;
}

function updateFramesUI() {
  if (!draft) return;
  const n = frameCount();
  const s = draft.single;
  showClips(draft.result?.meta, n);
  if (n > 1) {
    el.framesHint.textContent = `已识别为 ${n} 帧动画，会逐帧播放。多帧素材不再叠加眨眼与嘴型。`;
  } else if (s) {
    // 帧多半是方的，用宽高比猜个默认列数，猜错了用户改一下就行
    const guess = Math.max(1, Math.min(32, Math.round(s.width / s.height)));
    el.gridCols.value = String(guess);
    el.gridRows.value = '1';
    el.framesHint.textContent = '这是一张单帧图。如果它其实是排成网格的动画表，填上行列数再切分。';
  }
}

$('btn-slice').addEventListener('click', async () => {
  if (!draft?.single || draft.persistedId) return;
  const cols = Math.max(1, Math.min(32, Number(el.gridCols.value) || 1));
  const rows = Math.max(1, Math.min(32, Number(el.gridRows.value) || 1));
  if (cols * rows < 2) { el.framesHint.textContent = '行列数至少要切出 2 帧。'; return; }
  if (cols * rows > DEFAULTS.maxFrames) {
    el.framesHint.textContent = `最多切成 ${DEFAULTS.maxFrames} 帧。`;
    return;
  }
  try {
    const frames = dropEmptyFrames(sliceGrid(draft.single, cols, rows));
    if (frames.length < 2) { el.framesHint.textContent = '切出来只有一帧有内容，检查一下行列数。'; return; }
    draft.source = frames;
    draft.features = null;
    draft.clips = null;   // 帧数变了，旧区间不再指向同一批画面
    draft.reviewAccepted = false;
    draft._stamp = (draft._stamp || 0) + 1;
    _atlasCanvas = null;
    await process();
    updateFramesUI();
  } catch (err) {
    el.framesHint.textContent = err.message;
  }
});

$('btn-clips').addEventListener('click', async () => {
  if (!draft || draft.persistedId) return;
  const n = frameCount();
  if (n < 2) { el.clipsHint.textContent = '先把素材切成多帧再分段。'; return; }
  const { clips, error } = collectClips(n);
  if (error) { el.clipsHint.textContent = error; return; }
  draft.clips = clips;
  draft._stamp = (draft._stamp || 0) + 1;
  await process();
  updateFramesUI();
});

$('btn-unslice').addEventListener('click', async () => {
  if (!draft?.single || draft.persistedId) return;
  draft.source = draft.single;
  draft.features = null;
  draft.clips = null;
  draft.reviewAccepted = false;
  draft._stamp = (draft._stamp || 0) + 1;
  _atlasCanvas = null;
  await process().catch(() => null);
  updateFramesUI();
});

// —— 动作方式控件 ——

function readRig() {
  return {
    motion: el.rigMotion.value,
    anchor: el.rigAnchor.value,
    flip: el.rigFlip.checked,
    swayFrom: el.rigSway.checked ? (draft?.result?.meta?.rig?.swayFrom ?? DEFAULT_RIG.swayFrom) || 0.5 : null,
  };
}

function fillRig(rig) {
  const r = { ...DEFAULT_RIG, ...(rig || {}) };
  el.rigMotion.value = r.motion;
  el.rigAnchor.value = r.anchor;
  el.rigFlip.checked = !!r.flip;
  el.rigSway.checked = r.swayFrom !== null && r.swayFrom !== undefined;
}

for (const node of [el.rigMotion, el.rigAnchor, el.rigFlip, el.rigSway]) {
  node.addEventListener('change', () => {
    if (!draft?.result || draft.persistedId) return;
    draft.result.meta.rig = readRig();
    // 悬浮就顺手把基准也切过去，两个选项配不上会很别扭
    if (el.rigMotion.value === 'float' && el.rigAnchor.value === 'feet') {
      el.rigAnchor.value = 'center';
      draft.result.meta.rig.anchor = 'center';
    }
    if (draft.propsOnly) window.poppet.updateMeta(draft.id, { rig: draft.result.meta.rig });
  });
}

// 只改属性模式：载入已保存的角色，不重跑管线
async function openProps(id) {
  const c = await window.poppet.load(id);
  if (!c) return;
  resetEditorState();
  const img = await loadImage(c.spriteDataURL);
  const cnv = document.createElement('canvas');
  cnv.width = img.naturalWidth; cnv.height = img.naturalHeight;
  const cx = cnv.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = false;
  cx.drawImage(img, 0, 0);
  const sd = cx.getImageData(0, 0, cnv.width, cnv.height);
  const sprite = { width: sd.width, height: sd.height, data: sd.data };

  let atlas = null;
  if (c.atlasDataURL) {
    const ai = await loadImage(c.atlasDataURL);
    const ac = document.createElement('canvas');
    ac.width = ai.naturalWidth; ac.height = ai.naturalHeight;
    const acx = ac.getContext('2d', { willReadFrequently: true });
    acx.imageSmoothingEnabled = false;
    acx.drawImage(ai, 0, 0);
    const ad = acx.getImageData(0, 0, ac.width, ac.height);
    atlas = { width: ad.width, height: ad.height, data: ad.data };
  }

  draft = {
    propsOnly: true, id, name: c.meta.name || id, features: null,
    result: { sprite, atlas, icon: null, meta: c.meta, report: { steps: [], warnings: [] } },
    flowState: 'ready', timings: {}, reviewAccepted: true,
  };
  draft._stamp = (draft._stamp || 0) + 1;
  el.name.value = draft.name;
  el.dropzone.classList.add('hidden');
  el.editor.classList.remove('hidden');
  document.body.classList.add('props-only');
  fillRig(c.meta.rig);
  showSkeleton(c.meta, atlas);
  el.report.innerHTML = c.meta.skeleton
    ? '<li>正在编辑已保存的骨架角色。动作设置与骨架都可以改，不会重新处理图片。</li>'
    : '<li>正在编辑已保存的角色，只会改动作设置，不会重新处理图片。</li>';
  layoutPreview();
  drawPreview(1, 1);
  setReadiness('ready', '动作设置可以保存；不会重新处理角色图片。');
}

function renderReport(report) {
  el.report.innerHTML = '';
  for (const s of report.steps) {
    const li = document.createElement('li');
    li.textContent = s;
    if (/检测到双眼/.test(s)) li.className = 'ok';
    el.report.appendChild(li);
  }
  for (const w of report.warnings) {
    const li = document.createElement('li');
    li.className = 'warn';
    li.textContent = w;
    el.report.appendChild(li);
  }
}

// ============================================================
// 预览与校准
// ============================================================

// 原图只画一个有界缩略图：不为 8K 输入再建一张同尺寸 canvas，避免“做对比”
// 本身把 GPU/内存预算翻倍。逐点最近邻采样也不会把像素风预览抹糊。
function renderSourcePreview() {
  const source = draft?.single || (Array.isArray(draft?.source) ? draft.source[0] : draft?.source);
  if (!source?.data || !source.width || !source.height || draft?.propsOnly) return;
  const maxSide = 192;
  const factor = Math.min(1, maxSide / source.width, maxSide / source.height);
  const width = Math.max(1, Math.round(source.width * factor));
  const height = Math.max(1, Math.round(source.height * factor));
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(source.height - 1, Math.floor(y * source.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(source.width - 1, Math.floor(x * source.width / width));
      const from = (sy * source.width + sx) * 4;
      const to = (y * width + x) * 4;
      pixels[to] = source.data[from];
      pixels[to + 1] = source.data[from + 1];
      pixels[to + 2] = source.data[from + 2];
      pixels[to + 3] = source.data[from + 3];
    }
  }
  el.sourcePreview.width = width;
  el.sourcePreview.height = height;
  sourceCtx.putImageData(new ImageData(pixels, width, height), 0, 0);
}

function layoutPreview() {
  // 多帧时 result.sprite 是整条帧带，画布只画单帧
  const s = draft.result.meta.sprite;
  const wrap = el.preview.parentElement;
  const maxH = wrap.clientHeight - 60;
  const maxW = wrap.clientWidth - 40;
  // 整数倍放大，像素才不会被拉花
  const zoom = Math.max(1, Math.floor(Math.min(maxH / s.height, maxW / s.width)));
  draft.previewScale = zoom;
  el.preview.width = s.width;
  el.preview.height = s.height;
  el.preview.style.width = s.width * zoom + 'px';
  el.preview.style.height = s.height * zoom + 'px';
  ctx.imageSmoothingEnabled = false;
}

// 复刻运行时的合成逻辑，让"保存前看到的"就是"桌面上跑的"
function drawPreview(blink, mouthOpen) {
  if (!draft?.result) return;
  const { sprite, meta } = draft.result;
  const atlas = draft.result.atlas;
  const base = spriteCanvas();
  if (meta.frames) {
    // 从帧带里裁出当前帧
    const fw = meta.sprite.width, fh = meta.sprite.height;
    const i = previewFrame % meta.frames.count;
    ctx.clearRect(0, 0, fw, fh);
    ctx.drawImage(base, i * fw, 0, fw, fh, 0, 0, fw, fh);
    if (showBoxes) drawBoxes();
    return;
  }
  ctx.clearRect(0, 0, sprite.width, sprite.height);
  ctx.drawImage(base, 0, 0);

  const parts = meta.parts;
  const eyes = eyesOf(parts);
  if (atlas) {
    const atlasCanvas = getAtlasCanvas();
    for (const p of eyes) {
      const name = p.id;
      if (blink >= 0.999) break;
      ctx.drawImage(atlasCanvas, p.cleanFrame.sx, p.cleanFrame.sy, p.w, p.h, p.x, p.y, p.w, p.h);
      const keep = Math.max(0, Math.round(p.h * blink));
      if (keep > 0) {
        ctx.drawImage(atlasCanvas, p.frame.sx, p.frame.sy + (p.h - keep), p.w, keep, p.x, p.y + (p.h - keep), p.w, keep);
      }
      // 只要眼睛有一点闭合就补这条眼睑线。
      // 眼睛顶部原本就有一条睫毛线，按 blink 裁掉上部时它一起被裁走了，
      // 这条线正是把它补回来。
      if (blink < 0.95) {
        const span = atlasRowSpan(name, p.h - keep);
        if (span) {
          ctx.fillStyle = `rgb(${meta.outline.join(',')})`;
          ctx.fillRect(p.x + span[0], p.y + p.h - keep, span[1] - span[0] + 1, 1);
        }
      }
    }
    // 嘴部动画不能依赖眼睛是否存在。墨镜角色安全地关闭眨眼后，
    // 仍应能正常说话；手工只框嘴的角色也同理。
    const m = mouthOf(parts);
    if (m && Math.abs(mouthOpen - 1) > 0.001) {
      ctx.drawImage(atlasCanvas, m.cleanFrame.sx, m.cleanFrame.sy, m.w, m.h, m.x, m.y, m.w, m.h);
      ctx.drawImage(atlasCanvas, m.frame.sx, m.frame.sy, m.w, m.h, m.x, m.y, m.w, Math.max(1, Math.round(m.h * mouthOpen)));
    }
  }

  if (showBoxes) drawBoxes();
  if (dragBox) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(dragBox.x + .5, dragBox.y + .5, dragBox.w - 1, dragBox.h - 1);
    ctx.setLineDash([]);
  }
}

function drawBoxes() {
  const parts = draft.result.meta.parts;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  eyesOf(parts).forEach((p, i) => {
    ctx.strokeStyle = PART_COLORS['eye' + i] || '#fff';
    ctx.strokeRect(p.x + .5, p.y + .5, p.w - 1, p.h - 1);
  });
  const mouth = mouthOf(parts);
  if (mouth) {
    ctx.strokeStyle = PART_COLORS.mouth;
    ctx.strokeRect(mouth.x + .5, mouth.y + .5, mouth.w - 1, mouth.h - 1);
  }
  // 已确认的可动部件画实线，候选画虚线——"待你确认"和"已经算数"必须一眼分得开
  for (const a of normalizeParts(parts).filter(p => p.role === 'appendage')) {
    ctx.setLineDash([]);
    ctx.strokeStyle = SUGGEST_COLORS[a.sublabel] || '#fff';
    ctx.strokeRect(a.x + .5, a.y + .5, a.w - 1, a.h - 1);
  }
  ctx.setLineDash([4, 3]);
  for (const sg of draft.result.meta.suggestions || []) {
    ctx.strokeStyle = SUGGEST_COLORS[sg.sublabel] || '#fff';
    ctx.strokeRect(sg.x + .5, sg.y + .5, sg.w - 1, sg.h - 1);
  }
  ctx.setLineDash([]);
}

let _atlasCanvas = null, _atlasKey = null, _atlasSpans = null;
let _spriteCanvas = null;

// 精灵是静态的，缓存成离屏 canvas，每帧只 drawImage 一次。
// 之前每帧都 new ImageData(new Uint8ClampedArray(...)) 再 putImageData——
// 191x400 的图一帧就是 305KB 的复制，24fps 下每秒 7MB，预览动画肉眼可见地卡。
function spriteCanvas() {
  if (_spriteCanvas) return _spriteCanvas;
  const img = draft.result.sprite;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  cx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  _spriteCanvas = c;
  return c;
}

function getAtlasCanvas() {
  const a = draft.result.atlas;
  const key = draft.result.meta.atlas ? `${a.width}x${a.height}:${draft._stamp}` : 'none';
  if (_atlasCanvas && _atlasKey === key) return _atlasCanvas;
  const c = document.createElement('canvas');
  c.width = a.width; c.height = a.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = false;
  putImage(cx, a, 0, 0);
  _atlasCanvas = c;
  _atlasKey = key;
  // 预读每行的不透明区间，眼睑线只画在这个范围内
  const data = cx.getImageData(0, 0, c.width, c.height).data;
  _atlasSpans = {};
  const allParts = normalizeParts(draft.result.meta.parts);
  for (const p of allParts) {
    if (!p.frame) continue;
    const name = p.id;
    const rows = [];
    for (let y = 0; y < p.h; y++) {
      let min = -1, max = -1;
      for (let x = 0; x < p.w; x++) {
        if (data[((p.frame.sy + y) * c.width + p.frame.sx + x) * 4 + 3] > 0) { if (min < 0) min = x; max = x; }
      }
      rows.push(min < 0 ? null : [min, max]);
    }
    _atlasSpans[name] = rows;
  }
  return c;
}

function atlasRowSpan(name, row) {
  const rows = _atlasSpans?.[name];
  if (!rows) return null;
  for (let y = Math.max(0, Math.min(row, rows.length - 1)); y < rows.length; y++) if (rows[y]) return rows[y];
  return null;
}

// —— 可动部件候选：提名 + 确认 ——
//
// 自动检测只走到"提名"为止。真实素材上命名不可靠（老鼠的尾巴会被判成"腿"）、
// 定位也不完美（天使的翅膀会框到袍角），所以这里必须由人点一下。
// 确认后写进 parts 并标 source:'user'——重新处理时不会被自动结果覆盖。
function renderSuggestions() {
  const meta = draft?.result?.meta;
  const list = (meta && meta.suggestions) || [];
  const confirmed = normalizeParts(meta && meta.parts).filter(p => p.role === 'appendage');
  el.suggestList.innerHTML = '';
  if (!list.length && !confirmed.length) { el.suggestBlock.classList.add('hidden'); return; }
  el.suggestBlock.classList.remove('hidden');

  for (const c of confirmed) {
    const li = document.createElement('li');
    li.style.setProperty('--suggest-color', SUGGEST_COLORS[c.sublabel] || '#9aa');
    li.innerHTML = `<span class="s-name">已确认<span class="s-sub">${c.sublabel || '可动部件'}</span></span>`;
    const del = document.createElement('button');
    del.className = 'btn'; del.textContent = '撤销';
    del.addEventListener('click', () => { unconfirmAppendage(c.id); });
    li.appendChild(del);
    el.suggestList.appendChild(li);
  }
  for (const sg of list) {
    const li = document.createElement('li');
    li.style.setProperty('--suggest-color', SUGGEST_COLORS[sg.sublabel] || '#9aa');
    li.innerHTML = `<span class="s-name">${SUGGEST_LABEL[sg.sublabel] || '可动部件？'}` +
                   `<span class="s-sub">${sg.w}x${sg.h}</span></span>`;
    const yes = document.createElement('button');
    yes.className = 'btn btn-primary'; yes.textContent = '是';
    yes.addEventListener('click', () => confirmSuggestion(sg.id));
    const no = document.createElement('button');
    no.className = 'btn'; no.textContent = '不是';
    no.addEventListener('click', () => rejectSuggestion(sg.id));
    li.append(yes, no);
    el.suggestList.appendChild(li);
  }
}

function confirmSuggestion(id) {
  if (draft?.persistedId) return;
  const meta = draft.result.meta;
  const i = (meta.suggestions || []).findIndex(s => s.id === id);
  if (i < 0) return;
  const [sg] = meta.suggestions.splice(i, 1);
  // source:'user' 是自动检测与人工确认之间的记账线——没有它，
  // 重新处理时就分不出哪些部件是人点过头的，会被自动结果直接盖掉。
  meta.parts.push({ ...sg, source: SOURCE_USER });
  // 确认过的候选另存一份，"按新框重新处理"会重建整个 meta，靠它把人的选择带回来
  draft.confirmedAppendages = normalizeParts(meta.parts).filter(p => p.role === 'appendage');
  refreshSuggestUI();
}

function rejectSuggestion(id) {
  if (draft?.persistedId) return;
  const meta = draft.result.meta;
  meta.suggestions = (meta.suggestions || []).filter(s => s.id !== id);
  draft.rejectedAppendages = [...(draft.rejectedAppendages || []), id];
  refreshSuggestUI();
}

function unconfirmAppendage(id) {
  if (draft?.persistedId) return;
  const meta = draft.result.meta;
  const keep = [], back = [];
  for (const p of normalizeParts(meta.parts)) (p.role === 'appendage' && p.id === id ? back : keep).push(p);
  meta.parts = keep;
  meta.suggestions = [...(meta.suggestions || []), ...back.map(({ source, ...rest }) => rest)]
    .sort((a, b) => (b.areaRatio || 0) - (a.areaRatio || 0));
  draft.confirmedAppendages = keep.filter(p => p.role === 'appendage');
  refreshSuggestUI();
}

function refreshSuggestUI() {
  renderSuggestions();
  drawPreview(1, 1);
}

// 重新处理会重建整个 meta，人已经点过的选择要带回来
function reapplyAppendages() {
  const meta = draft?.result?.meta;
  if (!meta) return;
  const rejected = new Set(draft.rejectedAppendages || []);
  meta.suggestions = (meta.suggestions || []).filter(s => !rejected.has(s.id));
  for (const a of draft.confirmedAppendages || []) {
    if (!meta.parts.some(p => p.id === a.id)) meta.parts.push({ ...a, source: SOURCE_USER });
    meta.suggestions = meta.suggestions.filter(s => s.id !== a.id);
  }
}

// —— 手动框选 ——

// 把当前检测结果快照成可编辑的 features。之后所有手动改动都改这份快照，
// 点「按新框重新处理」时整份灌回管线。
function ensureFeatures() {
  if (draft.features) return draft.features;
  const parts = draft.result.meta.parts;
  draft.features = { eyes: eyesOf(parts).map(rectOf), mouth: rectOf(mouthOf(parts)) };
  return draft.features;
}

function featureRect(part) {
  if (!draft?.result) return null;
  if (draft.features) {
    if (part === 'mouth') return draft.features.mouth || null;
    return draft.features.eyes?.[Number(part.slice(3))] || null;
  }
  const parts = draft.result.meta.parts;
  return part === 'mouth'
    ? rectOf(mouthOf(parts))
    : rectOf(eyesOf(parts)[Number(part.slice(3))]);
}

function setRectStatus(message, error = false) {
  el.rectStatus.textContent = message || '';
  el.rectStatus.classList.toggle('error', !!error);
}

function loadRectEditor(part = el.rectPart.value, announce = false) {
  if (!PART_LABEL[part]) part = 'eye0';
  el.rectPart.value = part;
  const size = draft?.result?.meta?.sprite;
  const inputs = [el.rectX, el.rectY, el.rectW, el.rectH];
  for (const input of inputs) input.removeAttribute('aria-invalid');
  if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) {
    for (const input of inputs) input.value = '';
    if (announce) setRectStatus('先完成图片处理，再输入坐标。', true);
    return;
  }
  el.rectX.max = String(Math.max(0, size.width - 1));
  el.rectY.max = String(Math.max(0, size.height - 1));
  el.rectW.max = String(size.width);
  el.rectH.max = String(size.height);
  const rect = featureRect(part);
  if (!rect) {
    for (const input of inputs) input.value = '';
    if (announce) setRectStatus(`${PART_LABEL[part]} 当前没有框；请输入 X、Y、宽、高。`);
    return;
  }
  [el.rectX.value, el.rectY.value, el.rectW.value, el.rectH.value] =
    [rect.x, rect.y, rect.w, rect.h].map(String);
  if (announce) setRectStatus(`已载入${PART_LABEL[part]}的当前框。`);
}

function readRectEditor() {
  const size = draft?.result?.meta?.sprite;
  const inputs = [el.rectX, el.rectY, el.rectW, el.rectH];
  const names = ['X', 'Y', '宽', '高'];
  const values = inputs.map(input => input.value.trim() === '' ? NaN : Number(input.value));
  const badInteger = values.findIndex(value => !Number.isSafeInteger(value));
  for (const input of inputs) input.removeAttribute('aria-invalid');
  if (badInteger >= 0) {
    inputs[badInteger].setAttribute('aria-invalid', 'true');
    setRectStatus(`${names[badInteger]}必须是整数。`, true);
    return null;
  }
  const [x, y, w, h] = values;
  let message = null;
  if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) {
    message = '当前预览尺寸不可用。';
  } else if (x < 0 || y < 0) {
    message = 'X、Y 不能小于 0。';
  } else if (w < 3 || h < 3) {
    message = '宽和高至少为 3 像素，与拖拽框选规则一致。';
  } else if (!Number.isSafeInteger(x + w) || !Number.isSafeInteger(y + h)
      || x + w > size.width || y + h > size.height) {
    message = `框必须完整位于 ${size.width}×${size.height} 的精灵范围内。`;
  } else if (!Number.isSafeInteger(w * h) || w * h > DEFAULTS.maxWorkingPixels) {
    message = `框的像素预算不能超过 ${DEFAULTS.maxWorkingPixels}。`;
  }
  if (message) {
    for (const input of inputs) input.setAttribute('aria-invalid', 'true');
    setRectStatus(message, true);
    return null;
  }
  return { x, y, w, h, source: SOURCE_USER };
}

function setFeatureRect(part, rect) {
  const features = ensureFeatures();
  if (part === 'mouth') {
    features.mouth = rect;
    return;
  }
  const index = Number(part.slice(3));
  features.eyes ||= [];
  features.eyes[index] = rect;
}

async function reprocessFeatures() {
  if (draft?.persistedId) return null;
  if (!draft?.features) {
    el.previewHint.textContent = '还没画新框或输入坐标';
    return null;
  }
  draft._stamp = (draft._stamp || 0) + 1;
  _atlasCanvas = null;
  return process().catch(() => null);
}

async function applyRectEditor() {
  if (!draft?.result || draft.persistedId) return null;
  const rect = readRectEditor();
  if (!rect) return null;
  const part = el.rectPart.value;
  setFeatureRect(part, rect);
  draft.pendingFeatureEdits = true;
  draft.reviewAccepted = false;
  classifyDraftReadiness();
  drawPreview(1, 1);
  drawPendingBoxes();
  setRectStatus(`正在应用${PART_LABEL[part]}坐标并重新处理…`);
  const result = await reprocessFeatures();
  if (result && draft?.result) {
    loadRectEditor(part);
    setRectStatus(`${PART_LABEL[part]}坐标已应用到当前预览。`);
  }
  return result;
}

el.rectPart.addEventListener('change', () => loadRectEditor(el.rectPart.value, true));
$('btn-load-rect').addEventListener('click', () => loadRectEditor(el.rectPart.value, true));
$('btn-apply-rect').addEventListener('click', () => { void applyRectEditor(); });

// 删掉认错的部件。自动检测的另一半是「认错了能不能撤」——
// 在此之前只能重新框，没法删：把纽扣认成眼睛的角色会一直用纽扣眨眼，
// 用户除了整张图重来没有别的出路。
$('btn-del-part').addEventListener('click', () => {
  if (!draft?.result || draft.persistedId) return;
  if (!armedPart) { el.previewHint.textContent = '先点上面的部件按钮选中要删的那个'; return; }
  const f = ensureFeatures();
  if (armedPart === 'mouth') f.mouth = null;
  else {
    // 留空洞而不是压实：压实会让后面的眼睛整体前移，下标就对不上按钮了。
    // 空洞由 pipeline 的 rectsToBlobs 在消费端 filter 掉。
    const idx = Number(armedPart.slice(3));
    f.eyes = f.eyes || [];
    if (idx < f.eyes.length) f.eyes[idx] = null;
  }
  const changedPart = armedPart;
  el.previewHint.textContent = `${PART_LABEL[changedPart]} 已标记删除，点「按新框重新处理」生效`;
  draft.pendingFeatureEdits = true;
  classifyDraftReadiness();
  armedPart = null;
  document.querySelectorAll('.btn-chip').forEach(b => b.classList.remove('armed'));
  loadRectEditor(changedPart, true);
  drawPreview(1, 1);
  drawPendingBoxes();
});

document.querySelectorAll('.btn-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    if (draft?.persistedId) return;
    const part = btn.dataset.part;
    el.rectPart.value = part;
    loadRectEditor(part);
    armedPart = armedPart === part ? null : part;
    document.querySelectorAll('.btn-chip').forEach(b => b.classList.toggle('armed', b.dataset.part === armedPart));
    el.previewHint.textContent = armedPart
      ? `在预览图上拖出「${PART_LABEL[armedPart]}」的范围（把整只眼睛都框进去），或者点「删掉选中的部件」`
      : '';
  });
});

el.preview.addEventListener('mousedown', (e) => {
  if (!armedPart || !draft?.result || draft.persistedId) return;
  const p = toSpriteCoords(e);
  dragBox = { x0: p.x, y0: p.y, x: p.x, y: p.y, w: 1, h: 1 };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragBox) return;
  const p = toSpriteCoords(e);
  dragBox.x = Math.min(dragBox.x0, p.x);
  dragBox.y = Math.min(dragBox.y0, p.y);
  dragBox.w = Math.abs(p.x - dragBox.x0) + 1;
  dragBox.h = Math.abs(p.y - dragBox.y0) + 1;
  drawPreview(1, 1);
});

window.addEventListener('mouseup', () => {
  if (!dragBox) return;
  const box = dragBox;
  dragBox = null;
  if (box.w < 3 || box.h < 3) { drawPreview(1, 1); return; }
  ensureFeatures();
  // 人真的拖出来的框才标 user——重新处理时它不该被自动检测覆盖
  const changedPart = armedPart;
  const rect = { x: box.x, y: box.y, w: box.w, h: box.h, source: SOURCE_USER };
  if (changedPart === 'mouth') draft.features.mouth = rect;
  else {
    const idx = Number(changedPart.slice(3));   // eye0 / eye1
    draft.features.eyes = draft.features.eyes || [];
    draft.features.eyes[idx] = rect;
    // 不要在这里 filter(Boolean)：压实会让 eye1 掉到下标 0，
    // 紧接着框 eye0 就把它覆盖掉——检测不出五官时先框②再框①，第一只会无声消失。
    // 「只框一只」由 pipeline 的 rectsToBlobs 在消费端 filter 保证。
  }
  el.previewHint.textContent = `${PART_LABEL[changedPart]} 已更新，点「按新框重新处理」生效`;
  draft.pendingFeatureEdits = true;
  classifyDraftReadiness();
  armedPart = null;
  document.querySelectorAll('.btn-chip').forEach(b => b.classList.remove('armed'));
  loadRectEditor(changedPart);
  // 待生效的框用虚线画出来，跟已生效的实线框区分开
  drawPreview(1, 1);
  drawPendingBoxes();
});

function drawPendingBoxes() {
  if (!draft.features) return;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  (draft.features.eyes || []).forEach((r, i) => {
    if (!r) return;
    ctx.strokeStyle = PART_COLORS['eye' + i] || '#fff';
    ctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
  });
  if (draft.features.mouth) {
    const r = draft.features.mouth;
    ctx.strokeStyle = PART_COLORS.mouth;
    ctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
  }
  ctx.setLineDash([]);
}

// 回灌用没加过 pad 的原始范围，否则每重处理一次部件就外扩一圈
// 回灌的是 src（未加 pad 的原始范围），并把来源一起带走。
// 来源不带走的话，用户手画的框和自动检出的框在重新处理时就分不出来了，
// character.json 里记的 source 会变成一个永远等于 'user' 的假字段。
function rectOf(p) {
  if (!p) return null;
  return { ...(p.src || { x: p.x, y: p.y, w: p.w, h: p.h }), source: p.source };
}

// 比例必须从元素的实际渲染尺寸按轴反算，不能用 layoutPreview 写下的"意图缩放"。
// canvas 的 width/height 是显式指定的，CSS 的 max-width/max-height 会各自独立压缩两轴、
// 并不保持长宽比，两边一旦脱钩，拖出来的框就落在完全不相干的位置。
function toSpriteCoords(e) {
  const rect = el.preview.getBoundingClientRect();
  const zx = rect.width / el.preview.width;
  const zy = rect.height / el.preview.height;
  return {
    x: Math.max(0, Math.min(el.preview.width - 1, Math.floor((e.clientX - rect.left) / zx))),
    y: Math.max(0, Math.min(el.preview.height - 1, Math.floor((e.clientY - rect.top) / zy))),
  };
}

$('btn-reprocess').addEventListener('click', async () => {
  await reprocessFeatures();
});

$('btn-redetect').addEventListener('click', async () => {
  if (!draft || draft.persistedId) return;
  draft.features = null;
  draft.reviewAccepted = false;
  draft._stamp = (draft._stamp || 0) + 1;
  _atlasCanvas = null;
  await process().catch(() => null);
  loadRectEditor(el.rectPart.value);
  setRectStatus('已恢复自动检测结果。');
});

el.acceptReview.addEventListener('click', () => {
  if (!draft?.result || draft.persistedId || draft.pendingFeatureEdits) {
    classifyDraftReadiness();
    return;
  }
  draft.reviewAccepted = true;
  leaveTargetedRecovery();
  el.advanced.open = false;
  document.body.classList.remove('advanced-open');
  showBoxes = false;
  drawPreview(1, 1);
  classifyDraftReadiness();
});

$('btn-toggle-boxes').addEventListener('click', () => { showBoxes = !showBoxes; drawPreview(1, 1); });

// —— 动画预览 ——

$('btn-play-blink').addEventListener('click', () => playAnim('blink'));
$('btn-play-talk').addEventListener('click', () => playAnim('talk'));

// 恢复 showBoxes 的责任放在这里，不能只写在定时器回调里：
// 播放途中关掉编辑器会直接 clearInterval，那句恢复永远执行不到，
// showBoxes 是模块级变量，从此所有草稿都不再画五官框。
function stopAnim() {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  if (framePlayTimer) { clearInterval(framePlayTimer); framePlayTimer = null; }
  if (pendingShowBoxes !== null) { showBoxes = pendingShowBoxes; pendingShowBoxes = null; }
}

// 多帧素材在预览里就循环播起来，所见即所得
function startFramePlayback() {
  if (framePlayTimer) { clearInterval(framePlayTimer); framePlayTimer = null; }
  const f = draft?.result?.meta?.frames;
  if (!f || f.count < 2) return;
  previewFrame = 0;
  framePlayTimer = setInterval(() => {
    previewFrame = (previewFrame + 1) % f.count;
    drawPreview(1, 1);
  }, 1000 / Math.max(1, f.fps || 10));
}

function playAnim(kind) {
  const meta = draft?.result?.meta;
  if (!meta) return;
  stopAnim();
  if (kind === 'blink') {
    if (meta.frames) {
      el.previewHint.textContent = '多帧素材使用原始帧动画，不会叠加自动眨眼';
      return;
    }
    if (!eyesOf(meta.parts).length) {
      el.previewHint.textContent = '当前没有眼部框：已安全关闭眨眼，不会误动耳朵或墨镜';
      return;
    }
    el.previewHint.textContent = '正在检查：如果耳朵、镜片或镜框在动，请重框真实眼睛或删除错误眼框';
  }

  pendingShowBoxes = showBoxes;
  showBoxes = false;
  let t = 0;
  const dur = kind === 'blink' ? 0.8 : 1.6;
  animTimer = setInterval(() => {
    t += 1 / 24;
    if (t >= dur) {
      stopAnim();            // 里面会把 showBoxes 恢复回去
      drawPreview(1, 1);
      if (kind === 'blink') {
        el.previewHint.textContent = '眨眼检查完成；确认只有真实眼睛在动后再保存';
      }
      return;
    }
    if (kind === 'blink') {
      const phase = t / dur;
      // 快速闭合、短暂停留、平滑睁开，最低保留一点眼睑而不是瞬间消失。
      const blink = phase < 0.35
        ? 1 - 0.88 * smoothStep(phase / 0.35)
        : phase < 0.55
          ? 0.12
          : 0.12 + 0.88 * smoothStep((phase - 0.55) / 0.45);
      drawPreview(blink, 1);
    } else {
      drawPreview(1, 1 + 0.55 * Math.abs(Math.sin(t * 9)));
    }
  }, 1000 / 24);
}

function smoothStep(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

// ============================================================
// 工具
// ============================================================

function busy(text) { el.busyText.textContent = text; el.busy.classList.remove('hidden'); }
function idle() { el.busy.classList.add('hidden'); }

async function fileToDataURL(file) {
  if (!file || !Number.isFinite(file.size) || file.size < 1 || file.size > DEFAULTS.maxFileBytes) {
    throw new Error(`图片文件过大或为空（最大 ${Math.round(DEFAULTS.maxFileBytes / 1024 / 1024)}MB）`);
  }
  // 先只读有限的图片头拿尺寸；通过后才允许 FileReader 把整份文件复制成 base64。
  const header = new Uint8Array(await withTimeout(
    file.slice(0, 128 * 1024).arrayBuffer(), 5000, '读取图片头超时'));
  const info = probeImageHeader(header);
  assertImageDimensions(info.width, info.height, 1);

  const dataURL = await new Promise((resolve, reject) => {
    const r = new FileReader();
    const timer = setTimeout(() => { r.abort(); reject(new Error('读取图片超时')); }, 10_000);
    r.onload = () => { clearTimeout(timer); resolve(r.result); };
    r.onerror = () => { clearTimeout(timer); reject(new Error('读取文件失败')); };
    r.onabort = () => clearTimeout(timer);
    r.readAsDataURL(file);
  });
  assertDataURLBudget(dataURL);
  return { dataURL, width: info.width, height: info.height, size: file.size, mime: info.mime };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('图片解码超时'));
    }, 10_000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('这不是一张能解码的图片')); };
    img.src = src;
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(resourceError(message, 'POPPET_PROCESS_TIMEOUT')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function resourceError(message, code = 'POPPET_RESOURCE_LIMIT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertDataURLBudget(dataURL) {
  if (typeof dataURL !== 'string') throw resourceError('图片数据无效');
  const comma = dataURL.indexOf(',');
  const header = comma >= 0 ? dataURL.slice(0, comma) : '';
  if (!/^data:image\/(?:png|gif|webp|jpeg|bmp);base64$/i.test(header)) {
    throw resourceError('不支持的图片数据格式');
  }
  const encodedLength = dataURL.length - comma - 1;
  const estimatedBytes = Math.floor(encodedLength * 3 / 4);
  if (estimatedBytes < 1 || estimatedBytes > DEFAULTS.maxFileBytes) {
    throw resourceError(`图片文件超过 ${Math.round(DEFAULTS.maxFileBytes / 1024 / 1024)}MB 限制`);
  }
}

function assertImageDimensions(width, height, frameCount = 1) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw resourceError('图片尺寸无效');
  }
  if (width > DEFAULTS.maxSourceDimension || height > DEFAULTS.maxSourceDimension) {
    throw resourceError(`图片边长超过 ${DEFAULTS.maxSourceDimension}px 限制`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > DEFAULTS.maxSourcePixels) {
    throw resourceError(`单帧像素超过 ${DEFAULTS.maxSourcePixels} 限制`);
  }
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > DEFAULTS.maxFrames) {
    throw resourceError(`帧数超过 ${DEFAULTS.maxFrames} 限制`);
  }
  if (pixels * frameCount > DEFAULTS.maxTotalSourcePixels) {
    throw resourceError(`所有帧总像素超过 ${DEFAULTS.maxTotalSourcePixels} 限制`);
  }
}

function probeImageHeader(bytes) {
  const ascii = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
  const u16be = (at) => bytes[at] * 256 + bytes[at + 1];
  const u16le = (at) => bytes[at] + bytes[at + 1] * 256;
  const u24le = (at) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
  const u32be = (at) => bytes[at] * 0x1000000 + bytes[at + 1] * 0x10000 + bytes[at + 2] * 256 + bytes[at + 3];
  const i32le = (at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(at, true);

  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    return { width: u32be(16), height: u32be(20), mime: 'image/png' };
  }
  if (bytes.length >= 10 && ascii(0, 3) === 'GIF') {
    return { width: u16le(6), height: u16le(8), mime: 'image/gif' };
  }
  if (bytes.length >= 26 && ascii(0, 2) === 'BM') {
    return { width: Math.abs(i32le(18)), height: Math.abs(i32le(22)), mime: 'image/bmp' };
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1, mime: 'image/webp' };
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff, mime: 'image/webp' };
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
      return { width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)), mime: 'image/webp' };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      const length = u16be(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (sof.has(marker) && length >= 7) {
        return { width: u16be(offset + 5), height: u16be(offset + 3), mime: 'image/jpeg' };
      }
      offset += length;
    }
  }
  throw resourceError('不支持、损坏或图片头过大的文件');
}

// GIF 可能是多帧动画。用 ImageDecoder 逐帧解出来——它是 Chromium 原生的，
// 比自己写 GIF 解码器靠谱得多（LZW、局部调色板、帧间处置方式都由它处理）。
// base64 直接转成 ArrayBuffer，不走 fetch：页面的 CSP 是 default-src 'none'，
// 连 data: 的请求都会被拦下来。
async function decodeFrames(dataURL, maxFrames = 64) {
  const comma = dataURL.indexOf(',');
  const meta = dataURL.slice(0, comma);
  const mime = ((meta.match(/^data:([^;]+)/) || [])[1] || '').toLowerCase();
  if (mime !== 'image/gif') return null;
  // Without a real GIF decoder we cannot prove that falling back to <img>
  // preserves every frame. Reject the import instead of silently keeping only
  // the browser-selected poster frame of an animation.
  if (typeof window.ImageDecoder !== 'function') {
    throw resourceError('当前运行环境无法安全解码 GIF 动画', 'POPPET_GIF_DECODE_UNAVAILABLE');
  }

  assertDataURLBudget(dataURL);
  const bin = atob(dataURL.slice(comma + 1));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

  // 只有解码器明确确认恰好一帧时才允许走静态图片路径。任何轨道或帧解码
  // 异常都必须让导入失败，否则动画会在没有提示的情况下退化成单帧。
  let decoder = null;
  try {
    decoder = new window.ImageDecoder({ data: buf, type: mime });
    await withTimeout(decoder.tracks.ready, 10_000, 'GIF 轨道读取超时');
    await withTimeout(decoder.completed, 10_000, 'GIF 解码超时');
    const track = decoder.tracks.selectedTrack;
    const count = track?.frameCount;
    if (!Number.isSafeInteger(count) || count < 1) {
      throw resourceError('GIF 帧信息无效', 'POPPET_GIF_DECODE_FAILED');
    }
    if (count > maxFrames || count > DEFAULTS.maxFrames) {
      throw resourceError(`GIF 帧数超过 ${Math.min(maxFrames, DEFAULTS.maxFrames)} 限制`);
    }
    if (count === 1) return null;

    const frames = [];
    const c = document.createElement('canvas');
    const cx = c.getContext('2d', { willReadFrequently: true });
    const deadline = performance.now() + DEFAULTS.processingTimeoutMs;
    let totalPixels = 0;
    for (let i = 0; i < count; i++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw resourceError('GIF 处理超时', 'POPPET_PROCESS_TIMEOUT');
      const decoded = await withTimeout(decoder.decode({ frameIndex: i }), remaining, 'GIF 帧解码超时');
      if (!decoded?.image || decoded.complete === false) {
        throw resourceError(`GIF 第 ${i + 1} 帧解码不完整`, 'POPPET_GIF_DECODE_FAILED');
      }
      const { image } = decoded;
      try {
        assertImageDimensions(image.displayWidth, image.displayHeight, 1);
        totalPixels += image.displayWidth * image.displayHeight;
        if (totalPixels > DEFAULTS.maxTotalSourcePixels) {
          throw resourceError(`GIF 所有帧总像素超过 ${DEFAULTS.maxTotalSourcePixels} 限制`);
        }
        if (i === 0) {
          c.width = image.displayWidth; c.height = image.displayHeight; cx.imageSmoothingEnabled = false;
        } else if (image.displayWidth !== c.width || image.displayHeight !== c.height) {
          throw resourceError('GIF 每帧尺寸不一致');
        }
        cx.clearRect(0, 0, c.width, c.height);
        cx.drawImage(image, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height);
        frames.push({ width: d.width, height: d.height, data: d.data });
      } finally {
        image.close?.();
      }
    }
    return frames;
  } catch (error) {
    if (error?.code?.startsWith('POPPET_')) throw error;
    const detail = typeof error?.message === 'string' && error.message ? `：${error.message}` : '';
    throw resourceError(`GIF 动画解码失败${detail}`, 'POPPET_GIF_DECODE_FAILED');
  } finally {
    decoder?.close?.();
  }
}

// 把一张 sprite sheet 按行列切成帧
function sliceGrid(img, cols, rows) {
  const fw = Math.floor(img.width / cols);
  const fh = Math.floor(img.height / rows);
  if (fw < 4 || fh < 4) throw new Error('切出来的帧太小了，检查一下行列数');
  assertImageDimensions(fw, fh, cols * rows);
  const frames = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const out = new Uint8ClampedArray(fw * fh * 4);
      for (let y = 0; y < fh; y++) {
        const src = ((r * fh + y) * img.width + c * fw) * 4;
        out.set(img.data.subarray(src, src + fw * 4), y * fw * 4);
      }
      frames.push({ width: fw, height: fh, data: out });
    }
  }
  return frames;
}

// 全透明的帧（sheet 没排满时常见）直接丢掉
function dropEmptyFrames(frames) {
  return frames.filter(f => {
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i] > 8) return true;
    return false;
  });
}

async function dataURLToImageData(dataURL) {
  assertDataURLBudget(dataURL);
  const img = await loadImage(dataURL);
  // <img> 完成解码后、创建 full-size canvas 与 RGBA 缓冲前再次检查真实尺寸。
  assertImageDimensions(img.naturalWidth, img.naturalHeight, 1);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = false;
  cx.drawImage(img, 0, 0);
  const id = cx.getImageData(0, 0, c.width, c.height);
  return { width: id.width, height: id.height, data: id.data };
}

function putImage(context, img, x, y) {
  const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  context.clearRect(x, y, img.width, img.height);
  context.putImageData(id, x, y);
}

function imageToArrayBuffer(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext('2d');
  cx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return new Promise((resolve, reject) => {
    c.toBlob(b => b ? b.arrayBuffer().then(resolve) : reject(new Error('导出 PNG 失败')), 'image/png');
  });
}

function imageToDataURL(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext('2d');
  cx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toDataURL('image/png');
}

function canonicalTimingEvidence() {
  const raw = draft?.timings || {};
  const keys = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
  const uncertainty = Number.isFinite(raw.clock?.uncertaintyMs) ? raw.clock.uncertaintyMs : null;
  const base = Number.isFinite(raw.T0) ? raw.T0 : null;
  const markersMs = Object.fromEntries(keys.map(key => [
    key,
    uncertainty !== null && base !== null && Number.isFinite(raw[key]) ? raw[key] - base : null,
  ]));
  const duration = (end, start) => {
    if (!Number.isFinite(markersMs[end]) || !Number.isFinite(markersMs[start])) return null;
    const value = markersMs[end] - markersMs[start];
    return value >= 0 ? value : null;
  };
  const preview = duration('T2', 'T0');
  const create = duration('T5', 'T3');
  return {
    clock: {
      mode: uncertainty === null ? 'unavailable' : 'calibrated-cross-process',
      calibrationUncertaintyMs: uncertainty,
    },
    markersMs,
    pipelineMs: null,
    timeToSourcePreviewMs: duration('T1', 'T0'),
    timeToProcessedPreviewMs: preview,
    createToPetReadyMs: create,
    systemTimeToPetMs: preview !== null && create !== null ? preview + create : null,
    humanEndToEndTimeMs: null,
  };
}

window.addEventListener('resize', () => { if (draft?.result) { layoutPreview(); drawPreview(1, 1); } });

// 自动化接口只存在于未打包的 --dev。helper 在 production package 中被硬性排除；
// 正常页面没有受控 query，因此不会创建任何测试全局 API。
if (POPPET_DEV) {
  import('../dev/manager-hooks.js').then(({ installManagerHooks }) => installManagerHooks({
    startDraft, process, save, openProps, sliceGrid, dropEmptyFrames,
    getDraft: () => draft,
    flowState: () => draft ? {
      state: draft.flowState,
      persistedId: draft.persistedId || null,
      recoveryMode: draft.recoveryMode || null,
      persistencePending: !!draft.persistencePending,
      measurementEnabled: FLOW_MEASUREMENT_ENABLED,
      timingIssues: { ...(draft.timingIssues || {}) },
      selection: { ...draft.pixelize },
      timings: canonicalTimingEvidence(),
    } : null,
    spriteDataURL: () => draft?.result ? imageToDataURL(draft.result.sprite) : null,
    atlasDataURL: () => draft?.result?.atlas ? imageToDataURL(draft.result.atlas) : null,
    resultMeta: () => draft?.result ? structuredClone({ ...draft.result.meta, rig: readRig() }) : null,
    roles: (meta) => normalizeParts(meta && meta.parts).map(p => p.role),
  })).catch((error) => console.error('开发钩子加载失败:', error));
}

// ============================================================
// 关节骨架编辑器
// ============================================================
//
// 只在编辑**已保存的骨架角色**时出现。它不创建骨架：一个 v2 角色没有骨骼图集，
// 补上去的每一根骨头都会指向不存在的矩形，主进程也会当场拒绝。
// 想要骨架角色就导入角色包，这里负责的是把枢轴、接点、层序和驱动器增益调对——
// 那几个数字光看 JSON 是调不出来的，必须看着它动。
//
// 写盘复用已有的 lib:update-meta：那条路径已经做过原子写、备份和完整校验
// （合并后的 metadata 会过 assertSkeleton，图集越界在那里拦）。
// 为一个编辑器新开一条特权 IPC 通道是白白多一个信任边界。

const skelEl = {
  block: $('skeleton-block'),
  hint: $('skeleton-hint'),
  canvas: $('skel-canvas'),
  pose: $('skel-pose'),
  phase: $('skel-phase'),
  bone: $('skel-bone'),
  pickPivot: $('skel-pick-pivot'),
  parent: $('skel-parent'),
  z: $('skel-z'),
  pivotX: $('skel-pivot-x'),
  pivotY: $('skel-pivot-y'),
  anchorX: $('skel-anchor-x'),
  anchorY: $('skel-anchor-y'),
  limitLo: $('skel-limit-lo'),
  limitHi: $('skel-limit-hi'),
  drivers: $('skel-drivers'),
  save: $('btn-skeleton-save'),
  revert: $('btn-skeleton-revert'),
};

const DRIVER_LABELS = {
  walkSwing: '走路摆动', breathe: '呼吸', dangle: '悬空垂挂',
  impact: '落地冲击', wave: '招手',
};

let skel = null;          // 工作副本，保存前不落盘
let skelSaved = null;     // 打开时的原样，用于放弃改动
let skelPick = null;      // 当前选中的骨骼 id
let skelAtlas = null;     // { canvas, data, width, height }
let skelScale = 1;
let skelOffset = { x: 0, y: 0 };
const skelDriverInputs = new Map();

function skelSprite() { return draft?.result?.meta?.sprite || { width: 1, height: 1 }; }

function hideSkeletonPanel() {
  skel = null;
  skelSaved = null;
  skelAtlas = null;
  skelPick = null;
  skelEl.block.hidden = true;
}

function showSkeleton(meta, atlas) {
  skel = meta && meta.skeleton ? structuredClone(meta.skeleton) : null;
  skelSaved = skel ? structuredClone(skel) : null;
  skelEl.block.hidden = !skel;
  if (!skel || !atlas) { skel = null; skelAtlas = null; skelEl.block.hidden = true; return; }

  // 图集画到一张离屏 canvas 上用于绘制，同时留着 ImageData 做点击命中判定
  // （命中要看那一点是不是不透明，否则点在部件的透明角上会选错骨头）。
  const c = document.createElement('canvas');
  c.width = atlas.width; c.height = atlas.height;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  cx.putImageData(new ImageData(new Uint8ClampedArray(atlas.data), atlas.width, atlas.height), 0, 0);
  skelAtlas = { canvas: c, data: atlas.data, width: atlas.width, height: atlas.height };

  // 骨架面板住在「Advanced」折叠区里，但对骨架角色来说它是**唯一**要用的东西。
  // 收着等于没有：作者打开角色只看到一句"可以保存"，找不到能调的地方。
  el.advanced.open = true;
  document.body.classList.add('advanced-open');

  buildDriverInputs();
  skelPick = skel.bones[0]?.id || null;
  fillBoneSelects();
  fillBoneFields();
  drawSkeleton();
}

function buildDriverInputs() {
  if (skelDriverInputs.size) return;
  skelEl.drivers.innerHTML = '';
  for (const name of DRIVER_NAMES) {
    const label = document.createElement('label');
    label.className = 'row grid-in';
    const span = document.createElement('span');
    span.textContent = DRIVER_LABELS[name] || name;
    span.title = `增益 1 对应 ${DRIVERS[name]} 度`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '-2';
    input.max = '2';
    input.placeholder = '不跟';
    input.addEventListener('input', () => commitBoneFields());
    label.append(span, input);
    skelEl.drivers.appendChild(label);
    skelDriverInputs.set(name, input);
  }
}

function currentBone() {
  return skel ? skel.bones.find(b => b.id === skelPick) || null : null;
}

function fillBoneSelects() {
  const fill = (select, entries, selected) => {
    select.innerHTML = '';
    for (const [value, text] of entries) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === selected) option.selected = true;
      select.appendChild(option);
    }
  };
  fill(skelEl.bone, skel.bones.map(b => [b.id, b.id]), skelPick);
  const bone = currentBone();
  // 父骨骼候选里排除自己和自己的后代，否则一次下拉就能造出一个环，
  // 而环在渲染器里是无限循环。在这里挡掉比保存时报错更早也更好懂。
  const banned = new Set();
  if (bone) {
    const collect = (id) => {
      banned.add(id);
      for (const b of skel.bones) if (b.parent === id) collect(b.id);
    };
    collect(bone.id);
  }
  const options = [['', '（根骨骼）']];
  for (const b of skel.bones) if (!banned.has(b.id)) options.push([b.id, b.id]);
  fill(skelEl.parent, options, bone?.parent ?? '');
}

function fillBoneFields() {
  const bone = currentBone();
  const on = !!bone;
  for (const input of [skelEl.z, skelEl.pivotX, skelEl.pivotY, skelEl.anchorX,
    skelEl.anchorY, skelEl.limitLo, skelEl.limitHi, skelEl.parent]) input.disabled = !on;
  for (const input of skelDriverInputs.values()) input.disabled = !on;
  if (!bone) return;
  skelEl.z.value = String(bone.z);
  skelEl.pivotX.value = String(bone.pivot.x);
  skelEl.pivotY.value = String(bone.pivot.y);
  skelEl.anchorX.value = String(bone.anchor.x);
  skelEl.anchorY.value = String(bone.anchor.y);
  skelEl.limitLo.value = bone.limit ? String(bone.limit[0]) : '';
  skelEl.limitHi.value = bone.limit ? String(bone.limit[1]) : '';
  for (const [name, input] of skelDriverInputs) {
    const gain = bone.drivers?.[name];
    input.value = gain === undefined ? '' : String(gain);
  }
  const root = skel.bones.find(b => b.parent === null);
  skelEl.hint.textContent = `${skel.bones.length} 根骨骼，根是 ${root ? root.id : '（缺失）'}，`
    + `角度量化到 ${skel.angleStep} 度一档。`
    + '接点是「本骨枢轴落在父骨枢轴的哪个偏移上」，用父骨的坐标写。';
}

function skelNum(input, fallback) {
  const raw = input.value.trim();
  if (raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function commitBoneFields() {
  const bone = currentBone();
  if (!bone) return;
  bone.z = Math.round(skelNum(skelEl.z, bone.z));
  bone.pivot.x = Math.round(skelNum(skelEl.pivotX, bone.pivot.x));
  bone.pivot.y = Math.round(skelNum(skelEl.pivotY, bone.pivot.y));
  bone.anchor.x = Math.round(skelNum(skelEl.anchorX, bone.anchor.x));
  bone.anchor.y = Math.round(skelNum(skelEl.anchorY, bone.anchor.y));
  const lo = skelEl.limitLo.value.trim();
  const hi = skelEl.limitHi.value.trim();
  bone.limit = lo === '' || hi === '' ? null : [Number(lo), Number(hi)];
  const drivers = {};
  for (const [name, input] of skelDriverInputs) {
    const raw = input.value.trim();
    if (raw === '') continue;
    const gain = Number(raw);
    // 0 等同于"不跟"：留一个 0 在表里，运行时也会把它丢掉，
    // 那会让保存后重新打开时这个输入框莫名其妙变空。
    if (!Number.isFinite(gain) || gain === 0) continue;
    drivers[name] = Math.max(-2, Math.min(2, gain));
  }
  bone.drivers = drivers;
  drawSkeleton();
}

// 试姿势：把一个信号推到选定幅度，其余归零。这是编辑器里唯一能回答
// 「这根骨头的增益写对了没有」的东西——数字本身看不出来。
function skelSignals() {
  const zero = { walkSwing: 0, breathe: 0, dangle: 0, impact: 0, wave: 0 };
  const pose = skelEl.pose.value;
  if (pose === 'idle') return zero;
  const amount = Number(skelEl.phase.value) / 100;
  return { ...zero, [pose]: pose === 'impact' ? Math.abs(amount) : amount };
}

function drawSkeleton() {
  if (!skel || !skelAtlas) return;
  const cx = skelEl.canvas.getContext('2d');
  cx.imageSmoothingEnabled = false;
  cx.clearRect(0, 0, skelEl.canvas.width, skelEl.canvas.height);
  const valid = normalizeSkeleton(skel);
  if (!valid) {
    skelEl.hint.textContent = '骨架当前不合法：检查是否恰好一根根骨骼、父引用是否存在、层级是否超过 8 层。';
    return;
  }
  const sprite = skelSprite();
  skelScale = Math.max(1, Math.floor(Math.min(
    skelEl.canvas.width / sprite.width, skelEl.canvas.height / sprite.height)));
  skelOffset = {
    x: Math.round((skelEl.canvas.width - sprite.width * skelScale) / 2),
    y: Math.round((skelEl.canvas.height - sprite.height * skelScale) / 2),
  };
  const nodes = boneTransforms(valid, resolvePose(valid, skelSignals()));
  for (const bone of drawOrder(valid)) {
    const node = nodes.get(bone.id);
    if (!node) continue;
    const f = frameFor(bone, 1, 1);
    cx.save();
    cx.translate(skelOffset.x + Math.round(node.x) * skelScale,
      skelOffset.y + Math.round(node.y) * skelScale);
    if (node.angle) cx.rotate(node.angle * Math.PI / 180);
    cx.drawImage(skelAtlas.canvas, f.sx, f.sy, f.sw, f.sh,
      -bone.pivot.x * skelScale, -bone.pivot.y * skelScale,
      f.sw * skelScale, f.sh * skelScale);
    // 选中的骨头描一圈并把枢轴点出来——枢轴是这个编辑器里最难凭数字想象的量。
    if (bone.id === skelPick) {
      cx.strokeStyle = '#ff4e51';
      cx.lineWidth = 1;
      cx.strokeRect(-bone.pivot.x * skelScale - 0.5, -bone.pivot.y * skelScale - 0.5,
        f.sw * skelScale + 1, f.sh * skelScale + 1);
      cx.fillStyle = '#ff4e51';
      cx.fillRect(-2, -2, 4, 4);
    }
    cx.restore();
  }
}

// 画布坐标 -> 精灵坐标
function skelPointAt(event) {
  const rect = skelEl.canvas.getBoundingClientRect();
  const cx = (event.clientX - rect.left) * (skelEl.canvas.width / rect.width);
  const cy = (event.clientY - rect.top) * (skelEl.canvas.height / rect.height);
  return { x: (cx - skelOffset.x) / skelScale, y: (cy - skelOffset.y) / skelScale };
}

// 命中判定要看那一点的 alpha：部件贴的是矩形，只按矩形判会让点在透明角上选错骨头。
function skelBoneAt(point) {
  const valid = normalizeSkeleton(skel);
  if (!valid || !skelAtlas) return null;
  const nodes = boneTransforms(valid, resolvePose(valid, skelSignals()));
  for (const bone of drawOrder(valid).slice().reverse()) {   // 从最上层往下找
    const node = nodes.get(bone.id);
    if (!node) continue;
    const rad = -node.angle * Math.PI / 180;
    const dx = point.x - node.x, dy = point.y - node.y;
    const lx = Math.floor(dx * Math.cos(rad) - dy * Math.sin(rad) + bone.pivot.x);
    const ly = Math.floor(dx * Math.sin(rad) + dy * Math.cos(rad) + bone.pivot.y);
    const f = frameFor(bone, 1, 1);
    if (lx < 0 || ly < 0 || lx >= f.sw || ly >= f.sh) continue;
    if (skelAtlas.data[((f.sy + ly) * skelAtlas.width + f.sx + lx) * 4 + 3] > 8) return bone.id;
  }
  return null;
}

skelEl.canvas.addEventListener('click', (event) => {
  if (!skel) return;
  const point = skelPointAt(event);
  if (!skelEl.pickPivot.checked) {
    const hit = skelBoneAt(point);
    if (hit) { skelPick = hit; fillBoneSelects(); fillBoneFields(); drawSkeleton(); }
    return;
  }
  const bone = currentBone();
  const valid = normalizeSkeleton(skel);
  if (!bone || !valid) return;
  // 枢轴和接点平移相同的量，部件在画面上纹丝不动，改变的只是旋转中心。
  // 只改枢轴会让整块部件跳走，那从来不是作者想要的操作。
  const node = boneTransforms(valid, resolvePose(valid, skelSignals())).get(bone.id);
  if (!node) return;
  const rad = -node.angle * Math.PI / 180;
  const dx = point.x - node.x, dy = point.y - node.y;
  const lx = Math.round(dx * Math.cos(rad) - dy * Math.sin(rad));
  const ly = Math.round(dx * Math.sin(rad) + dy * Math.cos(rad));
  bone.pivot.x += lx; bone.pivot.y += ly;
  bone.anchor.x += lx; bone.anchor.y += ly;
  fillBoneFields();
  drawSkeleton();
});

skelEl.bone.addEventListener('change', () => {
  skelPick = skelEl.bone.value;
  fillBoneSelects(); fillBoneFields(); drawSkeleton();
});
skelEl.parent.addEventListener('change', () => {
  const bone = currentBone();
  if (!bone) return;
  bone.parent = skelEl.parent.value === '' ? null : skelEl.parent.value;
  fillBoneSelects(); drawSkeleton();
});
for (const input of [skelEl.z, skelEl.pivotX, skelEl.pivotY, skelEl.anchorX,
  skelEl.anchorY, skelEl.limitLo, skelEl.limitHi]) {
  input.addEventListener('input', () => commitBoneFields());
}
skelEl.pose.addEventListener('change', () => drawSkeleton());
skelEl.phase.addEventListener('input', () => drawSkeleton());
skelEl.revert.addEventListener('click', () => {
  if (!skelSaved) return;
  skel = structuredClone(skelSaved);
  skelPick = skel.bones[0]?.id || null;
  fillBoneSelects(); fillBoneFields(); drawSkeleton();
});

skelEl.save.addEventListener('click', async () => {
  if (!skel || !draft?.id) return;
  // 先用运行时那份归一器自检：它拒绝的东西主进程一定也会拒，
  // 让作者在点保存那一刻就知道，而不是收到一句主进程抛出来的异常。
  if (!normalizeSkeleton(skel)) {
    setReadiness('blocked', '骨架不合法：需要恰好一根根骨骼，父引用必须存在，不能成环，层级不超过 8 层。');
    return;
  }
  busy('保存骨架…');
  try {
    await window.poppet.updateMeta(draft.id, { skeleton: skel });
    skelSaved = structuredClone(skel);
    setReadiness('ready', '骨架已保存。桌宠下次加载这个角色时使用新的骨架。');
  } catch (error) {
    setReadiness('blocked', `骨架保存失败：${error?.message || error}`);
  } finally {
    idle();
  }
});


refresh();

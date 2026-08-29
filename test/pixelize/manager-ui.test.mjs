import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PIXELIZE_PRESETS } from '../../src/shared/pixelize.js';

const html = fs.readFileSync(new URL('../../src/renderer/manager/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../src/renderer/manager/manager.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../src/renderer/manager/manager.css', import.meta.url), 'utf8');
const mainScript = fs.readFileSync(new URL('../../src/main/index.js', import.meta.url), 'utf8');

test('manager exposes only real local pixelizer presets and passes the choice into the preview pipeline', () => {
  const block = html.match(/<div class="panel-block" id="pixelize-block">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(block, /id="pixelize-preset"/);
  assert.match(block, /id="pixelize-palette"/);
  assert.match(block, /\u4e0d\u662f AI \u91cd\u7ed8/);

  const values = [...block.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  for (const preset of values.filter(value => value !== 'auto' && !/^\d+$/.test(value))) {
    assert.ok(Object.hasOwn(PIXELIZE_PRESETS, preset), `unknown manager preset: ${preset}`);
  }
  assert.equal(values[0], 'original', 'legacy-compatible original mode must remain the default');
  assert.match(script, /pixelize:\s*targetDraft\.pixelize/);
  assert.match(html, /id="source-preview"/);
  assert.match(html, /id="result-preview-label"/);
  assert.match(script, /function renderSourcePreview\(\)/);
  assert.match(script, /maxSide\s*=\s*192/,
    'the before preview must stay bounded instead of duplicating a full-resolution canvas');
  assert.match(script, /处理后 · \$\{label\}/);
  assert.match(script, /process\(\{ remapFeatures: true \}\)/);
  assert.match(script, /选择仍保留.*上一个预览未丢失/,
    'failed preview must retain both the selected recovery path and prior usable result');
  assert.match(css, /body\.props-only #pixelize-block/,
    'saved-character property mode must not expose controls that cannot reprocess source pixels');
});

test('manager default path is progressive, readiness-gated and recoverable', () => {
  const choices = [...html.matchAll(/class="style-choice"[^>]*data-preset="([^"]+)"/g)]
    .map(match => match[1]);
  assert.deepEqual(choices, ['original', 'classic', 'chunky']);
  assert.match(html, /<details id="advanced-controls" class="advanced-controls">/,
    'Advanced must be collapsed by default (no open attribute)');
  for (const id of [
    'pixelize-block', 'expression-block', 'frames-block', 'rig-block',
    'preview-controls-block', 'diagnostics-block',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Advanced must retain ${id}`);
  }
  for (const label of ['处理中', '可以创建了', '需要确认', '暂不支持的图片', '失败（草稿已保留，可重试）']) {
    assert.match(script, new RegExp(label.replace(' ', '\\s')));
  }
  assert.match(html, /id="btn-save"[^>]*disabled/);
  assert.match(script, /const canCreate = !!draft\?\.result && state === 'ready' && !saveInFlight/);
  assert.match(script, /if \(draft\.flowState !== 'ready'\)/,
    'the click path must fail closed even if a caller bypasses the disabled button');
  assert.match(script, /draft\.persistedId && draft\.createFailure/);
  assert.match(script, /retryPersistedPet/,
    'post-persistence activation retry must not re-enter import');
  assert.match(script, /recoveryMode: draft\.recoveryMode \|\| null/,
    'dev flow evidence must expose the non-sensitive persistence recovery mode');
  assert.match(script, /persistencePending: !!draft\.persistencePending/,
    'dev flow evidence must expose whether durable finalization is still pending');
  assert.match(script, /return waitForVisiblePaint\(\)/,
    'an occluded Manager must not leave import or recovery promises pending forever');
  assert.match(script, /recordPaintTiming\(draft, 'T1', sourcePainted\)/);
  assert.match(script, /recordPaintTiming\(targetDraft, 'T2', previewPainted\)/);
  assert.match(script, /!Object\.hasOwn\(targetDraft\.timings, 'T2'\)/,
    'an unavailable first-visible T2 must stay null across later reprocessing');
});

test('targeted expression recovery stays scoped and has a keyboard-accessible full Advanced escape', () => {
  assert.match(html, /id="btn-show-all-advanced"[^>]*aria-controls="advanced-body"/);
  assert.match(script, /document\.body\.classList\.add\('targeted-recovery'\)/);
  assert.match(script, /el\.showAllAdvanced\.focus\(\)/,
    'automatic recovery must put keyboard focus on the scoped recovery controls');
  assert.match(css,
    /body\.targeted-recovery \.advanced-body > \.panel-block:not\(\.recovery-target\) \{ display: none; \}/,
    'automatic recovery must not reveal unrelated Advanced blocks');
  assert.match(script, /function leaveTargetedRecovery\(\)/);
});

test('manual expression rectangles support labeled integer keyboard input with bounds and budget gates', () => {
  for (const id of ['rect-part', 'rect-x', 'rect-y', 'rect-w', 'rect-h']) {
    assert.match(html, new RegExp(`(?:for|id)="${id}"`));
  }
  assert.match(html, /id="rect-x"[^>]*type="number"[^>]*step="1"/);
  assert.match(html, /id="rect-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(script, /Number\.isSafeInteger\(value\)/);
  assert.match(script, /x \+ w > size\.width \|\| y \+ h > size\.height/);
  assert.match(script, /w \* h > DEFAULTS\.maxWorkingPixels/);
  assert.match(script, /async function applyRectEditor\(\)[\s\S]*?await reprocessFeatures\(\)/,
    'coordinate application must use the existing feature reprocess path');
});

test('flow-clock calibration is explicit-only and T6 inversions are unavailable, never clamped', () => {
  assert.match(script,
    /const FLOW_MEASUREMENT_ENABLED = POPPET_DEV \|\| QUERY\.get\('measurement'\) === '1'/);
  assert.match(script, /if \(!FLOW_MEASUREMENT_ENABLED\) return null;[\s\S]*?window\.poppet\.flowClock\(\)/,
    'normal Manager sessions must not issue the five calibration IPC calls');
  assert.match(script, /raw < target\.timings\.T5[\s\S]*?target\.timings\.T6 = null/);
  assert.match(script, /POPPET_CLOCK_INVERSION/);
  assert.doesNotMatch(script, /Math\.max\(target\.timings\.T6Raw, target\.timings\.T5\)/,
    'T6 must not be fabricated by clamping a raw clock inversion');
  assert.match(mainScript, /function managerMeasurementEnabled\(event\)/);
  assert.match(mainScript, /if \(!managerMeasurementEnabled\(e\)\)[\s\S]*?POPPET_MEASUREMENT_DISABLED/,
    'a normal trusted Manager frame must not invoke the main measurement clock');
  assert.match(mainScript, /const T3 = measurement \? performance\.now\(\) : null/);
  assert.match(mainScript, /const T4 = measurement \? performance\.now\(\) : null/);
  assert.match(mainScript, /const T0 = measurement \? performance\.now\(\) : null/);
  assert.match(mainScript, /async function ensurePetReady\(id, timeoutMs = 5000, includeTiming = false\)/);
  assert.match(mainScript, /\.\.\.\(includeTiming \? \{[\s\S]*?timing: \{ T5:/,
    'operational first-frame readyAt may stay internal, but normal replies must omit T5 measurement evidence');
});

test('non-exportable characters get a disabled export button with an actionable reason; builtin renders no entry', () => {
  assert.match(script, /const exportBlocked = !c\.exportable && !c\.builtin;/);
  assert.match(script,
    /c\.exportable \? '<button class="char-export" title="导出角色包（\.poppetpack）">⇪<\/button>'\s*: exportBlocked \? '<button class="char-export" disabled>⇪<\/button>' : ''/,
    'a blocked non-builtin character must render a disabled export button; a builtin must render none');
  assert.match(script, /'legacy-schema': '旧格式角色无法导出：用原图重新创建一个新角色后即可导出'/,
    'legacy characters have no in-place upgrade (name/rig updates keep schemaVersion and never write icon.png), so the hint must point at re-creating from the source image');
  assert.match(script, /'missing-icon': '缺少头像文件，无法导出'/);
  assert.match(script, /EXPORT_BLOCK_HINTS\[c\.exportBlockReason\] \|\| '当前版本无法导出'/,
    'an unknown block reason must still fail closed to a generic hint instead of an undefined tooltip');
  assert.match(script, /if \(exportBtn && c\.exportable\) \{[\s\S]*?window\.poppet\.exportPack\(c\.id\)/,
    'only an exportable character may wire the export IPC');
  assert.match(script, /if \(!c\.exportable \|\| exportBtn\.disabled\) return;/,
    'the click path must fail closed even if a caller bypasses the disabled button');
  const blocked = script.match(/\} else if \(exportBtn\) \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.ok(blocked.length > 0, 'the disabled export branch must exist');
  assert.doesNotMatch(blocked, /window\.poppet\.exportPack|addEventListener/,
    'a disabled export button must not wire any export handler');
  assert.match(blocked, /exportBtn\.title = hint;/);
  assert.match(blocked, /exportBtn\.setAttribute\('aria-label', `角色 \$\{c\.name\} 无法导出：\$\{hint\}`\)/);
  assert.match(css, /\.char-item:hover \.char-export:disabled \{ opacity: \.35; cursor: default;/,
    'the disabled export button must stay visibly disabled on row hover');
});

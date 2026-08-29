// 推送前的本地闸门。
//
// 存在的理由是一句可以量化的话：**托管 CI 是计费的共享资源，不是你的开发回路。**
// 私有仓库按平台折算额度且每个 job 各自向上取整，一次 push 通道的运行约 10 个
// Linux 当量分钟；把 CI 当成"第一次运行测试"，等于用月度额度换一个本地几秒就能
// 得到的答案。CI 该做的是**确认你已经相信的结论**，而不是告诉你能不能跑。
//
//   node tools/precheck.mjs             # 快速闸门 + 该跑哪些冒烟的判断
//   node tools/precheck.mjs --smokes    # 连相关的 Electron 冒烟一起跑（需要图形会话）
//
// 冒烟不默认跑，因为它们要真实窗口、每个约 1–2 分钟，而且大多数改动用不上。
// 但"用不上"是要**判断**的，不是凭感觉——所以下面按改到的文件推断，而不是问你。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_SMOKES = process.argv.includes('--smokes');

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return ''; }
};

// 改到了什么：已提交但未推的 + 工作区里的，两者都算。
// 只看其中一半会漏——攒着几个提交再推的时候，未推的那些才是 CI 将要看到的东西。
function changedFiles() {
  const files = new Set();
  const upstream = git(['rev-parse', '--verify', '--quiet', 'origin/main']);
  if (upstream) {
    for (const f of git(['diff', '--name-only', 'origin/main...HEAD']).split('\n')) {
      if (f) files.add(f);
    }
  }
  for (const line of git(['status', '--porcelain']).split('\n')) {
    const f = line.slice(3).trim();
    if (f) files.add(f.includes(' -> ') ? f.split(' -> ')[1] : f);
  }
  return [...files];
}

// 文件 -> 哪个冒烟能覆盖它。这张表是判断的载体：改了渲染循环却只跑 npm test，
// 等于把"跑起来之后还动不动"这半个产品循环交给 CI 去发现。
const SMOKE_TRIGGERS = [
  {
    smoke: 'test:click',
    why: '渲染节拍、单击与拖拽的区分、点击穿透初始化',
    match: (f) => /^src\/renderer\/pet\//.test(f) || /^src\/shared\/(skeleton|parts|pipeline)\.js$/.test(f),
  },
  {
    smoke: 'test:manager',
    why: '导入 / 保存 / 重启恢复 / 角色包往返 / 骨架编辑器',
    match: (f) => /^src\/renderer\/manager\//.test(f)
      || /^src\/main\/(library|pack|zip|security|storage)\.js$/.test(f),
  },
  {
    smoke: 'test:multi',
    why: '多窗口的 IPC 路由与各自位置持久化',
    match: (f) => /^src\/main\/(index|display-rescue)\.js$/.test(f) || /^src\/main\/preload-/.test(f),
  },
];

const steps = [];
function step(name, command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  const ok = result.status === 0;
  steps.push({ name, ok, output: `${result.stdout || ''}${result.stderr || ''}`.trim() });
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    const tail = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-15);
    for (const line of tail) console.log(`      ${line}`);
  }
  return ok;
}

const changed = changedFiles();
console.log(`本地闸门（${changed.length} 个文件相对 origin/main 有改动）\n`);

// 1) 空白错误。CI 的第一步就是它，本地零成本。
step('git diff --check', 'git', ['diff', '--check']);

// 2) 工作流 YAML 只有在解析得动的时候才谈得上"生效"。
//    一个语法错的工作流不会报错，它会安静地什么都不跑。
const workflowChanges = changed.filter(f => /^\.github\/workflows\/.*\.ya?ml$/.test(f));
if (workflowChanges.length) {
  step(`workflow YAML 可解析（${workflowChanges.length} 个）`, process.execPath, ['-e', `
    const y = require('js-yaml'), fs = require('fs');
    for (const f of ${JSON.stringify(workflowChanges)}) {
      const d = y.load(fs.readFileSync(f, 'utf8'));
      if (!d || !d.jobs) throw new Error(f + ' 没有 jobs');
    }
  `]);
}

// 3) 全套测试。这是 CI 的 test job 会做的事，本地几秒就有答案。
step('npm test', 'npm', ['test']);

const implicated = SMOKE_TRIGGERS.filter(t => changed.some(t.match));

if (implicated.length) {
  console.log(`\n改动触及了 ${implicated.length} 个冒烟覆盖的范围：`);
  for (const t of implicated) console.log(`  · ${t.smoke.padEnd(14)} ${t.why}`);
  if (RUN_SMOKES) {
    console.log('');
    for (const t of implicated) step(t.smoke, 'npm', ['run', t.smoke]);
  } else {
    console.log('\n  这些不在 npm test 里，也不是 CI 每次推送都跑的（macOS 那边只在非 push 通道）。');
    console.log('  加 --smokes 在本地跑一遍；需要图形会话。');
  }
} else if (changed.length) {
  console.log('\n改动没有触及任何 Electron 冒烟覆盖的范围。');
}

const failed = steps.filter(s => !s.ok);
console.log('');
if (failed.length) {
  console.log(`✗ ${failed.length} 项未通过：${failed.map(s => s.name).join('、')}`);
  console.log('  先修好再推。push 到 main 会触发约 10 个当量分钟的托管 CI，');
  console.log('  用它来发现本地就能发现的问题是在烧月度额度。');
  process.exit(1);
}
console.log('✓ 本地闸门通过。');
console.log('  推送到 main 会跑：Linux/Windows 全套测试 + Windows 三个冒烟（约 10 当量分钟）。');
console.log('  macOS 与打包纯净度只在每周定时与 workflow_dispatch 上跑。');

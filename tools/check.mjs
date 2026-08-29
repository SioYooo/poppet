// 语法体检：对所有源码跑 node --check，捕捉打字错误。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['src', 'tools', 'test'];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];

  while (pending.length) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  }

  return files;
}

const files = ROOTS.flatMap(sourceFiles).sort((a, b) => a.localeCompare(b, 'en'));
let bad = 0;
for (const f of files) {
  const result = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (result.status !== 0) {
    bad++;
    const detail = (result.stderr || result.stdout || result.error?.message || 'unknown syntax-check failure')
      .trim()
      .split('\n')
      .slice(0, 6)
      .join('\n');
    console.error('✗ ' + f + '\n' + detail + '\n');
  }
}
console.log(bad ? `${bad}/${files.length} 个文件有语法错误` : `${files.length} 个文件语法检查通过`);
process.exit(bad ? 1 : 0);

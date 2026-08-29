'use strict';

// macOS 的最后一道签名闸门。
//
// 为什么需要它：electron-builder 在**找不到签名身份**时会直接跳过签名，而且不会
// 回退到 ad-hoc。留下的是 Electron 预编译二进制自带的 linker 签名——它的
// Identifier 是字面量 `Electron`（与 Info.plist 的 com.sioyoo.poppet 不符），
// 而且 app 包被 afterPack 改过之后资源从未被重新封存。真机实测（macOS 27.0 /
// arm64，2026-08-27）：
//
//   codesign --verify --deep --strict  ->  "code has no resources but signature
//                                           indicates they must be present"
//
// 这不是"未签名"，是**签名结构损坏**。两者对用户的差别很大：结构损坏的包在带
// 隔离属性下载后多半直接报「App 已损坏」——那句话是死路，用户会去删掉它；而结构
// 完整但没有 Developer ID 的包报的是「无法验证开发者」，用户能走系统设置里的
// 「仍要打开」。同一次实测，补一次正确 ad-hoc 签名之后：
//
//   codesign --verify  ->  valid on disk / satisfies its Designated Requirement
//   spctl              ->  rejected            （未签名 app 的**正常**判定）
//   Identifier         ->  com.sioyoo.poppet  （与 Info.plist 一致）
//   Sealed Resources   ->  version=2 rules=13 files=16
//
// ad-hoc 签名不是 Developer ID，不能公证，也不会让 Gatekeeper 放行——它只是把
// "坏掉的签名"修成"诚实的未签名"。真正的信任仍然要买 Apple Developer 会员。
//
// 顺序上这一步必须在 afterSign：afterPack 跑在签名**之前**，在那里签会被随后的
// 签名步骤覆盖或作废。而一旦真的配置了 Developer ID，electron-builder 会先完成
// 正常签名，下面的检测就会认出它并原样放行。

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

function codesign(args) {
  return execFileSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// `codesign -d` 把展示输出（包括 TeamIdentifier=）写在 **stderr**，stdout 恒为
// 空。只用 execFileSync 的返回值（stdout）会永远看不到团队标识——真 Developer ID
// 签名会被下面的 ad-hoc 修复静默覆盖。所以这里必须同时读两个流。2026-08-28
// 在 macOS 27.0 上实测：对系统自带已签名应用，stdout 为空、stderr 含完整展示。
function displaySignature(appPath, runner) {
  if (runner) return runner(appPath);
  const result = spawnSync('codesign', ['-d', '--verbose=1', appPath], { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

// 已经有真实身份签过就不要碰。判据是 TeamIdentifier：ad-hoc 与 linker 签名都
// 报 "not set"，只有真正的 Developer ID 会带上团队标识。runner 仅测试注入用；
// 展示命令本身失败（codesign 缺失等）按"没有真实身份"处理，不向上抛。
function hasRealIdentity(appPath, runner) {
  try {
    return /TeamIdentifier=(?!not set)\S+/.test(displaySignature(appPath, runner));
  } catch {
    return false;
  }
}

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  if (hasRealIdentity(appPath)) {
    console.log(`  • afterSign: ${appName} 已由真实身份签名，跳过 ad-hoc 修复`);
    return;
  }

  // --force 替换掉 Electron 自带的 linker 签名；--deep 一并处理内部
  // framework 与 helper。没有它们，外层签名会因为内部未签而校验失败。
  codesign(['--deep', '--force', '--sign', '-', appPath]);

  // fail-closed：签完必须校验得过。发出一个校验不过的包，比构建失败糟得多——
  // 前者要等用户装不上才发现，而那时它已经是"发布过的版本"了。
  try {
    codesign(['--verify', '--deep', '--strict', appPath]);
  } catch (error) {
    const detail = `${error.stdout || ''}${error.stderr || ''}`.trim();
    throw new Error(`afterSign: ${appName} 的 ad-hoc 签名校验失败，拒绝产出该包。\n${detail}`);
  }
  console.log(`  • afterSign: ${appName} 已 ad-hoc 签名并通过校验（仍未公证）`);
}

afterSign.hasRealIdentity = hasRealIdentity;
afterSign.displaySignature = displaySignature;
module.exports = afterSign;

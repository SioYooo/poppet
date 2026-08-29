// 仅供未打包 --dev 自动化；electron-builder 与 package purity gate 必须排除此目录。
export function installManagerHooks(api) {
  window.__poppetDev = Object.freeze({ ...api });
}

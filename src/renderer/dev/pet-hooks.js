// 仅供未打包 --dev 自动化；electron-builder 与 package purity gate 必须排除此目录。
export function installPetHooks(api) {
  window.__poppetPace = api.pace;
  window.__poppetPetDev = Object.freeze({ act: api.act });
  window.__poppetDev = Object.freeze({
    charId: api.charId,
    state: api.state,
    blink: api.blink,
    pose: api.pose,
    blinking: api.blinking,
    sourceDataURL: api.sourceDataURL,
    atlasDataURL: api.atlasDataURL,
    meta: api.meta,
    frameReady: api.frameReady,
  });
}

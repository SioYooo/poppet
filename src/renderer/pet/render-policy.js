// 渲染节流与跳帧决策：从 pet.js 主循环里提出来的纯函数，node 可直接
// 断言边界条件，不依赖 DOM。
//
// 两层互补的省电机制（电量成本来自"多久产生一帧"，不是"每帧做什么"）：
// 1. idle 降频：真正静息（idle 状态、无眨眼且眨眼不在即、无近期交互）时把
//    节拍降到 IDLE_THROTTLE_FPS；任何状态/交互/眨眼临近立即回到全速。
// 2. 量化跳帧：pose 逐帧的亚像素漂移（呼吸 ~0.03 设备像素/帧）量化到设备
//    像素后与上一绘制帧相同，就跳过 clearRect+drawImage——画布内容与屏幕
//    严格一致，点击穿透的 alpha 采样因此天然正确。
//
// 两层都被同一条铁律约束：首帧确认（需要真实绘制）之前一律全速、逐帧绘制。

export const IDLE_THROTTLE_FPS = 20;
export const IDLE_HOLDOFF_MS = 4000;
// 眨眼计时器低于该值就提前回到全速：repo 有过低帧率眨眼只画两三帧的
// 真实缺陷（pet.js 顶部注释），预升速让眨眼永远在全速节拍里发生。
export const BLINK_PREBOOST_S = 0.25;

// 返回本帧应使用的节拍间隔（ms）。任何不满足静息条件的情况都返回全速
// frameMs——失败方向永远是"多画"，不是"少画"。
export function effectiveFrameMs({
  frameMs, firstFrameAcked, dragging, state, blinkActive, blinkTimer, sinceActivityMs,
}) {
  if (!firstFrameAcked || dragging) return frameMs;
  if (state !== 'idle') return frameMs;
  if (blinkActive) return frameMs;
  if (!(blinkTimer > BLINK_PREBOOST_S)) return frameMs;
  if (!(sinceActivityMs >= IDLE_HOLDOFF_MS)) return frameMs;
  return Math.max(frameMs, 1000 / IDLE_THROTTLE_FPS);
}

// 把姿态量化到"设备像素 / 边缘像素位移"分辨率的绘制身份。两帧 key 相同
// 意味着按最近邻像素网格它们画出来逐像素相同，跳过绘制不改变屏幕内容。
// 分辨率选择：位移量化到 1 设备像素；缩放量化到"精灵边长 × 缩放"的整数
// 像素（大精灵自动获得更细步进）；旋转量化到"最长边 × 弧度"≈ 1 边缘像素。
//
// frameKey 承载"整体姿态之外还有什么在变"：多帧素材是帧号，单帧素材是眨眼/口型，
// 骨架角色是关节档位串。三者都是离散量，所以合成出来的键同样离散——
// 骨架角色不会因为关节角度是浮点就每帧产生新键。
export function poseDrawKey({
  charId, canvasWidth, canvasHeight, drawScale, facing,
  pose, spriteWidth, spriteHeight, frameKey,
}) {
  const w = spriteWidth * drawScale;
  const h = spriteHeight * drawScale;
  const edge = Math.max(w, h);
  return `${charId}|${canvasWidth}x${canvasHeight}|${drawScale}|${facing}|`
    + `${Math.round(pose.offsetX * drawScale)},${Math.round(pose.offsetY * drawScale)}|`
    + `${Math.round(pose.scaleX * w)},${Math.round(pose.scaleY * h)}|`
    + `${Math.round(pose.rotate * edge)}|`
    + `${Math.round(pose.sway * drawScale)}|`
    + frameKey;
}

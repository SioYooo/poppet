# Poppet — 像素立绘桌宠

[![CI](https://github.com/SioYooo/poppet/actions/workflows/ci.yml/badge.svg)](https://github.com/SioYooo/poppet/actions/workflows/ci.yml)
[![许可证：禁止商用 · PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm_Noncommercial_1.0.0-blue.svg)](LICENSE)

把一张自己的像素立绘变成会呼吸、眨眼、回应点击并在桌面上溜达的桌宠。
Poppet 是面向 macOS 与 Windows 的本地优先 Electron 应用：无需账号，当前源码没有遥测、
云端图片处理或自动更新客户端。

> **Poppet 本体永久免费。** 无需购买、订阅或打赏即可使用全部 Core 功能。
> **代码和项目美术素材均不允许商用，美术素材单独许可。**
> 代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，美术采用
> [Poppet 非商业美术许可](ASSETS_LICENSE.md)。这是源码可见项目，不是 OSI 意义上的开源项目。

默认角色由作者使用 OpenAI 图像生成创建，详见 [美术来源记录](docs/default-character-provenance.md)。

![角色管理器：默认角色像素化前后对比预览](docs/media/manager-pixelize-original.png)

| Classic 像素化预设 | 桌宠实际渲染帧 |
| --- | --- |
| ![Classic 预设的像素化前后对比](docs/media/pixelize-classic.png) | ![重启后桌宠窗口的实际渲染帧](docs/media/pet-desktop.png) |

以上截图均使用随包默认金发角色，说明见 [docs/media/README.md](docs/media/README.md)。

## 能做什么

- 导入透明背景或纯色背景的像素立绘，并在本地自动去背、裁剪和量化。
- 可选 Tiny、Chunky、Classic、Detailed 本地像素化预设；处理完全确定、非生成式 AI，
  默认 Original 保持原有输出路径。
- 保守地自动定位眼睛与嘴；检测评分过低时不启用眨眼，识别不准可手工重画并在保存前预览眨眼。
- 支持静态图片、GIF 和手动指定网格的 sprite sheet。
- 生成呼吸、眨眼、嘴型、点击反馈、拖拽、落地和走动效果。
- 多帧素材可按行为分段（待机 / 走路 / 拖拽 / 招手），桌宠按当前状态播对应的那几帧，
  而不是整条帧带无差别循环。
- 支持关节骨架角色：部件画一次，走路摆臂、迈腿、悬空垂挂、落地屈膝、招手由运行时算出，
  表情用整块部件替换。管理器可以调枢轴、接点、层序与驱动器增益并实时预览
  （只能编辑已有骨架，不能凭空生成——骨架是作者标的，不是从图里检测的）。
- Create 会先原子保存角色，再等待对应桌宠真正显示并画出首个非空帧后才提示成功；
  如果角色已保存但显示失败，可直接重试而不会重复导入。
- 管理多个角色，最多同时显示 6 只，并记住各自位置。
- 支持把自建角色导出为 `.poppetpack` 角色包、或导入他人分享的角色包；
  归档按 fail-closed 安全边界校验（大小/条目/哈希/膨胀比），内置品牌角色不允许导出。
- 桌宠设置提供 30/45/60 fps 帧率档位（省电模式），即时生效。
- 支持点击穿透、多显示器，以及 macOS/Windows 平台差异。
- 应用图标、macOS 菜单栏图标与 Windows 通知区域图标固定使用随包金发角色；
  免费 Core 不允许替换，用户自选品牌图标仅保留给未来付费功能，当前尚未实现。

复杂背景仍需先在其他工具中去背；Poppet 会明确提示而不会假装已完成高级抠图。

单张立绘支持呼吸、眨眼和整体动作；独立肢体动画需要预先制作好的多帧或骨架素材。
播放能力完整包含在永久免费本体中。

## 从源码运行

要求：Node.js 22、npm，以及受支持的 macOS 或 Windows 开发环境。

```bash
git clone https://github.com/SioYooo/poppet.git
cd poppet
npm ci
npm test
npm start
```

首次启动会加载内置角色。开发时可用 `npm run dev:isolated` 启动独立的临时资料目录。

## Release

最新版：[v0.1.0-alpha.1](https://github.com/SioYooo/poppet/releases/tag/v0.1.0-alpha.1)（Alpha，未签名）。
支持 macOS 和 Windows。此历史安装包沿用随包许可；当前源码采用下述非商业许可。

## 使用

从托盘菜单打开“角色管理”，拖入图片或选择图片文件。处理后可以比较/选择本地像素化
风格、校正表情区域、选择移动方式、预览并保存。桌宠支持以下基本操作：

| 操作 | 行为 |
| --- | --- |
| 单击 | 随机动作 |
| 按住拖动 | 拎起并移动，松手后落地 |
| 右键或托盘菜单 | 管理角色和设置 |
| 放置不管 | 呼吸、眨眼，并可按设置溜达 |

用户角色与设置保存在 Electron 的本机用户数据目录。请保留原始图片的独立备份；Alpha
阶段不要把 Poppet 角色库当作唯一副本。隐私边界见 [PRIVACY.md](PRIVACY.md)。

## 许可与永久免费承诺

**Poppet 本体（Core）永久免费。** 不设试用到期、订阅解锁或打赏专属 Core 功能。
免费指使用价格，不代表商业使用授权。

- **代码及文档禁止商用**，适用 [PolyForm Noncommercial 1.0.0](LICENSE)。
  非商业使用、学习、修改与分享须遵守许可；允许目的的具体定义以许可原文为准。
- **项目美术素材单独许可，且禁止商用**，适用 [ASSETS_LICENSE.md](ASSETS_LICENSE.md)。
  不得把默认角色、图标或参考图拆出转售、用于广告、商业产品或商业服务。
- 第三方依赖保留各自许可；用户导入的素材也不会被本项目重新授权。
  见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 新许可不撤销此前 MIT 版本已经授出的权利；旧代码部分的 MIT 声明继续保留。
- 贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。漏洞走
  [SECURITY.md](SECURITY.md) 的私密渠道；一般问题见 [SUPPORT.md](SUPPORT.md)。

## 自愿打赏

Poppet 本体永久免费；喜欢的话，可以请作者喝一杯咖啡。

Poppet Core is free forever. If you like it, buy the author a coffee.

<table>
  <tr><th>微信 / WeChat</th><th>支付宝 / Alipay</th><th>PayPal</th></tr>
  <tr>
    <td align="center"><a href="assets/qrcode/wechat_qr.JPG.jpeg"><img src="assets/qrcode/wechat_qr.JPG.jpeg" height="260" alt="微信打赏收款二维码 / WeChat donation QR code"></a></td>
    <td align="center"><a href="assets/qrcode/zfb_qrJPG.jpeg"><img src="assets/qrcode/zfb_qrJPG.jpeg" height="260" alt="支付宝打赏收款二维码 / Alipay donation QR code"></a></td>
    <td align="center"><a href="assets/qrcode/QR%20code.png"><img src="assets/qrcode/QR%20code.png" width="220" alt="PayPal 打赏收款二维码 / PayPal donation QR code"></a></td>
  </tr>
</table>

点击图片查看原始收款码，再用对应支付应用扫描；付款前请核对收款方与金额。

Click an image to view the original QR code. Confirm the recipient and amount in your payment app.

不打赏也能完整使用全部 Core 功能。打赏不提供代码或美术的商用授权，
也不承诺定制功能、优先支持或交付日期。详见 [打赏说明](DONATE.md)。

# Agent Note: 平台适配的应用图标资源

Status: implemented

[English](2026-09-20-platform-adaptive-app-icons.md) | 中文

## 问题

APP-ICON-001 曾将同一张满幅方形位图用于 Windows、浏览器 favicon、PWA 安装和 Apple 系统界面。共享像素保留了品牌身份，却忽略了不兼容的平台职责：Apple 会对方形图层施加系统遮罩，Windows 与浏览器界面会直接暴露未遮罩的边角，而 PWA maskable 图标需要不透明背景和受到保护的核心图形。原素材包还包含字节完全相同的普通图标与 maskable 图标，没有证据证明重要图形位于标准安全区内。

## 决策

1024×1024 的 `apps/electron/assets/app-icon.png` 是唯一方形品牌母版。Apple ICNS、Dock 与 Apple Touch Icon 资源保留方形、未遮罩图形，让操作系统负责最终形状，遵守 [Apple App 图标规范](https://developer.apple.com/design/human-interface-guidelines/app-icons)。Windows ICO 帧、Web favicon 与 PWA `purpose: any` 资源使用半径为画布 3/16 的透明圆角底板。PWA `purpose: maskable` 资源保留完整不透明方形背景，并让每个白色趋势线像素都位于 [Web App Manifest 安全圆](https://www.w3.org/TR/appmanifest/#icon-masks)内，该圆半径为图标尺寸的 40%。

`scripts/generate-app-icon-assets.ts` 使用仓库自有的 PNG 解码、面积降采样、抗锯齿透明遮罩、PNG 编码和 ICO 封装逻辑派生所有非 ICNS 平台资源。生成器校验已记录的母版摘要，并提供检查模式，将每项输出与已提交文件逐字节比较。整个过程不重绘，也不推断任何品牌像素。

## 验证

聚焦测试将已提交资源与生成器的新鲜输出比较，解码 Web 最终构建资源，检查每个 favicon 与 Windows ICO 帧，要求 Windows／Web 普通图标具有透明圆角，要求 Apple 与 maskable 资源边角不透明，并拒绝安全圆外出现任何白色 maskable 品牌像素。Electron Packager 继续解析最终 ICNS 和 ICO 输入，发布任务继续将 macOS 包内资源及 Windows 可执行文件提取图标与仓库资源比较。

## 曾考虑的替代方案

**预先裁切共享母版圆角。** 这种方式只需维护一种视觉位图，但会与 Apple 的系统遮罩职责冲突，并可能形成双重圆角或锯齿边缘。

**将原有普通 PWA 图标直接声明为 maskable。** 这种方式无需新增文件，但无法证明 maskable 声明成立，也会让需要不透明背景的安装资源与普通图标表现耦合。

**使用图像编辑器或生成式模型分别制作目标资源。** 手工导出可能一次获得正确外观，但无法作为可重复变换接受审查，也可能静默改变已批准的品牌图形。

## 影响

各平台获得由自身职责决定的外框，同时所有变体保留同一套已批准图形。变更资产时必须更新母版摘要并重新生成已提交派生文件，因此意外手工编辑会触发校验失败。仓库为避免依赖环境特定导出工具而持有一小段 PNG／ICO 实现；其 PNG 输入明确仅支持非隔行的 8 位 RGBA 图像。自动检查能够证明像素与打包事实，但 Windows 任务栏／EXE 显示、移动端安装和操作系统升级缓存仍属于目标平台 UAT 责任。

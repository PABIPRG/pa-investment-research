# 应用图标

[English](README.md) | 中文

PAB-22 / APP-ICON-001：0.2.0 新版应用图标。原包保存在 `../icon-source/app-icons-0.2.0.zip`，源图为包内 `original/icon-1024.png`，与 1024×1024 方形品牌母版 `app-icon.png` 相同。

原包 SHA-256：`749e4a5d41f28757149a4f5aefab779f164e7fecec3cd65d3c53a61229a42f01`。

Apple 资源保持未预裁切的方形图层：`app-icon.icns` 由方形母版生成 16、32、128、256、512 像素的 1x/2x 切片后封装，运行时 Dock 图标使用方形 `app-icon.png`，由 macOS 施加最终圆角遮罩。此规则遵循 [Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons) 对未遮罩方形图层的要求。

Windows `app-icon.ico` 使用透明圆角底板，包含 16、24、32、48、64、128、256 像素 PNG 帧。Web favicon 和 PWA `purpose: any` 使用同一平台适配原则，但分别生成独立资源；Apple Touch Icon 继续使用未预裁切方形资源。PWA `purpose: maskable` 使用不透明满幅背景，白色趋势线保持在 [Web App Manifest](https://www.w3.org/TR/appmanifest/#icon-masks) 定义的中心 40% 半径安全圆内。

运行 `pnpm run gen-app-icons` 从 `app-icon.png` 重新生成 Windows ICO、Web favicon、Apple Touch Icon 与 PWA 图标；运行 `pnpm run verify-app-icons` 检查仓库资源是否与确定性派生结果逐字节一致。脚本不重绘、不生成品牌内容，也不改写 Apple 母版或 ICNS。打包配置按目标平台显式传入 `.icns`、`.ico` 或 PNG 路径；组装前检查目标文件存在，并把必需格式被跳过的 Packager warning 升级为失败。

0.2.0-alpha.2 的发布与 UAT 矩阵仅覆盖 macOS arm64/x64、Windows x64、Web/PWA 与移动触屏安装；Linux `.desktop` / hicolor 安装资源不属于本里程碑目标，本次不扩展 Linux installer。此处“跨平台”仅指上述已列目标，不代表 Linux 原生安装集成已验收。

Web 资源位于 `apps/web/public/icons/app-icon-001/`，以独立路径隔离旧图标缓存。manifest 保留应用名称、启动路径与显示模式，并分别声明 192/512 像素的 `any` 与 `maskable` 资源；两类文件字节不同，自动检查覆盖透明角、不透明背景和趋势线安全区。

验收应覆盖浏览器页签、触屏入口、macOS Dock/Finder、Windows 可执行文件及任务栏，以及安装升级后的系统图标缓存。

## 本地验证记录（2026-09-11）

结论：代码与资源接入已实现；Web 真实入口已完成双主题、双视口验收，桌面跨平台发布验收仍为 Inconclusive。

- passed：Electron packaging 22 项、发布工作流 15 项、Web PWA 2 项、frontend-static 真实 Loader/HTTP 组合测试 1 项（PNG/ICO GET 与 HEAD）。
- passed：宿主 TypeScript 检查，以及包含 `build:lib`、`build:web`、`build:electron` 的完整构建。
- passed：源图逐字节一致；ICO 7 档 PNG 帧尺寸与偏移、ICNS 容器、manifest 尺寸；Electron Packager 实际解析 `.icns` / `.ico`。
- passed：本机 `darwin-arm64` 完成 Electron Forge make 与严格签名校验；最终 `.app` 的 `CFBundleIconFile` 为 `electron.icns`，包内 ICNS 与源文件 SHA-256 一致，解包后包含 16–1024px 的 10 个 1x/2x 切片，组装日志未出现 `.icon`、找不到图标或跳过图标格式的 warning。
- passed：隔离 `DSH_HOME=/private/tmp/pab22-dsh-home-3093`，`dsh web --port 3093`；真实浏览器加载 Web 壳，1440×900 与 1024×768 的浅色、深色主题均无裁切或布局异常。截图保留于本次 Codex 任务的浏览器工具记录。
- passed：DOM 命中 manifest、ICO、32px PNG 与 Apple Touch Icon；ICO、PNG 和 manifest 均返回 HTTP 200，MIME 分别为 `image/x-icon`、`image/png` 和 `application/manifest+json`；manifest 的 192/512 图标声明正确。
- not-tested：macOS Finder/Dock 原生表面（自动化未获 Finder 访问权限）、移动端触屏安装、Windows 最终安装包原生显示、macOS/Windows 升级缓存。入口截图使用 Web 壳，未启动投研后台。

未验证项由 PAB-22 实施负责人在 0.2.0-alpha.2 发布前补齐；关联 PAB-15 产物，在目标系统安装并升级，保留 Dock/Finder、任务栏/可执行文件与浏览器快捷方式截图后关闭。业务加载、筛选、权限、危险操作与撤销状态不受本次静态应用图标变化影响。

## 平台适配验证记录（2026-09-20）

结论：像素与构建证据通过，目标系统安装表面验收仍为 Inconclusive。

- passed：`verify-app-icons` 逐字节复现 10 项派生资源；图标生成与 Electron packaging 聚焦测试 38 项、Web 最终构建 PWA 测试 2 项通过；新增脚本严格 TypeScript 检查和完整 `pnpm run build` 通过。
- passed：Windows ICO 逐帧验证 16、24、32、48、64、128、256px 尺寸、透明圆角与不透明中心；Web favicon、PWA `any`、Apple Touch Icon 和 PWA `maskable` 从最终构建目录解码验证。两档 maskable 图标边角完全不透明，白色趋势线没有像素超出中心 40% 半径安全圆。
- passed：真实图像渲染检查覆盖 Windows ICO 的 16px 与 256px 帧、192px maskable 和 180px Apple Touch Icon；品牌图形均可辨认，Apple 资源保持方形，平台资源没有误用同一份预裁切位图。
- not-tested：浏览器原生页签与 PWA 安装界面、移动端触屏安装、Windows 最终 EXE 与任务栏、macOS Finder/Dock，以及 macOS/Windows 升级图标缓存。本 worktree 未获独立常驻服务端口，浏览器文件入口又受安全策略限制；这些结果不能由构建或像素检查推断为通过。

## Windows 发布图标回归

发布运行 `34578047814` 的 Windows 构建记录了找不到 `.ico` 并跳过应用图标的 warning；运行总体成功，不代表图标已嵌入。当前修复显式传入 `app-icon.ico`，使用 Packager WindowsApp 的实际 `getIconPath()` 验证命中资源，并检查 7 档 PNG 帧的头、尺寸与偏移。CI 还会从最终 EXE 提取 32px 关联图标并与源 ICO 逐像素比较。该回归归入 PAB-22，关联 PAB-15。现有已发布资产未修改；最终 Windows 原生显示与升级缓存仍须由下一轮候选包验收。

## macOS Packager warning 说明

Electron Packager 18 在已有有效 `.icns` 时仍会先探测 Apple Icon Composer 的可选 `.icon` 格式；“extension `.icon`”warning 本身不代表 `.icns` 缺失。当前实现只过滤这一条可选探测，并在组装前确认 `.icns` 文件存在；若 `.icns` 本身缺失或被跳过，打包立即失败。CI 另外核对 `CFBundleIconFile`，并逐字节比较 `.app` 资源目录内的 ICNS 与源文件。

原始 ZIP 位于 `icon-source/`，不属于 Electron `files` 发布白名单；安装包只携带运行所需图标。主线的 assets 入包策略及下载缓存回归测试均已保留。

# 应用图标

PAB-22 / APP-ICON-001：0.2.0 新版应用图标。原包保存在 `source/app-icons-0.2.0.zip`，源图为包内 `original/icon-1024.png`，与 `app-icon.png` 相同。

原包 SHA-256：`749e4a5d41f28757149a4f5aefab779f164e7fecec3cd65d3c53a61229a42f01`。

`app-icon.icns` 由 macOS `sips` 生成 16、32、128、256、512 像素的 1x/2x iconset 后经 `iconutil -c icns` 转换。`app-icon.ico` 包含 16、24、32、48、64、128、256 像素 PNG 帧；运行时使用 1024 像素 PNG。打包配置使用无扩展名路径，由 Electron Packager 按目标平台选择格式。

Web 复用原包的 favicon、触屏图标和 192/512 像素资源，路径为 `apps/web/public/icons/app-icon-001/`，以新路径隔离旧图标缓存。保留原 manifest 的应用名称、启动路径与显示模式。未声明 maskable：原包同名资源与普通图标相同，安全裁切尚未通过验收。

验收应覆盖浏览器页签、触屏入口、macOS Dock/Finder、Windows 可执行文件及任务栏，以及安装升级后的系统图标缓存。

## 本地验证记录（2026-09-11）

结论：代码与资源接入已实现；发布验收 Inconclusive，桌面安装包与升级验证尚未完成。

- passed：Electron packaging 14 项、Web PWA 2 项、frontend-static 真实 Loader/HTTP 组合测试 1 项（PNG/ICO GET 与 HEAD）。
- passed：`build:lib`、`build:web`、`build:electron`；MIME 修改后补跑 frontend-static TypeScript 与包构建。
- passed：源图逐字节一致；ICO 7 档 PNG 帧尺寸与偏移、ICNS 容器、manifest 尺寸；Electron Packager 实际解析 `.icns` / `.ico`。
- passed：隔离 `DSH_HOME=/tmp/pab22-dsh-home`，`dsh web --port 3182`；真实浏览器加载 Web 壳、检查 DOM 图标引用，1440×900 和 1024×768 浅色入口可渲染；512px 图标在浏览器深色图片背景下显示完整。截图保留于本次 Codex 任务的浏览器工具记录。
- passed：PNG/ICO 最终 HTTP 200，分别返回 `image/png` / `image/x-icon`；修复前 PNG 为 `application/octet-stream`，浏览器直接打开被拦截，修复后可显示。
- not-tested：浏览器原生页签图标外观、移动端触屏安装、操作系统裁切、macOS/Windows 最终安装包与升级缓存、深色应用主题。入口截图使用 Web 壳，未启动投研后台。

未验证项由 PAB-22 实施负责人在 0.2.0-alpha.2 发布前补齐；关联 PAB-15 产物，在目标系统安装并升级，保留 Dock/Finder、任务栏/可执行文件与浏览器快捷方式截图后关闭。业务加载、筛选、权限、危险操作与撤销状态不受本次静态应用图标变化影响。

## Windows 发布图标回归

发布运行 `34578047814` 的 Windows 构建记录了找不到 `.ico` 并跳过应用图标的 warning；运行总体成功，不代表图标已嵌入。当前修复补齐 `app-icon.ico`，使用 Packager WindowsApp 的实际 `getIconPath()` 验证命中资源，并检查 7 档 PNG 帧的头、尺寸与偏移。该回归归入 PAB-22，关联 PAB-15。现有已发布资产未修改；最终 Windows EXE 图标仍须由下一轮候选包验收。

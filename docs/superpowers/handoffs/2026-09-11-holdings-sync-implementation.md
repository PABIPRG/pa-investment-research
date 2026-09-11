# 同花顺同步实施与验证（PAB-16）

## 基准与边界

基准为 `66bcd07eb6450c10722d9441755d3b1c9252d571`，专属 worktree 为 `/Users/xiexin/.codex/worktrees/3d2f/pa-investment-research`，目标分支 `codex/holdings-sync-guided-onboarding`；当前采用托管 detached HEAD。PR #85 已合并，不继承旧 worktree 的改动。工作项：https://linear.app/pabiprg/issue/PAB-16 。仅使用独立端口 3098，不操作 3080，不执行 Computer Use、提交、推送或 PR。

## 能力审计与体验契约

| 动作 | 现有入口和状态所有者 | 缺口 | 决策 |
|---|---|---|---|
| 选择账户 | holdings user-config / config.py | 首次默认真实账户 | 扩展 |
| 检测客户端 | holdings_source.provider_snapshot / detect_clients | 检测可能触发 get_holdings；缺结构化状态 | 扩展 |
| 读取 | mac_ths / easytrader provider | macOS 直接 activate，Windows 查询可能导航 | 扩展 |
| 原生引导和确认 | Electron main / preload | 缺允许列表和本次确认 | 扩展 |
| 替换与历史 | record_holdings_snapshot / JsonStore | 读取即保存，没有预览有效性校验 | 扩展 |
| 手动退路 | HoldingsEditor 单条及批量导入 | 无 | 复用 |

所有状态、权限、来源、账户模式、时间与条数均为确定性数据，不调用模型。向导保留操盘账户、准备状态、读取预览确认三个模块；主操作随阻塞原因变化。加载、刷新、空结果、部分读取、错误、无权限、禁用、成功、确认和过期均适用；筛选无结果不适用。替换保留可追溯快照。桌面目标 1440/1024，Web 窄屏 768/390；Electron 维持既有最小窗口限制。

## 实施顺序

1. 先失败测试：权限前置、被动读取、预览不写入、空结果拒绝、token 过期/重复/账户变化/本地持仓变化。
2. 扩展现有 source owner 与 provider；macOS 优先 AX，只在获准原生操作中降级 AppleScript；Web 只读取已暴露表格。
3. Electron 主进程确认与固定动作，后台原生入口使用宿主私有凭证；前端不可提交任意命令或路径。
4. runtime 映射与三模块向导，确认替换才刷新当前持仓。
5. 聚焦后端、组件、原生与 runtime 契约、主题、类型/构建检查；记录真实 UAT 缺口。

## 实现结果

- 首次默认模拟账户；保留既有保存选择与真实/模拟隔离。
- source 快照不再通过 get_holdings 推断错误，安装、进程、权限和阻塞原因使用结构化字段。
- macOS 默认被动 AX 读取；未授权或无法确认账户时拒绝。获准导航先 AX，失败后才 AppleScript；仅实际 TCC 拒绝触发自动化引导。Windows 被动读取账户窗口，原生读取保存并恢复前台句柄。
- Electron 主进程逐次确认路径、影响与返回；IPC 限定主框架、固定动作和本机文件选择器。原生 API 使用宿主私有凭证且不在 Remote 映射中；退出等待在途操作结束。
- 预览五分钟有效且不落盘，确认时检查账户、数据源、数据目录和当前持仓，在同一存储事务保存并记录快照。拒绝空结果、部分数据、过期、重复提交和过时基线。
- 三模块向导提供官方下载、权限操作示例、返回后一次检查、Web 人工导航、预览取消和确认替换；390px 全屏式弹层，表格局部滚动。
- 补齐 macOS PyObjC 和 Windows easytrader/pywinauto/pywin32 打包依赖，更新锁摘要。

## 自动验证（2026-09-11）

| 检查 | 结果 | 证据 |
|---|---|---|
| Python 聚焦：test_holdings_preview / sync / user_config / account_modes / mac_ths | passed，87 项 | `/private/tmp/pab16-python-final.log` |
| 工作台组件与 runtime 映射 | passed，86 项 | `/private/tmp/pab16-focused-final.log` 中 89 项含旧版 3 项原生测试；最后原生测试单独补跑 |
| Electron 原生动作 | passed，4 项 | `/private/tmp/pab16-native-final.log`，覆盖取消、逐次确认、输入限制、失败返回与退出等待 |
| 目标 TypeScript 构建 | passed | `/private/tmp/pab16-types-final.log`、`/private/tmp/pab16-native-types.log` |
| Host、Client、Web、Electron 构建 | passed（Web 套件进入浏览器阶段前已完成） | `/private/tmp/pab16-web-host.log`；最后原生改动单独补跑 Electron bundle |
| 3098 临时后端 HTTP | passed | 隔离状态目录；模拟账户、无效 commit 拒绝、原生匿名请求 403、持仓不变；进程已在 finally 关闭 |
| 依赖锁摘要、git diff --check | passed | 全部 requirements 与目标锁 SHA-256 一致 |
| test:gui 宿主重跑 | failed，4270 通过、8 失败、4 跳过 | `/private/tmp/pab16-gui-host.log`；失败位于未修改的 ui-agent-preset（3）、ui-directory-picker-browse（3）、ui-settings-models（1）、ui-theme（1，指向未修改的 KycProfilePanel.module.css） |
| verify-client-theme-styles | failed | `/private/tmp/pab16-theme.log`；既有 CSS 颜色和其他组件内联样式违规，不在本次新增样式中 |
| DSH_SNAPSHOT=replay pnpm run test:web | not-tested（套件未完成） | sandbox 与宿主两次运行均未收敛；已停止所属测试及 headless 浏览器进程。不能计作通过 |

## 真实验收与验证债务

结论：**Inconclusive**，不可据此标记发布就绪或 Linear Done。自动测试与 HTTP 冒烟不是真实客户端 UAT。

| 验收项 | 状态 | 剩余风险 / 关闭条件 |
|---|---|---|
| macOS Electron 首次权限、实际读取进程身份 | not-tested | 签名宿主上验证 TCC 归属与往返检查 |
| 真实/模拟账户读取、导航及失败返回 | not-tested | 同花顺真实版本验证账户选中属性、表格完整性、取消不切前台、失败返回 |
| macOS Web 人工导航与确认覆盖 | not-tested | 真实入口完成读取、取消、提交、刷新后持久化检查 |
| Windows 安装、定位、窗口及权限级别 | not-tested | Windows 原生环境验证，不以模拟契约测试替代 |
| 浅色/深色、1440/1024/768/390、键盘与溢出 | not-tested | 真实渲染与截图证据待补 |
| 完整 GUI / 主题 / Web 门禁 | failed / not-tested | 记录并处理既有失败与 Web 套件不收敛后重验 |

验证债务负责人：PAB-16 后续实施/验收任务；到期点：进入发布就绪或 Done 之前；Linear 当前已关联里程碑 `0.2.0-alpha.1`。本机没有 Computer Use 授权，未调用该能力，也未操作真实同花顺或系统权限。保留当前 worktree 未提交改动，不提交、不推送、不建 PR，不操作共享 3080。


## 用户验收反馈与流程复盘（2026-09-11）

用户 Electron 截图证明：准备检测最终能返回权限缺失，但等待期间大片禁用造成卡死感；宽弹窗、重复标题、左侧窄授权块及同权重长按钮未达到 DESIGN.md 的层级、渐进披露和完整状态要求。

不是未读取 DESIGN.md：此前已读取设计入口与 delivering-product-ui Skill，但未把规范转化为逐项检查的体验契约；实现复用了导入警告容器，却未审查它是否适合权限引导；真实渲染及慢请求验收被登记为债务后，仍将运行版本直接交给用户验证。记录 not-tested 是诚实披露，不能替代产品质量门槛。启动健康检查也只证明进程可用。

本轮纠正：仅关联 PAB-16，不扩大需求。主任务改为同步同花顺持仓；弹窗 720px 上限；准备状态分项展示；授权采用中性表面、横向主次操作和折叠帮助。3 秒慢检测提示，12 秒超时释放加载并支持重试，忽略旧请求迟到结果。超时只终止页面等待，不声称取消系统或后端操作；仅用于只读准备检测。已有快照在刷新时保留，退出和手动入口持续可用。

验证：47 项工作台测试通过，新增慢检测、超时重试与迟到结果回归；目标类型检查通过。当前尚未定位最初慢请求的底层根因，不能声称性能问题已根治。Computer Use 禁用约束仍保留，本轮没有操作系统权限或同花顺；多视口、深色和真实权限往返依然未验证。重启供用户继续 UAT，不标记 Done。

后续门槛：设计判断必须包含主任务、唯一主操作、慢请求/错误/禁用和退出行为；复用组件需验证语义与布局适配；真实渲染未验收时只能交付待验收版本，不能用类型检查或构建作为体验通过证据。


## 独立桌面包与发布衔接（2026-09-11）

- PAB-15 的 PR #73 已于 2026-09-11 合并，合并提交 d75e4ec4c1407e56e8cf13d19665bd9404fc463d。当前 worktree 仍以 66bcd07 为基准，包含未提交持仓与打包修复；本地候选包不等于远端 Release。
- 启动菜单新增 `bash start.sh investment-package`，复用 constraints、make:electron、内置 Python 锁文件与既有打包器。构建完成后输出应用和 ZIP，不自动启动或发布。
- 实际构建暴露并处理：Node 下载需要采用现有代理；pnpm deploy 的生产依赖状态导致后续自动重装，构建进程限定为警告、不自动清除开发依赖；Electron files 白名单补入 assets；打包版默认 investment-research；基础 bundle 从持有其依赖的 CLI 包解析；启动异常在弹窗前写日志。
- 17 项 args/main-startup/packaging 测试通过，目标类型检查通过。完整构建和 ZIP 生成已执行。图标存在已核对；内置 Python 三后端 smoke 与签名检查执行。
- 源码目录之外的独立应用启动日志记录了三个内置后端 /health 200，并正常退出。没有使用 Computer Use，没有操作券商或系统权限。初次失败的旧 ZIP 不作为可分发版本；修复后 main 使用最新 TypeScript 编译结果替换既有未变应用内容，经相同签名函数重新签名后重新生成 ZIP。
- 远端查询：Immutable Releases disabled；github-release Environment API 404；未查询到 Release workflow 历史运行。配置授权已询问，未收到答复，不修改仓库设置、不触发发布。
- 本机仅验证 darwin-arm64，Windows/macOS Intel 和正式签名/公证未验证。源码与 PR 的串行整合、版本提升、Release 门禁配置及下载后验收尚未完成，不能将 PAB-15 或 PAB-16 标记 Done。

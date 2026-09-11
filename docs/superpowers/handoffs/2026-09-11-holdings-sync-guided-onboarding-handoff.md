# 同花顺持仓同步引导与跨端自动化交接

## 交接状态

- 日期：2026-09-11
- 角色：`worktree-writer`
- 当前 worktree：`/Users/xiexin/.codex/worktrees/e539/pa-investment-research`
- 当前状态：detached `HEAD`
- 基准提交：`30a3a86cb64d4bba9d942397c7979a80d68ccdae`
- 目标特性分支：`codex/holdings-sync-guided-onboarding`
- 下一任务建议端口：`3098`，不得操作共享默认端口 `3080`
- 当前工作区已有未提交实现，必须整体继承，不得清理、重置或覆盖

## 目标

在现有“从券商同步持仓”功能上完成跨 Windows/macOS 的引导式体验：

1. 首次进入默认选择“模拟操盘”，之后记住用户上次选择。
2. 检测用户是否安装、运行并登录同花顺；未安装时引导到对应平台的官方下载页。
3. macOS 以 PyObjC/AXUIElement 为主要读取路径，只在必要时使用 AppleScript 降级。
4. 任何需要切换到同花顺前台的操作，必须先说明访问位置、可见影响和安全边界，并取得用户本次明确同意。
5. Electron 提供本机客户端启动、系统设置跳转、前台切换和返回；Web 版必须明确降级，不伪装成具备原生控制能力。
6. 读取持仓与覆盖本地持仓拆为两步：先预览，再确认替换；空结果不得清空本地数据。

## 已确认的产品决策

- 首次进入“操盘账户”默认选中“模拟操盘”。
- 模拟与真实账户使用同一同步向导，但导航目标不同：
  - 模拟：`交易 → 模拟 → 股票 → 持仓`
  - 真实：`交易 → A股 → 股票 → 持仓`
- macOS 首次只引导辅助功能授权，不同时要求自动化权限。
- AXUIElement 失败且确实进入 AppleScript 降级路径时，才追加自动化授权引导。
- 未安装同花顺不是死路，始终提供“改用手动录入/批量导入”。
- 不自动下载安装包，不接受任意 URL、应用路径或系统设置地址；所有原生动作必须使用平台允许列表。

## 用户特别强调的交互

### macOS 辅助功能授权

授权必须是独立步骤，并提供清晰的 UI 操作示例，而不是只输出一段系统路径。

建议状态卡：

```text
步骤 2/3  允许读取同花顺持仓

为了读取同花顺窗口中的持仓表格，需要授予本应用“辅助功能”权限。
我们不会读取交易密码，也不会提交买卖委托。

操作示例
① 点击“打开辅助功能设置”
② 在列表中找到“投研智能体”并开启开关
③ 返回本应用，我们会自动重新检查

[打开辅助功能设置]  [稍后处理]
```

实施要求：

- Electron：由受限主进程能力打开准确的系统设置页面；窗口重新获得焦点时自动检查一次权限。
- Web：浏览器无法可靠打开并控制 macOS 系统设置，只展示路径和“重新检查”按钮；不得声称能够自动返回或自动操作系统设置。
- 未授权时绝不执行 AX 点击、AppleScript 导航或前台切换。
- 用户返回后仍未授权，保留原说明并增加“没有看到本应用？”排障入口，不循环弹出系统提示。
- 若 AX 已授权，不再展示自动化权限。只有 AppleScript 降级实际返回 Automation/TCC 错误时，展示第二张、独立的自动化授权卡。

### 前台切换同花顺的本次确认

后台读取和后台 AX 导航失败后，先弹出确认，不得直接抢占前台：

```text
需要前往同花顺读取持仓

我们将打开同花顺并进入：
交易 → 模拟 → 股票 → 持仓

接下来会发生：
• 窗口会短暂切换到同花顺
• 系统只读取持仓表格，不会提交任何委托
• 读取完成后会返回投研智能体

[允许并继续]  [取消]
```

真实账户把路径中的“模拟”替换为“A股”。按钮授权仅限本次读取，不持久化为无限期授权。

Electron 行为：

1. 记录当前前台应用/窗口。
2. 用户点击“允许并继续”后才激活同花顺。
3. 完成导航、读取或失败收敛。
4. 在 `finally` 中尽力恢复原前台应用。
5. 回到投研智能体后展示结果或可执行错误。

Web 降级：

- 浏览器沙箱不能可靠激活同花顺，也不能保证读取后恢复浏览器焦点。
- Web 只显示路径指导：“请在同花顺进入……，完成后返回并点击读取”。
- 可以继续通过本机后端检测进程和读取已暴露表格，但不能承诺原生窗口编排。
- Web 主操作应改为“我已打开持仓页，开始读取”，而不是“允许并继续自动切换”。

### 未安装同花顺

状态驱动主操作：

- macOS：`前往官网下载 Mac 版`，官方页 `https://download.10jqka.com.cn/free/mac/`
- Windows：`前往官网下载 Windows 版`，官方页 `https://download.10jqka.com.cn/free/`
- 次操作：`已安装，重新检测`
- 退路：`暂不安装，改用手动录入`

打开下载页后，Electron/Web 窗口重新获得焦点时各自动检测一次；不要持续高频轮询。

Windows 已安装但未检测到时，提供“选择客户端位置”，只允许选择 `xiadan.exe` 或适配器明确支持的可执行文件。macOS 优先检查 `/Applications/同花顺.app` 与用户 Applications 目录。

## 建议的完整流程

```text
进入同步向导
  → 选择操盘账户（首次默认模拟）
  → 检测平台与客户端
      → 未安装：官方下载 / 手动录入
      → 已安装未运行：打开同花顺
      → 未授权：完成一次性授权引导
      → 已就绪：尝试后台读取
          → 后台成功：展示预览
          → 需要前台：弹出本次确认
              → Electron：切换、读取、返回
              → Web：人工进入目标页后再读取
  → 展示当前条数 → 新条数、账户类型、来源与读取时间
  → 用户确认替换
  → 保存快照、刷新组合风险、显示撤销或同步记录
```

## 状态模型要求

不要继续依赖前端解析中文错误字符串。扩展现有 holdings source owner，返回稳定状态码和平台动作：

- `platform`: `darwin | win32 | unsupported`
- `surface`: `electron | web`
- `installation`: `checking | missing | installed | unknown`
- `process`: `not_running | running | unknown`
- `accessibility`: `not_applicable | not_granted | granted | unknown`
- `automation`: `not_applicable | not_requested | required | granted | unknown`
- `session`: `unknown | login_required | ready`
- `readiness`: `blocked | ready | reading | preview | partial | failed`
- `blocking_reason`: 稳定枚举，不使用展示文案作为逻辑
- `available_actions`: 由后端/宿主根据平台能力给出允许列表

安装、进程、权限、账户模式、读取结果、覆盖数量与快照都属于确定性状态，不使用模型推断。

## 现有能力与改造边界

### 复用

- 操盘账户配置：`HOLDINGS_ACCOUNT_MODE`
- 数据源配置：`HOLDINGS_PROVIDER`
- `/holdings/source`、`/holdings/source/detect` 的 owner 与路由
- 本地持仓保存、组合风险刷新和持仓快照
- 单条录入、批量导入和手动模式退路
- Electron HTTP/HTTPS 外链 `shell.openExternal` 处理

### 扩展

- `holdings_source.py`：结构化 readiness 与允许动作
- `mac_ths.py`：AXUIElement 主路径、AppleScript 降级、稳定错误码
- Windows easytrader：安装/运行/权限级别/真实与模拟窗口状态
- Electron 主进程与受限桥：启动同花顺、打开系统设置、前台恢复
- `/holdings/sync`：拆分为无副作用读取预览和显式确认保存，或为现有接口增加严格的 preview token/commit 语义
- UI：状态驱动的单一主操作、授权示例、前台切换确认和 Web 降级

### 不新建平行体系

- 不新建第二套持仓 store、账户模式或数据源设置。
- 不在 UI 内硬编码平台错误判断。
- 不把 PyObjC 当成独立业务服务；它是 macOS provider 的实现细节。
- 不让前端传递任意命令、文件路径、应用名或系统设置 URI 给本机执行层。

## UI 层级与间距

同步界面只保留三个一级模块：

1. 操盘账户
2. 同花顺准备状态
3. 读取、预览与确认

模块间 `16–20px`，内部 `16px` padding；状态提示与相邻模块至少 `12px`。避免连续两层同强度完整边框。桌面检查 1440px/1024px，768px 以下改为纵向；390px 使用全屏式弹层，表格只在自身容器横向滚动。

## 当前未提交改动

当前 worktree 已包含真实/模拟账户模式、Windows/macOS 导航和 UI 间距等未提交实现。新任务必须先运行 `git status --short` 并审阅 diff，不能重做或丢弃：

```text
backend/dsh-trading-core/adapter/app.py
backend/dsh-trading-core/adapter/config.py
backend/dsh-trading-core/adapter/holdings_providers/base.py
backend/dsh-trading-core/adapter/holdings_providers/easytrader.py
backend/dsh-trading-core/adapter/holdings_providers/mac_ths.py
backend/dsh-trading-core/adapter/holdings_providers/qmt.py
backend/dsh-trading-core/adapter/holdings_source.py
backend/dsh-trading-core/adapter/portfolio_performance.py
backend/dsh-trading-core/adapter/schemas.py
backend/dsh-trading-core/docs/macOS持仓同步指南.md
backend/dsh-trading-core/docs/券商接入方案.md
backend/dsh-trading-core/tests/test_holdings_sync.py
backend/dsh-trading-core/tests/test_holdings_user_config.py
backend/dsh-trading-core/tests/test_mac_ths.py
backend/dsh-trading-core/tests/test_holdings_account_modes.py（未跟踪）
frontend/packages/client/ui-investment-research/src/client/WorkbenchOverviewDialog.tsx
frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css
frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx
frontend/.agents/notes/implemented/bug-fix/2026-09-10-holdings-provider-live-switch.*
```

## 新任务执行要求

1. 完整阅读根 `AGENTS.md`、`DESIGN.md`、`frontend/docs/web-styling.zh.md` 和 `.agents/skills/delivering-product-ui/SKILL.md`。
2. 先核对 `pwd`、Git 根目录/目录、HEAD、状态与 worktree；确认继承了上述未提交改动。
3. 使用 `existing-system-capability-audit` 复核 owner，不新增平行接口或状态。
4. 先把上述设计整理成最小实施计划，并按行为风险采用测试先行：状态码、权限分支、Electron/Web 分流、前台确认、预览/提交分离。
5. 修改范围限于上述 holdings owner、投研 runtime 映射、Electron 受限能力、对应 UI/CSS/测试与文档；发现需要扩大范围时先说明。
6. 使用端口 `3098` 做独立服务验证；不得启动、停止或杀死默认端口 `3080`。
7. 完成聚焦后端测试、目标组件测试、类型检查/构建与真实产品 UAT；至少覆盖 macOS Electron、macOS Web 降级、Windows 契约测试、浅色/深色和 1440px/1024px。
8. 不提交、不推送、不创建 PR，除非用户另行明确授权。

## 已知限制与风险

- AXUIElement 仍需要一次辅助功能授权，无法做到首次完全无感。
- PyObjC 直接运行时，macOS 可能把权限归属到 Python/宿主进程；正式发行应优先使用签名、稳定 bundle identity 的原生 helper 或 Electron 宿主能力。
- 后台 AXPress 是否完全不激活同花顺取决于客户端控件实现，不能承诺；所以必须保留前台确认与 Web 人工降级。
- 登录状态可能无法稳定预检，应在读取阶段用结构化错误收敛为 `login_required`。
- 空账户与读取失败必须区分；无法证明是合法空账户时，继续拒绝覆盖本地持仓。

## 新任务开场提示

> 角色：`worktree-writer`。请从当前工作树状态继续“同花顺持仓同步引导与跨端自动化”，完整阅读 `docs/superpowers/handoffs/2026-09-11-holdings-sync-guided-onboarding-handoff.md`、根 `AGENTS.md`、`DESIGN.md`、`frontend/docs/web-styling.zh.md` 与 `.agents/skills/delivering-product-ui/SKILL.md`。先核对 worktree、基准 `30a3a86cb64d4bba9d942397c7979a80d68ccdae` 和未提交改动，不得清理或重做。首先形成最小实施计划，然后实现：首次默认模拟操盘；未安装同花顺的官方安装引导；macOS 辅助功能 UI 操作示例；未授权先引导再继续；后台读取失败后，Electron 必须弹出“将去哪里、会发生什么、完成后返回”的本次确认，Web 明确采用人工导航降级；读取预览后再确认替换。使用端口 3098，不操作共享 3080，不提交或推送。

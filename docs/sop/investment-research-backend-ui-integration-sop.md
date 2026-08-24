# Investment Research 后端能力接入前端 SOP

- 状态：生效
- 适用 Profile：`investment-research`
- 维护范围：投研 Python 后端、Host Runtime、Client facade、投研专用 UI、Profile 组合与验收

## 1. 目的

本 SOP 用于把一个已经存在、可验证的后端能力接入 `investment-research` Profile，并交付为真实可用的前端模块。

核心原则：

- 后端接口是真源；前端不复制业务规则，不用 mock 数据掩盖接口缺失。
- 浏览器只提交稳定的 operation 和经过约束的 JSON 参数，不能提交后端地址、端口、URL 或任意路径。
- Host 负责 operation 到固定后端、固定 HTTP 方法、固定路径的映射，并负责后端租约。
- UI 继续复用正式工作区、会话、消息、附件、工具、审批和模型选择链路。
- 只有真实能力及其失败、空数据、加载状态都可验收后，才启用对应导航入口。
- 普通 `web` Profile 不得因投研模块接入发生行为或视觉变化。

交互视觉以交互稿的 `docs/design.md` 为产品基线，但它不是技术实现规范。当前主要约束是 260px 左侧导航、56px 顶栏、`#1155c4` 主色、浅灰工作台背景以及高密度卡片/表格风格。生产代码的扩展边界以本仓库现有 slot、Runtime 和 Profile 组合为准。

## 2. 当前链路和责任边界

```text
React 页面
  -> ctx.investmentResearchRuntimeClient.requestData({ operation, input })
  -> Client Remote facade
  -> Host @Remote('request-data')
  -> 固定 operation 白名单 + 参数校验
  -> investmentPythonRuntime.acquire(backendId)
  -> 固定 HTTP method/path
  -> Python backend
  -> JSON-safe response
```

当前关键代码：

| 层级 | 职责 | 文件 |
| --- | --- | --- |
| Profile | 组合通用 Web、投研 Runtime、业务插件 | `frontend/packages/boot/app-boot/src/profile.ts` |
| Bundle | 只向投研 Profile 注入 Runtime、Client 和 UI | `frontend/packages/bundle/investment-runtime/cordis.patch.yml` |
| Host 类型 | 后端 ID、operation、请求和 JSON 类型 | `frontend/packages/investment-research/python-runtime/src/types.ts` |
| Host broker | 参数白名单、固定路由、租约、HTTP 调用 | `frontend/packages/investment-research/python-runtime/src/data.ts` |
| Host Remote | 对 Client 暴露 `request-data` | `frontend/packages/investment-research/python-runtime/src/index.ts` |
| Client facade | 浏览器安全的 `requestData()` | `frontend/packages/client/investment-research-runtime/src/client/index.ts` |
| 专用 UI | 路由、页面状态、真实数据展示、会话联动 | `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx` |
| UI 装配 | slot 注册和 Runtime 注入 | `frontend/packages/client/ui-investment-research/src/client/index.ts` |
| 视觉样式 | Profile 作用域样式、响应式和动画 | `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css` |

目前已经落地的参考实现：

- “机会发现”：`market-watch.scan`、`market-watch.tech-signal`、`market-watch.news-flash`。
- “持仓分析”：`trading-core.holdings`、`trading-core.risk-portfolio`、`trading-core.risk-alerts`。

## 3. 先判断接入类型

开始编码前，负责人必须把需求归入以下一种类型。

### A. 现有后端新增读取或写入接口

例如在 `market-watch` 增加资金流接口，或在 `trading-core` 增加组合归因接口。

这是最常见、成本最低的路径。通常只需修改：

1. 后端接口及后端测试；
2. `InvestmentDataOperation`；
3. Host broker 的固定映射和参数校验；
4. broker 测试；
5. 投研 UI 和 UI 测试。

通常不需要新增 Remote 方法、Client service 或 Profile bundle。

### B. 现有后端新增模型工具

如果能力需要由模型在会话中自主调用，而不是页面主动读取，还需要在对应业务插件中注册正式工具：

- `frontend/packages/investment-research/market-watch/src/index.ts`
- `frontend/packages/investment-research/stock-analysis/src/index.ts`

页面接口与模型工具是两条消费链路，可以共享同一个 Python API，但不能用“页面请求”替代模型工具，也不能让 UI 绕过正式会话管线直接发起模型请求。

### C. 新增独立 Python 后端服务

仅在新能力确实需要独立进程、独立健康检查、独立依赖或独立生命周期时使用。除 A/B 的工作外，还必须完成后端 ID、Runtime definition、sidecar descriptor、业务插件、bundle、Profile 和打包验证。

### D. 产品实体能力，不属于投研 Python 后端

会话、工作区、文件、Goal、Workflow、审批等能力应优先接入已有 Client Runtime 或对应领域服务，不能为了方便把它们包装成 Python HTTP 接口。接入前先搜索现有 contract、service 和 slot。

## 4. 开工准入条件

后端负责人需先提供一份接口契约，至少包含：

| 项目 | 必填内容 |
| --- | --- |
| 业务目标 | 用户要完成什么任务，为什么需要独立页面或入口 |
| 后端归属 | 现有 backend ID，或新增服务的理由 |
| HTTP 契约 | method、固定 path、请求字段、响应字段、状态码 |
| 数据语义 | 单位、币种、时区、精度、枚举、空值规则、更新时间 |
| 性能 | 典型与 P95 响应时间、超时策略、是否支持取消 |
| 写操作 | 幂等性、重复提交语义、并发冲突、成功确认方式 |
| 错误 | 可重试、需配置、无权限、无数据、业务校验等错误分类 |
| 安全 | 是否涉及凭据、个人持仓、文件路径或其他敏感数据 |
| 测试入口 | curl/pytest 或等价的可重复验证方式 |

不满足以下条件时，不进入前端实现：

- `/health` 能验证服务身份，不能只返回无区分度的 200。
- 响应是 JSON，字段语义稳定，不能要求 UI 解析日志或自然语言。
- 后端不返回密钥、内部绝对路径或不必要的诊断信息。
- 写接口已说明幂等与失败语义。
- 页面所需的空数据和异常场景可被复现。

## 5. 标准接入步骤：现有后端新增接口

### 第 0 步：建立变更边界

1. 执行 `git status --short --branch`，记录已有工作树改动，不清理不属于本任务的文件。
2. 确认当前分支用途；如需要新分支，使用 `codex/` 前缀。
3. 在任务说明中列出 operation、页面入口、受影响 package 和验收门禁。
4. 确认该接口是页面读取、模型工具，还是两者都需要。

### 第 1 步：先验证后端

1. 在后端仓库实现并测试接口。
2. 用固定样例覆盖成功、空数据、非法参数、上游失败和超时。
3. 对写操作增加重复提交和并发测试。
4. 记录真实响应，不把后端样例直接复制成 UI fallback。

使用本地 JSON 状态的后端还必须遵守以下持久化规则：同一进程内，对同一规范化文件路径的所有 `JsonStore` 实例共享一把锁；依据旧值生成新值时必须通过锁内单 key `mutate` 完成读取、变换与写回，不能在调用方分离执行 `get`、修改和 `set`；写入先在目标目录创建唯一临时文件，刷新完成后通过 `os.replace` 原子提交，失败时删除临时文件；文件不存在表示尚无状态，但 JSON 损坏、编码错误或顶层不是对象必须明确失败并保留原文件，不能静默退化为空状态。整体替换接口必须区分“字段未提供”和“显式空列表”，显式空列表用于清空已有集合。

完成标准：脱离前端也能稳定复现接口结果。

### 第 2 步：增加稳定 operation

在 `frontend/packages/investment-research/python-runtime/src/types.ts` 的 `InvestmentDataOperation` 中增加名称：

```ts
export type InvestmentDataOperation =
  | 'market-watch.capital-flow'
  // ...existing operations
```

命名规则：

- 格式为 `<backend-id>.<business-action>`。
- 名称表达业务能力，不暴露 HTTP 路径。
- operation 发布后视为兼容性 contract；后端改路径时不改 operation。
- 不使用 `request`、`proxy`、`fetch-url` 等泛化名称。

### 第 3 步：在 Host broker 建立固定映射

在 `frontend/packages/investment-research/python-runtime/src/data.ts` 的 `SPECS` 中增加 `RequestSpec`：

```ts
'market-watch.capital-flow': {
  backendId: 'market-watch',
  method: 'GET',
  path: (input) => {
    knownKeys(input, ['code', 'days'])
    return query('/capital-flow', {
      code: stringValue(input, 'code'),
      days: integer(input, 'days', 20, 1, 120),
    })
  },
},
```

必须遵守：

- 所有 input key 都通过 `knownKeys()` 明确列出，未知字段在获取租约前拒绝。
- 字符串、数字、布尔值使用现有校验 helper；有业务枚举时再做闭集校验。
- 数字必须设置合理的最小值、最大值和默认值。
- 路径、method、backend ID 在 Host 固定，浏览器不能控制。
- URL query 使用 `URLSearchParams`，不能手工拼接用户输入。
- 写入 body 只重建允许字段，不能把整个 `input` 原样透传。
- 请求完成或失败后都必须释放 lease；沿用 `requestInvestmentData()` 的 `finally`。
- 上游错误只返回有界详情，不能无限转发响应体。

当前 broker 是一个小型显式白名单。除非 operation 数量和团队边界已明显失控，不要提前改造成任意路由代理或动态注册系统。

### 第 4 步：补 Host contract 测试

在 `frontend/packages/investment-research/python-runtime/tests/data.spec.ts` 至少覆盖：

1. 正确 backend ID、method、URL 和 body/query；
2. 默认值和上下界；
3. 未知字段或非法类型在 `acquire()` 前失败；
4. HTTP 非 2xx 时抛出可诊断错误；
5. 成功和失败都释放 lease；
6. 写操作不会透传额外字段。

如果修改 Remote contract，还要更新：

- `frontend/packages/investment-research/python-runtime/tests/remote.spec.ts`
- `frontend/packages/client/investment-research-runtime/tests/apply.client.spec.ts`
- 相关生成 Remote 的产物和类型检查。

仅增加 `InvestmentDataOperation` 时，现有通用 `requestData()` facade 通常无需新增方法。

### 第 5 步：设计页面数据模型

UI 实现前先写清楚：

- 页面主任务和用户决策点；
- 首屏最重要的信息；
- 筛选、排序、选择和刷新逻辑；
- 加载、空、错误、陈旧数据和局部失败状态；
- 数据单位、涨跌颜色、时间和精度；
- 是否需要“在智能助手中分析”，以及预填的提示词内容；
- 响应式布局和键盘操作。

页面可以对 JSON 做容错读取，但不能在浏览器复制选股、风险计算、归因等后端业务规则。新增复杂页面时，应为响应建立局部 TypeScript view model 和显式解析函数；不要让 `unknown` 和散落的字段猜测扩散到整个组件。

### 第 6 步：接入投研专用 UI

优先在 `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx` 中增加页面组件，并通过已注入的 `requestData` 调用：

```ts
requestData({
  operation: 'market-watch.capital-flow',
  input: { code, days: 20 },
})
```

UI 状态最低要求：

- 初次加载显示与页面结构相符的 loading/skeleton，不显示假数据。
- 错误态保留用户筛选条件，并提供明确的重试操作。
- 空数据不是错误，要解释当前没有结果以及用户下一步可做什么。
- 刷新期间防止重复触发；写操作必须有 pending、成功和失败反馈。
- 慢请求要立即给出可见反馈，不能让用户误以为点击无效。
- 组件卸载或参数变化后，旧请求结果不能覆盖新页面状态。
- 可以并行的独立请求使用并行加载；局部接口失败不会破坏其余区域时，使用局部错误态。
- 不因接口失败回退到 mock、`localStorage` 或静态演示数据。

“在智能助手中分析”必须调用现有 `prepareAssistant()`：切回共享会话页并预填输入框，由用户确认后再发送。页面自身不能绕开模型选择、附件、审批和发送策略。

### 第 7 步：接入导航和状态

需要新一级页面时：

1. 更新 `frontend/packages/client/ui-investment-research/src/client/state.ts` 的 `InvestmentRoute`。
2. 更新 `InvestmentShell.tsx` 中的 `ROUTES`、图标和页面分支。
3. 只有页面已连接真实接口且通过验收，才移除 disabled/“规划”状态。
4. 继续复用专用侧栏和共享壳层，不复制一套新的工作区、设置或会话逻辑。
5. 页面切换时保留合理的筛选或选中状态；不要用绝对定位让顶栏搜索和操作按钮互相遮挡。

样式写入 `InvestmentShell.module.css`，并保持在 `body[data-investment-research-ui]` 或 CSS Module 作用域内。主要交互需覆盖 hover、focus-visible、disabled、pending、enter/exit 动画以及 `prefers-reduced-motion`。

### 第 8 步：补 UI 测试

至少覆盖：

- operation 和参数正确传到 `requestData()`；
- loading、成功、空数据、失败、重试；
- 快速切换筛选时不提交过期结果；
- 写操作的防重复提交与结果反馈；
- 导航只在真实能力完成后启用；
- “在智能助手中分析”只预填、不自动发送；
- 关键按钮的可访问名称、键盘焦点和移动端行为。

现有装配测试位于 `frontend/packages/client/ui-investment-research/tests/apply.client.spec.ts`，路由状态测试位于 `frontend/packages/client/ui-investment-research/tests/state.client.spec.ts`。复杂页面建议拆出独立组件和独立测试文件，不要持续扩大单个壳层测试。

### 第 9 步：更新文档

至少更新：

- `frontend/packages/client/ui-investment-research/README.md`：新增真实页面、operation 和已知限制。
- `frontend/packages/client/investment-research-runtime/README.zh.md`：只有 facade contract 发生变化时更新。
- 后端 API 文档：字段语义、错误和版本兼容性。
- 本 SOP：只有流程或架构扩展点发生变化时更新。

## 6. 完整接入步骤：新增独立 Python 后端

新增后端除执行第 5 节外，还要完成以下工作。

### 6.1 扩展 Runtime 类型闭集

在 `python-runtime/src/types.ts`：

- 扩展 `InvestmentBackendId`；
- 如新服务使用不同模块入口，扩展 `PythonBackendDefinition['module']`；
- 定义其 credential 与 capability 关系；
- 为页面接口增加稳定 operation。

检查所有以 `Record<InvestmentBackendId, ...>` 建模的代码和测试。后端 ID 是有意闭合的安全边界，不能仅用 `string` 绕过类型错误。

### 6.2 建立业务插件和生命周期

参考 `investment-research/market-watch` 或 `investment-research/stock-analysis` 新建 TypeScript package。插件必须：

1. 定义 `Config`：managed/external、固定默认 base URL、可选绝对 project dir；
2. 通过 `ctx.investmentPythonRuntime.register(definition)` 注册后端；
3. 获取 lease 后再注册工具或能力；
4. 通过 `registerCapability()` 发布 tool 数量和 LLM 关系；
5. 在异常和 dispose 时按“工具/能力 → lease → register”逆序释放；
6. 在每个业务操作前调用 `assertCapability()`；
7. 不在浏览器或工具实现中自行管理 Python 子进程。

健康检查必须校验服务身份字段。默认端口不得与现有 `8000`、`8100` 等服务冲突。

### 6.3 扩展源码与打包资源解析

新增服务需要同步检查并更新：

- `frontend/packages/investment-research/python-runtime/src/descriptor.ts`
- `frontend/packages/investment-research/python-runtime/src/path.ts`
- `frontend/scripts/build-investment-python-sidecar.ts`
- `frontend/scripts/investment-python.ts`
- sidecar、path、descriptor、readiness、runtime 相关测试

打包 descriptor 必须继续是固定、完整、带 SHA-256 的闭集。新增 backend 目录、模块和文件后要重新生成/验证 descriptor，不能让运行时从未校验的任意目录加载代码。

### 6.4 新增 bundle 并组合到 Profile

参考以下 package：

- `frontend/packages/bundle/investment-market-watch`
- `frontend/packages/bundle/investment-stock-analysis`

创建业务 bundle 后：

1. 在 bundle 的 `cordis.patch.yml` 插入业务插件；
2. 补 bundle manifest 和测试；
3. 把 bundle 加入 `PROFILE_TEMPLATES['investment-research']`；
4. 确认 `web` 和 `headless` Profile 未注入该插件；
5. 确认首次初始化和已存在 Profile 的升级/patch 行为。

### 6.5 更新就绪与设置页面

新增后端必须出现在 `InvestmentReadinessSnapshot.backends` 中，并由投研设置页展示：

- ownership；
- backend status；
- credential status；
- capability status 和 tool count；
- restart required；
- runtime log path。

不得把凭据值、后端内部环境变量或敏感路径传给浏览器。对用户展示的修复指引必须可执行，并区分源码环境与 bundled sidecar。

## 7. 安全审查清单

合并前逐项确认：

- [ ] 浏览器不能传 `baseUrl`、port、path、method 或任意 URL。
- [ ] operation 是闭集，Host 中每项都有固定 backend 和 route。
- [ ] input 拒绝未知 key、错误类型、越界数字和非法枚举。
- [ ] 写请求只重建允许字段，不整包透传 input。
- [ ] 非 2xx 响应详情有长度上限，错误中无密钥。
- [ ] 成功、失败和取消路径都释放 backend lease。
- [ ] Client snapshot 和 response 不包含凭据值。
- [ ] managed child 的凭据只由 Host credential service 注入。
- [ ] Profile 外的通用 Web UI 无法访问投研 facade。
- [ ] sidecar 文件和 descriptor 仍经过完整性校验。

## 8. UI/UX 验收清单

### 信息与任务

- [ ] 页面标题、描述和首屏结构能解释该模块解决的问题。
- [ ] 关键信息优先级清晰，不把所有卡片做成相同视觉权重。
- [ ] 单位、时间、来源、精度和正负值表达一致。
- [ ] 无真实能力的入口保持 disabled/规划态，不打开空白页。

### 交互状态

- [ ] 初次加载、刷新、局部加载、空数据、错误和成功均有状态。
- [ ] 慢接口点击后立即反馈，按钮防重复触发。
- [ ] 错误态可重试，且不会丢失用户输入和筛选条件。
- [ ] 页面或筛选变化后，过期响应不会覆盖新状态。
- [ ] 写操作有确认语义；高风险或不可逆操作需二次确认。
- [ ] 进入和退出动画完整，并支持 reduced motion。

### 布局与可访问性

- [ ] 符合交互稿的 260px 侧栏、56px 顶栏、`#1155c4` 主色和技术型高密度风格。
- [ ] 顶部搜索和右侧操作使用 grid/flex 正常流，窄屏不遮挡。
- [ ] 760px、620px 等窄视口下无横向溢出和抽屉遮挡问题。
- [ ] 可交互元素有 hover、focus-visible、disabled 和 pending 状态。
- [ ] 图标按钮有可访问名称，弹窗/抽屉支持 `Escape` 和焦点管理。
- [ ] 颜色不是表达涨跌、风险或选中状态的唯一方式。

### 正式链路

- [ ] 页面使用真实后端数据，无 mock fallback 或 `localStorage` 业务数据。
- [ ] “在智能助手中分析”进入共享会话并预填，不自动发送。
- [ ] 会话、附件、审批、工具结果和模型选择能力无回归。
- [ ] 通用 `web` Profile 无视觉和行为回归。

## 9. 验证命令和顺序

以下命令从 `frontend` 目录执行。先跑定向门禁，再跑扩大门禁。

### 9.1 后端和 Runtime 定向测试

```bash
pnpm exec vitest run \
  packages/investment-research/python-runtime/tests/data.spec.ts \
  packages/investment-research/python-runtime/tests/remote.spec.ts \
  packages/client/investment-research-runtime/tests/apply.client.spec.ts
```

新增独立后端时还要运行其插件测试、Runtime lifecycle/readiness/path/descriptor 测试，并执行：

```bash
pnpm run investment:python:verify
```

需要初始化后端环境时才执行：

```bash
pnpm run investment:python:init
```

`init` 会修改 Python 环境，不能把它当作普通只读检查。

### 9.2 UI 定向测试

```bash
pnpm exec vitest run \
  packages/client/ui-investment-research/tests/apply.client.spec.ts \
  packages/client/ui-investment-research/tests/state.client.spec.ts
```

### 9.3 类型、lint 和构建

```bash
pnpm exec tsc -b tsconfig.client.json
pnpm exec tsx scripts/run-oxlint.ts \
  packages/investment-research/python-runtime \
  packages/client/investment-research-runtime \
  packages/client/ui-investment-research
pnpm run build:lib:client
```

涉及 Host、业务插件、bundle 或 sidecar 时，再运行对应 Host build、bundle 测试和仓库 CI gate。最后执行：

```bash
git diff --check
```

### 9.4 Web 联调

优先使用 Web Profile 验收，不要求 Electron 才能验证：

```bash
node apps/cli/lib/bin.js \
  --profile investment-research \
  --host 127.0.0.1 \
  --port 8090
```

访问 `http://127.0.0.1:8090/`，至少验证：

1. 后端健康与页面首屏；
2. 成功、空数据、错误、重试和慢请求反馈；
3. 筛选、刷新、选择、写入和防重复操作；
4. 页面到智能助手的预填联动；
5. 侧栏收起/展开、顶部搜索、历史抽屉；
6. 1440px、1024px、760px、620px 视口；
7. 键盘焦点、`Escape` 和 reduced motion；
8. 浏览器控制台无新增错误。

Electron 只在改动 Electron 壳、sidecar 打包、原生模块或启动/停止脚本时作为额外门禁。

## 10. 故障定位顺序

### 页面报“连接后端失败”

1. 在投研设置页检查 backend status、ownership、credential 和 log path。
2. 直接验证后端 `/health` 身份和业务接口。
3. 检查 operation 是否映射到正确 backend ID、method 和 path。
4. 检查 Host 日志，而不是在浏览器暴露 base URL 后直接绕过 broker。
5. 确认 lease 在失败后释放，服务没有被旧进程或错误端口占用。

### 页面一直 loading

1. 检查请求是否 settle；
2. 检查 effect cleanup、参数依赖和过期响应保护；
3. 检查 loading 是否在 success/error 两条路径都结束；
4. 测量真实接口耗时，超过产品阈值时先优化后端或拆分接口；
5. 即使暂时无法降低延迟，也必须提供即时 pending 和局部进度反馈。

### 数据显示不正确

1. 对比原始 JSON 与接口契约；
2. 检查单位、百分比、时间和空值转换；
3. 业务计算优先在后端修复，前端只做展示格式化；
4. 为出现过的边界响应补 contract fixture 和 UI 测试。

### 开发环境可用但打包不可用

1. 检查 sidecar descriptor 是否包含新 backend 和完整文件哈希；
2. 检查 backend module、projectDir、site-packages 和平台解释器；
3. 检查业务 bundle 是否进入 `investment-research` Profile；
4. 运行 sidecar smoke 和 packaged Profile E2E；
5. 不用本机已有 Python 环境掩盖 bundled asset 缺失。

## 11. Definition of Done

一个新后端能力只有同时满足以下条件才算完成：

- 后端契约稳定并有可重复测试；
- Host operation 白名单和输入校验完成；
- 安全边界审查通过；
- UI 使用真实数据，覆盖完整状态和交互；
- 导航、会话与智能助手联动符合交互稿；
- TypeScript、lint、定向测试和构建通过；
- Web 真实 Profile 完成桌面、窄屏和键盘验收；
- 新独立后端通过 Runtime、bundle、sidecar 和打包验证；
- README 与本次能力限制已更新；
- 没有把演示数据、动态 URL、后端规则副本或 Profile 外样式带入生产代码。

## 12. PR 交付模板

```markdown
## 接入能力

- backend：
- operation：
- UI 入口：
- 是否包含模型工具：

## 契约与安全

- 固定 method/path：
- input 白名单：
- 凭据与敏感数据处理：
- 写操作幂等/确认语义：

## UI/UX

- loading / empty / error / retry：
- 慢请求反馈：
- 响应式与键盘：
- 与智能助手联动：

## 验证

- 后端测试：
- Runtime/Remote 测试：
- UI 测试：
- 类型/lint/build：
- Web 实机验收：
- Electron/sidecar（如适用）：

## 已知限制

-
```

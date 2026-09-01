# 聊天式「我的投研」实施计划

> **面向智能体执行者：** 必须使用 `superpowers:executing-plans` 逐任务执行，并使用 `superpowers:test-driven-development` 完成测试先行循环。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 把「我的投研」改造成共享对话主界面，在输入框底部提供会话级策略和 A 股/场内 ETF 标的选择，并保留按需展开的原投研资料能力。

**架构：** 浏览器选择器通过固定数据操作把策略 ID 与标的展示元数据保存到交易后端的会话上下文；模型通过无参数只读工具按 `exec.agent.session.header.id` 读取上下文和最新策略事实。`portfolio` 路由只切换共享对话的展示模式，不复制 Conversation；原 `PortfolioPage` 复用为按需资料抽屉。

**技术栈：** Python 3、FastAPI、Pydantic、`JsonStore`、`unittest`；TypeScript、React 18、Cordis、Schemastery、Vitest、Testing Library、CSS Modules；Electron 投研 Profile。

**规格：**

- [需求文档](../../prd/0.1.0-rc.9/02-功能需求/01-聊天式我的投研.md)
- [设计文档](../../design/0.1.0-rc.9/01-聊天式我的投研.md)

## 全局约束

- 新增和更新的 Markdown 正文使用中文；代码标识符、命令和 API 名称保留原文。
- 前端代码使用 TypeScript，后端代码使用 Python。
- 不复制共享对话，不修改通用发送协议来承载任意业务元数据。
- 策略和标的不得拼入用户可见正文，也不得显示业务 JSON。
- 所有策略均可讨论；只有 `status=active && verification_status=passed` 为推荐。
- 聊天只读，不执行策略、不变更策略状态、不发起交易。
- 首期标的仅支持 A 股和场内 ETF，每个会话最多一个策略和一个主要标的。
- 会话上下文读写只允许固定操作，并在外部后端模式下拒绝。
- 不覆盖、暂存、提交或清理无关改动。用户尚未授权 commit、push 或 PR，因此每个任务以差异检查代替提交；如后续获得授权，AI 提交信息必须以 `[AI] ` 开头。
- 完成声明前必须使用 `superpowers:verification-before-completion`，并以实际命令输出为依据。

---

## 文件结构

### 后端

- 新建 `backend/dsh-trading-core/adapter/research_chat_context.py`：会话上下文读取、修订比较与原子保存。
- 修改 `backend/dsh-trading-core/adapter/schemas.py`：严格请求模型与标的模型。
- 修改 `backend/dsh-trading-core/adapter/app.py`：GET/POST 固定路由与错误映射。
- 新建 `backend/dsh-trading-core/tests/test_research_chat_context.py`：领域逻辑和 HTTP 契约测试。

### 浏览器运行时

- 修改 `frontend/packages/investment-research/python-runtime/src/types.ts`：新增两个操作名。
- 修改 `frontend/packages/investment-research/python-runtime/src/data.ts`：固定方法、路径、请求体和 `localOnly`。
- 修改 `frontend/packages/investment-research/python-runtime/tests/data.spec.ts`：操作、校验、外部后端拒绝测试。

### 模型工具

- 新建 `frontend/packages/investment-research/stock-analysis/src/research-context.ts`：上下文结果解析、推荐与适用性计算。
- 修改 `frontend/packages/investment-research/stock-analysis/src/client.ts`：读取会话上下文与策略详情。
- 修改 `frontend/packages/investment-research/stock-analysis/src/index.ts`：注册 `investment_research_context` 和系统提示。
- 修改 `frontend/packages/investment-research/stock-analysis/package.json`、`tsconfig.json`：声明 `systemPrompt` 运行时依赖与工程引用。
- 新建 `frontend/packages/investment-research/stock-analysis/tests/research-context.spec.ts`：纯逻辑测试。
- 修改 `frontend/packages/investment-research/stock-analysis/tests/client.spec.ts`、`plugin.spec.ts`、`runtime-composition.spec.ts`、`loader-composition.spec.ts`：HTTP 与插件组合回归。

### 客户端与界面

- 新建 `frontend/packages/client/ui-investment-research/src/client/research-chat-context.ts`：类型、响应解析和会话级控制器。
- 新建 `frontend/packages/client/ui-investment-research/src/client/ResearchContextControls.tsx`：策略、标的选择器和键盘交互。
- 修改 `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`：聊天主界面、顶部会话入口和资料抽屉。
- 修改 `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`：主对话模式、选择器、抽屉、主题与窄屏样式。
- 修改 `frontend/packages/client/ui-investment-research/src/client/index.ts`：创建控制器并注入输入框控件。
- 新建 `frontend/packages/client/ui-investment-research/tests/research-chat-context.client.spec.ts`：控制器并发与隔离测试。
- 新建 `frontend/packages/client/ui-investment-research/tests/research-context-controls.client.spec.tsx`：选择器组件测试。
- 修改 `frontend/packages/client/ui-investment-research/tests/apply.client.spec.ts`、`analysis-assistant-regression.client.spec.tsx`、`theme-styles.client.spec.ts`：注册、路由和样式回归。

---

### 任务 1：交易后端会话上下文

**文件：**

- 新建：`backend/dsh-trading-core/adapter/research_chat_context.py`
- 修改：`backend/dsh-trading-core/adapter/schemas.py`
- 修改：`backend/dsh-trading-core/adapter/app.py`
- 测试：`backend/dsh-trading-core/tests/test_research_chat_context.py`

**接口：**

- 产出：`ResearchChatInstrument`、`ResearchChatContextSaveRequest`。
- 产出：`get_research_chat_context(store, session_id)`。
- 产出：`save_research_chat_context(store, session_id, request)`。
- 产出：`ResearchChatRevisionConflict(current_revision)`。
- 产出：`GET /research-chat/contexts/{session_id}` 与 `POST /research-chat/contexts/{session_id}`。

- [x] **步骤 1：先写领域与 HTTP 失败测试**

```python
def test_save_uses_revision_and_preserves_empty_tombstone(self):
    saved = save_research_chat_context(self.store, "session-1", request(0, "strategy-1", stock()))
    self.assertEqual(saved["revision"], 1)
    cleared = save_research_chat_context(self.store, "session-1", request(1, None, None))
    self.assertEqual(cleared["revision"], 2)
    with self.assertRaises(ResearchChatRevisionConflict):
        save_research_chat_context(self.store, "session-1", request(0, "strategy-1", None))

def test_http_returns_empty_conflict_and_missing_strategy(self):
    self.assertEqual(client.get("/research-chat/contexts/new-session").json(), {
        "exists": False, "context": None,
    })
    self.assertEqual(client.post("/research-chat/contexts/new-session", json=valid_body).status_code, 200)
    self.assertEqual(client.post("/research-chat/contexts/new-session", json=stale_body).status_code, 409)
    self.assertEqual(client.post("/research-chat/contexts/other", json=missing_strategy_body).status_code, 404)
```

- [x] **步骤 2：运行测试并确认 RED**

运行：

```bash
cd backend/dsh-trading-core
python -m unittest tests.test_research_chat_context -v
```

预期：因模块、请求模型和路由不存在而失败，不接受导入或断言意外通过。

- [x] **步骤 3：实现严格模型和领域逻辑**

```python
class ResearchChatInstrument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    code: str = Field(pattern=r"^\d{6}$")
    name: str = Field(min_length=1, max_length=80)
    market: str = Field(min_length=1, max_length=32)
    type: Literal["stock", "etf"]

class ResearchChatContextSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: int = Field(ge=0)
    strategy_id: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")
    instrument: Optional[ResearchChatInstrument] = None
```

`save_research_chat_context` 必须在 `store.mutate("research_chat_contexts", session_id, transform, None)` 中比较修订号、生成 UTC ISO 时间并写完整目标状态。保存策略前使用 `store.get("strategies", strategy_id)` 验证存在；空状态也保留记录。

- [x] **步骤 4：注册 GET/POST 路由并映射错误**

```python
@app.get("/research-chat/contexts/{session_id}", response_model=dict)
async def research_chat_context_get(
    session_id: str = ApiPath(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    ),
):
    context = get_research_chat_context(JsonStore(), session_id)
    return {"exists": context is not None, "context": context}

@app.post("/research-chat/contexts/{session_id}", response_model=dict)
async def research_chat_context_save(session_id: str, req: ResearchChatContextSaveRequest):
    try:
        return save_research_chat_context(JsonStore(), session_id, req)
    except ResearchChatRevisionConflict as exc:
        raise HTTPException(status_code=409, detail={"code": "revision_conflict", "current_revision": exc.current_revision}) from exc
```

策略缺失映射 404，非法请求由 Pydantic 映射 422；不得把存储损坏转换成正常空状态。

- [x] **步骤 5：运行任务测试及策略回归**

```bash
cd backend/dsh-trading-core
python -m unittest tests.test_research_chat_context tests.test_strategy_verification -v
```

预期：全部通过。

- [x] **步骤 6：检查任务差异，不提交**

```bash
git diff --check -- backend/dsh-trading-core/adapter backend/dsh-trading-core/tests/test_research_chat_context.py
git status --short
```

---

### 任务 2：浏览器固定数据操作

**文件：**

- 修改：`frontend/packages/investment-research/python-runtime/src/types.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/data.ts`
- 修改：`frontend/packages/investment-research/python-runtime/tests/data.spec.ts`

**接口：**

- 消费：任务 1 的 GET/POST 路由。
- 产出：`trading-core.research-chat-context`。
- 产出：`trading-core.research-chat-context-save`。

- [x] **步骤 1：写固定 URL、请求体与安全失败测试**

```ts
await requestInvestmentData({
  operation: 'trading-core.research-chat-context',
  input: { session_id: 'session-1' },
}, acquire)
await requestInvestmentData({
  operation: 'trading-core.research-chat-context-save',
  input: {
    session_id: 'session-1', expected_revision: 2, strategy_id: 'strategy-1',
    instrument: { code: '510300', name: '沪深300ETF', market: '沪市 ETF', type: 'etf' },
  },
}, acquire)
expect(fetchMock).toHaveBeenNthCalledWith(1, `${BASE}/research-chat/contexts/session-1`, { method: 'GET' })
```

同时断言未知键、非法会话 ID、非六位代码、非法类型和 `ownership='external'` 均在安全边界失败。

- [x] **步骤 2：运行运行时测试并确认 RED**

```bash
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts
```

预期：操作名尚未进入联合类型或 `SPECS`，测试失败。

- [x] **步骤 3：实现操作类型和请求体校验**

在 `InvestmentDataOperation` 增加两个字面量。为上下文保存新增窄校验器：

```ts
function researchInstrument(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  // 只接受 null 或具有 code/name/market/type 的普通对象；拒绝未知键。
}
```

两个 `SPECS` 均设置 `backendId: 'trading-core'`、`localOnly: true`；保存操作只序列化明确允许的字段。

- [x] **步骤 4：运行测试并确认 GREEN**

```bash
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts
```

预期：全部通过。

- [x] **步骤 5：检查任务差异，不提交**

```bash
git diff --check -- frontend/packages/investment-research/python-runtime
git status --short
```

---

### 任务 3：当前会话投研上下文模型工具

**文件：**

- 新建：`frontend/packages/investment-research/stock-analysis/src/research-context.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/src/client.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/src/index.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/package.json`
- 修改：`frontend/packages/investment-research/stock-analysis/tsconfig.json`
- 新建：`frontend/packages/investment-research/stock-analysis/tests/research-context.spec.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/tests/client.spec.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/tests/runtime-composition.spec.ts`
- 修改：`frontend/packages/investment-research/stock-analysis/tests/loader-composition.spec.ts`

**接口：**

- 消费：任务 1 的上下文和策略详情路由。
- 产出：`getResearchChatContext(baseUrl, sessionId, signal)`。
- 产出：`resolveResearchContext(input)` 纯投影函数。
- 产出：`resolveInvestmentResearchContext(baseUrl, sessionId, signal)`。
- 产出：工具 `investment_research_context()`。
- 产出：`INVESTMENT_RESEARCH_CONTEXT_PROMPT`。

- [x] **步骤 1：写 HTTP 与纯逻辑失败测试**

```ts
expect(await resolveResearchContext({
  context: { strategy_id: 's1', instrument: stock('600519'), revision: 3 },
  strategy: { id: 's1', status: 'active', verification_status: 'passed', symbols: ['600519'] },
})).toMatchObject({ recommended: true, compatibility: 'direct', warnings: [] })

expect(resolveResearchContext({
  context: { strategy_id: 's1', instrument: etf('510300'), revision: 3 },
  strategy: { id: 's1', status: 'candidate', verification_status: 'pending', symbols: ['600519'] },
})).toMatchObject({
  recommended: false,
  compatibility: 'method_only',
  warnings: expect.arrayContaining([
    expect.objectContaining({ code: 'STRATEGY_NOT_RECOMMENDED' }),
    expect.objectContaining({ code: 'METHOD_TRANSFER' }),
  ]),
})
```

客户端测试固定 URL 编码和 abort signal；插件测试固定工具无参数、从 `exec.agent.session.header.id` 取 ID、无 Agent 返回 `unavailable`。

- [x] **步骤 2：运行工具包测试并确认 RED**

```bash
cd frontend
pnpm exec vitest run packages/investment-research/stock-analysis/tests/client.spec.ts packages/investment-research/stock-analysis/tests/research-context.spec.ts packages/investment-research/stock-analysis/tests/plugin.spec.ts
```

- [x] **步骤 3：实现上下文解析、推荐和适用性**

`research-context.ts` 返回稳定联合状态：

```ts
export type InvestmentResearchContextResult = Readonly<{
  status: 'ready' | 'empty' | 'invalid' | 'unavailable'
  context_revision?: number
  context_updated_at?: string
  strategy?: Readonly<Record<string, unknown>>
  instrument?: ResearchChatInstrument
  recommended?: boolean
  compatibility?: 'direct' | 'method_only' | 'not_applicable'
  warnings: readonly ResearchContextWarning[]
}>
```

命中 `strategy.symbols` 或 `strategy.tickers` 才返回 `direct`；其他受支持标的返回 `method_only`。策略 404 转为 `invalid/STRATEGY_NOT_FOUND`，其他后端失败转为 `unavailable`，不得伪装为空。

- [x] **步骤 4：注册工具与系统提示**

```ts
export const inject = ['tools', 'agents', 'investmentPythonRuntime', 'systemPrompt']

ctx.systemPrompt.section({
  name: 'tool:investment-research-context',
  order: 111,
  text: INVESTMENT_RESEARCH_CONTEXT_PROMPT,
})

defineTool({
  name: 'investment_research_context',
  description: '读取当前会话在输入框工具栏中确认的策略和投资标的。无参数、只读。',
  parameters: {},
  async execute(_args, exec) {
    const sessionId = exec.agent?.session.header.id
    if (sessionId === undefined) return unavailableResult()
    return resolveInvestmentResearchContext(resolvedConfig.adapterBaseUrl, String(sessionId), exec.signal)
  },
})
```

补齐 `@deepseek-ai/dsh-system-prompt` peer、dev 和 tsconfig reference；更新组合测试期望工具清单、注册顺序和销毁顺序。

- [x] **步骤 5：运行工具包完整测试**

```bash
cd frontend
pnpm exec vitest run packages/investment-research/stock-analysis/tests
```

预期：全部通过，现有 `investment_context` 与分析工具无回归。

- [x] **步骤 6：检查任务差异，不提交**

```bash
git diff --check -- frontend/packages/investment-research/stock-analysis
git status --short
```

---

### 任务 4：会话控制器与输入框策略/标的选择器

**文件：**

- 新建：`frontend/packages/client/ui-investment-research/src/client/research-chat-context.ts`
- 新建：`frontend/packages/client/ui-investment-research/src/client/ResearchContextControls.tsx`
- 新建：`frontend/packages/client/ui-investment-research/tests/research-chat-context.client.spec.ts`
- 新建：`frontend/packages/client/ui-investment-research/tests/research-context-controls.client.spec.tsx`

**接口：**

- 消费：任务 2 的两个固定操作及现有策略、证券搜索操作。
- 产出：`ResearchChatContextController`。
- 产出：`InvestmentComposerContextControls`。
- 产出：`ResearchChatContextEntry`、`ResearchChatContext`、`ResearchChatInstrument`。

- [x] **步骤 1：写控制器会话隔离和乱序失败测试**

```ts
const controller = new ResearchChatContextController(requestData)
await controller.load('session-a')
await controller.save('session-a', { strategy_id: 'strategy-a', instrument: null })
await controller.load('session-b')
expect(controller.snapshot('session-a').confirmed?.strategy_id).toBe('strategy-a')
expect(controller.snapshot('session-b').confirmed).toBeNull()

resolveOlderLoadAfterNewerLoad()
expect(controller.snapshot('session-a').confirmed?.revision).toBe(2)
```

另测保存失败保留旧确认值、409 后重新加载、释放后不通知，以及空响应解析。

- [x] **步骤 2：运行控制器测试并确认 RED**

```bash
cd frontend
pnpm exec vitest run packages/client/ui-investment-research/tests/research-chat-context.client.spec.ts
```

- [x] **步骤 3：实现控制器最小 GREEN**

控制器以 `Map<SessionId, EntryStore>` 保存状态，提供：

```ts
load(sessionId: string, options?: { refresh?: boolean }): Promise<void>
save(sessionId: string, target: ResearchChatContextTarget): Promise<void>
subscribe(sessionId: string, listener: () => void): () => void
snapshot(sessionId: string): ResearchChatContextEntry
dispose(): void
```

首次空上下文在客户端表示 `confirmed=null, revision=0`；保存使用完整目标状态和确认修订号，响应代次不匹配时丢弃。

- [x] **步骤 4：写选择器组件失败测试**

```tsx
renderControls({ route: 'portfolio', sessionId: 'session-a' })
fireEvent.click(screen.getByRole('button', { name: /策略，当前：未选择/ }))
expect(await screen.findByText('推荐策略')).toBeTruthy()
expect(screen.getByText('其他策略')).toBeTruthy()
fireEvent.click(screen.getByRole('option', { name: /候选策略/ }))
await waitFor(() => expect(screen.getByRole('button', { name: /候选策略.*候选.*待验证/ })).toBeTruthy())

fireEvent.click(screen.getByRole('button', { name: /标的，当前：未选择/ }))
fireEvent.change(screen.getByRole('combobox', { name: '搜索 A 股或场内 ETF' }), { target: { value: '沪深300' } })
expect(await screen.findByRole('option', { name: /沪深300ETF.*510300.*ETF/ })).toBeTruthy()
```

另测：非 `portfolio` 路由保留固定模块选择器；保存失败不更新芯片；生成中禁用；Escape 与键盘选择；旧搜索响应被忽略。

- [x] **步骤 5：实现策略与标的控件**

- 从 `PropsRuntime<'conversation.input.left'>` 读取 `session.sessionId` 和输入运行状态。
- 策略浮层打开时请求 `trading-core.strategies`、`limit: 200`，解析全部状态并分组。
- 标的输入延迟 180ms 请求 `market-watch.security-search`，保留 `type` 字段。
- 选择、清除均通过控制器保存；确认前不更新芯片。
- 风险状态使用文字和 `aria-label`；ETF 显示能力说明。
- 组件只在「我的投研」显示动态控件；其他路由复用现有固定模块菜单。

- [x] **步骤 6：运行两个新增客户端测试**

```bash
cd frontend
pnpm exec vitest run packages/client/ui-investment-research/tests/research-chat-context.client.spec.ts packages/client/ui-investment-research/tests/research-context-controls.client.spec.tsx
```

- [x] **步骤 7：检查任务差异，不提交**

```bash
git diff --check -- frontend/packages/client/ui-investment-research/src/client/research-chat-context.ts frontend/packages/client/ui-investment-research/src/client/ResearchContextControls.tsx frontend/packages/client/ui-investment-research/tests
git status --short
```

---

### 任务 5：聊天主界面、会话入口与投研资料抽屉

**文件：**

- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 修改：`frontend/packages/client/ui-investment-research/src/client/index.ts`
- 修改：`frontend/packages/client/ui-investment-research/tests/apply.client.spec.ts`
- 修改：`frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx`
- 修改：`frontend/packages/client/ui-investment-research/tests/theme-styles.client.spec.ts`

**接口：**

- 消费：任务 4 的控制器和输入框组件。
- 产出：`portfolio` 路由的 `data-investment-conversation-primary` 展示状态。
- 产出：顶部“新对话”“历史对话”“投研资料”入口。
- 产出：复用 `PortfolioPage` 的资料抽屉。

- [x] **步骤 1：先写路由与注册失败测试**

```tsx
fireEvent.click(screen.getByRole('button', { name: '测试路由到我的投研' }))
expect(document.body).toHaveAttribute('data-investment-conversation-primary')
expect(screen.queryByTestId('assistant-panel')).toBeNull()
expect(screen.queryByRole('button', { name: '打开 AI 研究助理' })).toBeNull()
expect(screen.getByRole('button', { name: '新对话' })).toBeTruthy()
expect(screen.getByRole('button', { name: '历史对话' })).toBeTruthy()
expect(screen.getByRole('button', { name: '投研资料' })).toBeTruthy()
```

`apply.client.spec.ts` 断言 `conversation.input.left` 注册新的组合控件并注入会话控制器；主题测试断言主对话状态不隐藏中心列且样式仅使用语义 token。

- [x] **步骤 2：运行相关测试并确认 RED**

```bash
cd frontend
pnpm exec vitest run packages/client/ui-investment-research/tests/apply.client.spec.ts packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
```

- [x] **步骤 3：实现主对话展示状态**

- `route === 'portfolio'` 时设置 `body.dataset.investmentConversationPrimary = ''`。
- 该状态下删除 `investmentWorkbenchActive`，把工作台主内容设为不可见/不接收事件，让共享对话中心列正常显示。
- 传给浮动助理的展示状态在该路由视为关闭，并完全不渲染启动器或面板；离开路由后恢复原助理状态。
- 清理 effect 必须删除新增 body dataset，防止 Profile 卸载后污染通用 UI。

- [x] **步骤 4：实现顶部会话入口和资料抽屉**

- 「我的投研」顶部增加新对话、历史对话和投研资料按钮。
- 新对话复用 `startSession`；新会话 ID 的上下文由任务 4 控制器读取为空。
- 历史按钮复用现有 `HistoryDrawer`；补充主对话模式下的抽屉宽度、遮罩和焦点返回样式。
- 投研资料按钮打开模态抽屉，内部按需挂载现有 `PortfolioPage`；关闭后不触碰共享草稿和上下文。
- 其他路由的报告、主题和浮动助理入口保持现状。

- [x] **步骤 5：在客户端入口创建和释放控制器**

```ts
const researchChatContext = new ResearchChatContextController(requestData)
ctx.effect(() => () => { researchChatContext.dispose() })
```

输入框插槽改为注册 `InvestmentComposerContextControls`，注入 `investmentUi`、`researchChatContext`、`requestData` 和原固定模块切换函数。

- [x] **步骤 6：运行 UI 包完整测试**

```bash
cd frontend
pnpm exec vitest run packages/client/ui-investment-research/tests
```

预期：新增功能与其他路由、固定模块、主题、持仓和策略研究回归全部通过。

实际：本次功能相关测试全部通过；UI 包共 132 项通过，`product-pages.client.spec.tsx` 中 3 项既有“确认并应用”基线失败仍存在，未修改对应产品代码。

- [x] **步骤 7：运行客户端类型检查**

```bash
cd frontend
pnpm exec tsc -b packages/client/ui-investment-research/tsconfig.json packages/investment-research/python-runtime/tsconfig.json packages/investment-research/stock-analysis/tsconfig.json
```

- [x] **步骤 8：检查任务差异，不提交**

```bash
git diff --check -- frontend/packages/client/ui-investment-research
git status --short
```

---

### 任务 6：集成验证、浏览器验收与 UAT

**文件：**

- 修改：本计划中的复选框，仅记录实际完成步骤。
- 不新增 mock 产品页；UAT 使用真实投研 Profile 和真实后端可用状态。

**接口：**

- 消费：任务 1–5 的完整实现。
- 产出：自动化验证记录、浏览器验收结果和可访问 UAT 进程。

- [x] **步骤 1：运行 Python 定向与完整回归**

```bash
cd backend/dsh-trading-core
python -m unittest tests.test_research_chat_context tests.test_strategy_verification tests.test_store -v
```

如仓库 Python 环境已初始化，再运行：

```bash
python -m unittest discover -s tests -p 'test_*.py'
```

- [x] **步骤 2：运行 TypeScript 定向回归**

```bash
cd frontend
pnpm exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts packages/investment-research/stock-analysis/tests packages/client/ui-investment-research/tests
```

实际：显式功能清单 15 个测试文件、129 项全部通过；完整 UI 包 17 个测试文件中 137 项通过、仅命中 3 项既有基线失败（均位于 `product-pages.client.spec.tsx`，与本次改动无关且改动前已存在）。

- [x] **步骤 3：运行类型与构建验证**

```bash
cd frontend
pnpm exec tsc -b packages/client/ui-investment-research/tsconfig.json packages/investment-research/python-runtime/tsconfig.json packages/investment-research/stock-analysis/tsconfig.json
pnpm build
```

- [x] **步骤 4：使用 `superpowers:verification-before-completion` 复核证据**

复核测试退出码、失败数量、`git diff --check` 和实际改动清单；任何失败都先修复并重跑，不以“理论上通过”替代结果。

- [x] **步骤 5：启动隔离投研 UAT**

```bash
cd frontend
DSH_HOME=/private/tmp/pa-investment-research-uat-367e pnpm dsh --profile investment-research --port 3300
```

Electron 壳进程未完成 Host 初始化，因此没有把空壳窗口作为有效 UAT。最终使用同一 Profile 的 Web 入口启动有效 UAT，并通过独立 Home 与 `18000/18100/18200` 端口绑定当前 worktree 的三组后端；保持进程运行，已核对运行状态、项目目录、健康状态和新增上下文接口。

- [x] **步骤 6：完成浏览器或桌面人工验收路径**

按顺序验证：

1. 进入「我的投研」，共享对话为主界面。
2. 策略和标的选择器位于输入框底部。
3. 推荐与其他策略分组、风险文字、A 股和 ETF 搜索正确。
4. 发送不含隐藏 JSON 的自然语言问题，工具读取当前会话上下文。
5. 方法迁移提示、非推荐策略警告和 ETF 能力边界出现。
6. 新建会话为空，历史会话恢复，两个会话不串线。
7. 投研资料抽屉可访问原持仓、自选、风险、事件和偏好能力。
8. 其他路由的固定助理模块、停靠和展开行为不回归。
9. 明暗主题、键盘操作和窄屏布局可用。

实际：浏览器人工检查覆盖 1、2、3、7，并检查抽屉关闭与焦点返回；自动化覆盖会话隔离、上下文工具、风险/ETF 边界、其他路由回归、主题、键盘和窄屏。隔离 UAT 未配置模型 API Key，因此真实模型发送留给验收者在“设置”中配置 Key 后执行；页面不会把策略或标的业务 JSON 拼入用户正文。

- [x] **步骤 7：最终差异与安全检查**

```bash
git diff --check
git status --short
git diff --stat
```

确认没有提交生成物、运行日志、凭证、UAT 数据文件或无关改动。

- [x] **步骤 8：交付 UAT 信息**

向用户提供：启动方式、当前运行状态、窗口或访问入口、自动化验证结果、已覆盖验收项、首期只支持 A 股/场内 ETF 的限制，以及任何真实存在的未解决问题。

---

### 任务 7：研究工作台当前页二级模态框

**文件：**

- 修改：`docs/prd/0.1.0-rc.9/02-功能需求/01-聊天式我的投研.md`
- 修改：`docs/design/0.1.0-rc.9/01-聊天式我的投研.md`
- 新建：`frontend/packages/client/ui-investment-research/src/client/WorkbenchOverviewDialog.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/ResearchWorkbenchPage.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 修改：`frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`
- 修改：`backend/dsh-trading-core/adapter/risk_engine.py`
- 修改：`backend/dsh-trading-core/tests/test_portfolio_route_latency.py`

- [x] **步骤 1：先更新需求文档与设计文档**

补充 `CHAT-MY-018`，明确投研概览五张卡片和“查看完整风险详情”均在当前页打开二级模态框，并定义数据复用、无跳转、空态和可访问性要求。

- [x] **步骤 2：写当前页模态框失败测试并确认 RED**

测试五张概览卡片不调用 `navigate('portfolio')`，分别打开持仓、成本、市值、风险画像和风险中心模态框；测试“查看完整风险详情”打开风险中心，并覆盖关闭与焦点返回。

- [x] **步骤 3：实现统一工作台详情模态框**

新增 `WorkbenchOverviewDialog`，复用 `DetailDialog`，只消费工作台已加载资源。将概览卡片和完整风险入口切换为详情状态，保留明确跨模块导航。

- [x] **步骤 4：运行定向测试、UI 回归、类型检查与构建**

```bash
cd frontend
pnpm exec vitest run packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx packages/client/ui-investment-research/tests/detail-dialog-regression.client.spec.tsx
pnpm exec tsc -b packages/client/ui-investment-research/tsconfig.json
pnpm build
```

- [x] **步骤 5：重启并人工复验 UAT**

确认当前页不跳转、不滚动锚点，六个入口均打开正确模态框；检查关闭、焦点返回、明暗主题与窄屏布局。

- [x] **步骤 6：最终差异与安全检查**

### 任务 8：研究工作台当前页持仓编辑

**文件：**

- 修改：`frontend/packages/client/ui-investment-research/src/client/WorkbenchOverviewDialog.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/ResearchWorkbenchPage.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 修改：`frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`

- [x] **步骤 1：先更新需求文档与设计文档**

补充 `CHAT-MY-019` 和 6.9，明确持仓模态框内完整增删改、校验、删除确认、保存失败保留草稿及成功后的联动刷新。

- [x] **步骤 2：写持仓编辑失败测试并确认 RED**

覆盖新增、编辑、删除确认、非法输入不保存、保存失败保留草稿，以及成功后仍留在当前页并重新请求持仓、行情、风险和预警。

- [x] **步骤 3：实现内联持仓编辑与保存回调**

模态框维护草稿和确认状态，工作台统一调用 `trading-core.holdings-save` 并驱动资源刷新。

- [x] **步骤 4：运行定向测试、类型检查与构建**

- [x] **步骤 5：重启 UAT 并完成浏览器验收**

- [x] **步骤 6：最终差异与安全检查**

### 任务 9：研究工作台当前页批量导入持仓

**文件：**

- 修改：`docs/prd/0.1.0-rc.9/02-功能需求/01-聊天式我的投研.md`
- 修改：`docs/design/0.1.0-rc.9/01-聊天式我的投研.md`
- 修改：`frontend/packages/client/ui-investment-research/src/client/WorkbenchOverviewDialog.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 修改：`frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`

- [x] **步骤 1：先更新需求文档与设计文档**

补充 `CHAT-MY-020` 和 6.10，明确同层模式切换、文件或粘贴导入、校验预览、整体替换提示、失败恢复和窄屏体验。

- [x] **步骤 2：写批量导入失败测试并确认 RED**

覆盖模式切换、粘贴预览、错误阻止提交、整体替换、失败保留、保存锁定和成功后的资源刷新。

- [x] **步骤 3：实现当前页批量导入体验**

复用现有解析器，增加文件或拖放入口、粘贴区、统计、预览和显式替换操作。

- [x] **步骤 4：运行定向测试、类型检查与构建**

- [x] **步骤 5：更新 UAT 并完成桌面与窄屏浏览器验收**

- [x] **步骤 6：最终差异与安全检查**

---

### 任务 10：修正持仓查看与导入的信息层级

**文件：**

- 修改：`docs/prd/0.1.0-rc.9/02-功能需求/01-聊天式我的投研.md`
- 修改：`docs/design/0.1.0-rc.9/01-聊天式我的投研.md`
- 修改：`frontend/packages/client/ui-investment-research/src/client/WorkbenchOverviewDialog.tsx`
- 修改：`frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- 修改：`frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`

- [x] **步骤 1：先修订需求文档与设计文档**

明确默认持仓明细只负责查看和已有持仓编辑、删除；点击“导入持仓”后才进入子流程，并在其中选择单条录入或批量导入。

- [x] **步骤 2：写层级修正失败测试并确认 RED**

- [x] **步骤 3：实现查看层与录入子流程**

- [x] **步骤 4：运行定向测试、类型检查与构建**

- [x] **步骤 5：更新 UAT 并完成桌面与窄屏验收**

- [x] **步骤 6：最终差异与安全检查**

运行 `git diff --check`、`git status --short` 和改动范围匹配的完整回归；不提交、不推送、不创建 PR。

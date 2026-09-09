# 组合盈亏与收益表现实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为研究工作台增加可追溯的组合盈亏摘要、时间区间筛选、TWR/XIRR 收益口径、收益曲线和逐股贡献详情。

**Architecture:** trading-core 在现有 `holdings.json` 内原子维护当前持仓与不可变快照，独立 `portfolio_performance.py` 复用前复权日线生成组合估值、资金流、TWR、估算 XIRR 与贡献投影。investment python-runtime 暴露固定只读查询，投研客户端复用现有工作台资源与 `DetailDialog`，即时卡片继续用当前持仓和实时行情，弹窗按需读取历史表现。

**Tech Stack:** Python 3、FastAPI、Pydantic、JsonStore、unittest、TypeScript、React、CSS Modules、Vitest、Testing Library、原生 SVG。

**Spec:** `docs/superpowers/specs/2026-09-09-portfolio-profit-performance-design.md`

## 全局约束

- 只使用当前已分配 worktree `/Users/jiahim/.codex/worktrees/9aa5/pa-investment-research` 和分支 `codex/investment-web-adjustments`，不创建或切换其他 worktree。
- 保留工作区中前两项 UI 改动，不覆盖、不暂存、不提交与本功能无关的文件。
- 所有新行为先写失败测试并确认因能力缺失失败，再写最小生产实现。
- 持仓当前值和快照必须通过单次 `JsonStore.mutate_document` 原子写入；缺失行情、现金流或历史不得按零补造。
- 功能组件只使用现有 `--dsw-alias-*` 语义 token、CSS Modules、现有弹窗和按钮模式，不新增图表依赖。
- 服务验证使用隔离 `DSH_INVESTMENT_STATE_DIR` 与独立端口，不操作共享端口 `3080`；最终投研 profile 继续在用户当前 `3095` 入口验收。
- 计划执行中不创建中间提交；每项任务用定向测试与 `git diff --check` 留检查点，最终提交、推送和 PR 仍由用户另行指示。

---

### 任务 1：持仓快照账本与原子保存

**Files:**
- Create: `backend/dsh-trading-core/adapter/portfolio_performance.py`
- Modify: `backend/dsh-trading-core/adapter/app.py`
- Modify: `backend/dsh-trading-core/adapter/schemas.py`
- Modify: `backend/dsh-trading-core/adapter/data_transfer.py`
- Test: `backend/dsh-trading-core/tests/test_portfolio_performance.py`
- Test: `backend/dsh-trading-core/tests/test_holdings.py`
- Test: `backend/dsh-trading-core/tests/test_data_transfer.py`

**Interfaces:**
- Produces: `record_holdings_snapshot(store: JsonStore, positions: list[dict], source: str, effective_at: datetime | None = None) -> dict | None`、`ensure_legacy_seed(store: JsonStore, effective_at: datetime | None = None) -> dict | None`、`list_portfolio_snapshots(store: JsonStore) -> list[dict]`。
- Consumes: `JsonStore.mutate_document`；新增 `HoldingsSaveRequest` 的必填 `holdings` 与可选 `source: manual|bulk_import|api`，既有分析用 `HoldingsRequest` 保持不变。
- Persistence: `holdings.json` 的 `default` 与 `snapshots`；每条快照含 `snapshot_id/effective_at/source/positions/previous_snapshot_id`。

- [ ] **Step 1: 编写账本失败测试**

```python
def test_record_holdings_snapshot_updates_current_and_history_atomically(self):
    saved = record_holdings_snapshot(self.store, self.positions, "manual", self.at_0900)
    self.assertEqual(self.store.get("holdings", "default"), self.positions)
    self.assertEqual(self.store.get("holdings", "snapshots"), [saved])

def test_identical_snapshot_is_idempotent_but_same_day_change_is_retained(self):
    first = record_holdings_snapshot(self.store, self.positions, "manual", self.at_0900)
    duplicate = record_holdings_snapshot(self.store, self.positions, "manual", self.at_1000)
    changed = record_holdings_snapshot(self.store, self.changed_positions, "manual", self.at_1100)
    self.assertEqual(duplicate, first)
    self.assertEqual(len(list_portfolio_snapshots(self.store)), 2)
    self.assertEqual(changed["previous_snapshot_id"], first["snapshot_id"])

def test_legacy_seed_uses_migration_time_instead_of_file_mtime(self):
    self.store.set("holdings", "default", self.positions)
    seed = ensure_legacy_seed(self.store, self.at_0900)
    self.assertEqual(seed["source"], "legacy_seed")
    self.assertEqual(seed["effective_at"], "2026-09-09T09:00:00+08:00")
```

- [ ] **Step 2: 运行账本测试确认 RED**

Run: `cd backend/dsh-trading-core && python -m unittest tests.test_portfolio_performance tests.test_holdings`

Expected: FAIL because `adapter.portfolio_performance` and snapshot-aware save behavior do not exist.

- [ ] **Step 3: 实现快照账本与保存接入**

在 `portfolio_performance.py` 规范化并按代码排序持仓，以 `effective_at + canonical positions` 生成 32 位十六进制 `snapshot_id`，在一个 `mutate_document` 回调内更新 `default` 与 `snapshots`。新增独立 `HoldingsSaveRequest`，避免把保存来源混入 `/holdings/analyze` 合同；`holdings_save` 调用账本函数并返回 `saved/snapshot_id/effective_at`。空持仓保存记录退出快照，但空历史读取不创建种子；`ensure_legacy_seed` 只在当前非空且无快照时写入一次 `legacy_seed`。

- [ ] **Step 4: 保留备份合并中的快照历史**

为 `_merge_holdings` 增加按 `snapshot_id` 合并 `snapshots` 的确定性逻辑：`keep_local` 保留本地并追加不冲突的导入快照，`use_import` 对同 id 使用导入值，`keep_both` 对同 id 内容冲突的快照依据导入内容重新生成合法的 32 位十六进制标识；`default` 继续遵守既有逐 ticker 规则。

- [ ] **Step 5: 运行任务 1 GREEN 验证**

Run: `cd backend/dsh-trading-core && python -m unittest tests.test_portfolio_performance tests.test_holdings tests.test_data_transfer`

Expected: PASS with atomic save, idempotency, legacy seed and backup merge cases green.

---

### 任务 2：估值、TWR、XIRR 与表现 API

**Files:**
- Modify: `backend/dsh-trading-core/adapter/portfolio_performance.py`
- Modify: `backend/dsh-trading-core/adapter/app.py`
- Test: `backend/dsh-trading-core/tests/test_portfolio_performance.py`

**Interfaces:**
- Produces: `portfolio_performance(store: JsonStore, start_date: date | None, end_date: date, price_loader: Callable[[str, str, str], list[dict]]) -> dict`。
- Produces: `GET /portfolio/performance?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`。
- Consumes: `list_portfolio_snapshots`、`holdings_runner._a_share_code` 和 `_bs_hist(code, start, end)`。
- Return shape: `available_since/start_date/end_date/as_of/price_basis/quality/limitations/summary/returns/series/contributions/cash_flows/missing_tickers/coverage_ratio`。

- [ ] **Step 1: 编写收益算法失败测试**

```python
def test_time_weighted_return_chain_links_around_a_deposit(self):
    result = portfolio_performance(self.store, date(2026, 1, 2), date(2026, 1, 6), self.price_loader)
    self.assertAlmostEqual(result["returns"]["twr"]["value"], 0.21, places=6)
    self.assertEqual(result["summary"]["net_flow"], 1000.0)

def test_xirr_is_estimated_and_null_without_opposite_cash_flows(self):
    result = portfolio_performance(self.store, None, date(2026, 1, 6), self.price_loader)
    self.assertEqual(result["returns"]["xirr"]["quality"], "estimated")
    self.assertIsNotNone(result["returns"]["xirr"]["value"])
    empty = portfolio_performance(self.empty_store, None, date(2026, 1, 6), self.price_loader)
    self.assertIsNone(empty["returns"]["xirr"]["value"])

def test_missing_price_never_becomes_zero(self):
    result = portfolio_performance(self.store, None, date(2026, 1, 6), self.missing_price_loader)
    self.assertIn("600519", result["missing_tickers"])
    self.assertNotEqual(result["summary"]["end_value"], 0)
```

- [ ] **Step 2: 运行算法测试确认 RED**

Run: `cd backend/dsh-trading-core && python -m unittest tests.test_portfolio_performance`

Expected: FAIL because valuation, cash-flow derivation, TWR, XIRR and API projection are absent.

- [ ] **Step 3: 实现确定性收益引擎**

把快照按时间排序并转换为日内事件；为涉及标的一次加载完整日期窗口的前复权收盘价。估值日使用当日价格，停牌日仅在已有更早价格时前向填充；上市前或全窗口缺失保持不可计算。仓位变化日以变化前后同日估值推导净流入，TWR 对每个无资金流子区间计算收益后链结。

XIRR 使用年化日期差 `days/365`，先验证现金流同时存在正负项，再用 `[-0.9999, 10]` 范围二分求根；区间内无根或 200 次迭代后不收敛时返回 `value=null/reason`。贡献按标的 `end_value - start_value - net_flow` 计算并按绝对值降序。

- [ ] **Step 4: 编写并实现路由合同**

测试 422 的非法日期、未来结束日期、开始晚于结束、200 的空持仓结果和行情异常 503。`app.py` 路由在查询前调用 `ensure_legacy_seed`，通过可补丁的 `load_portfolio_prices` 适配 `_bs_hist`，业务异常映射为稳定中文详情。

- [ ] **Step 5: 运行任务 2 GREEN 验证**

Run: `cd backend/dsh-trading-core && python -m unittest tests.test_portfolio_performance tests.test_holdings tests.test_data_transfer`

Expected: PASS with exact fixtures for valuation, TWR, XIRR, contribution, quality and route errors.

---

### 任务 3：客户端固定数据操作映射

**Files:**
- Modify: `frontend/packages/investment-research/python-runtime/src/data.ts`
- Test: `frontend/packages/investment-research/python-runtime/tests/data.spec.ts`

**Interfaces:**
- Produces: `InvestmentDataRequest` operation `trading-core.portfolio-performance`。
- Consumes: optional `start_date/end_date` strings; maps only to `/portfolio/performance` query parameters.

- [ ] **Step 1: 编写操作映射失败测试**

```ts
it('maps the bounded portfolio performance date range', async () => {
  await requestInvestmentData({
    operation: 'trading-core.portfolio-performance',
    input: { start_date: '2026-08-01', end_date: '2026-09-09' },
  }, acquire)
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:8000/portfolio/performance?start_date=2026-08-01&end_date=2026-09-09',
    { method: 'GET' },
  )
})
```

同时断言 `url`、非法日期和未知键在 acquire backend 前被拒绝。

- [ ] **Step 2: 运行 runtime 测试确认 RED**

Run: `cd frontend && pnpm exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts`

Expected: FAIL with unknown operation or missing route mapping.

- [ ] **Step 3: 实现白名单查询映射**

在数据操作表加入 `trading-core.portfolio-performance`，`knownKeys(input, ['start_date', 'end_date'])` 后验证 `YYYY-MM-DD`，使用既有 `query()` 生成 GET URL；不接受任意路径、后端或价格输入。

- [ ] **Step 4: 运行任务 3 GREEN 验证**

Run: `cd frontend && pnpm exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts`

Expected: PASS with correct URL encoding and unsafe input rejection.

---

### 任务 4：盈亏摘要卡与详情弹窗

**Files:**
- Create: `frontend/packages/client/ui-investment-research/src/client/PortfolioPerformanceDialog.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/ResearchWorkbenchPage.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- Test: `frontend/packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`

**Interfaces:**
- Produces: `PortfolioPerformanceDialog` props `value/state/startDate/endDate/period/method/onPeriodChange/onMethodChange/onCustomRange/onRetry/onClose`。
- Consumes: `trading-core.portfolio-performance` response and current workbench positions/quotes.
- UI state: 独立 `performanceOpen` 控制新弹窗，不扩展 `WorkbenchOverviewDialog` 的 `WorkbenchDetailKind`；默认 period `since_inception`，默认 method `twr`。

- [ ] **Step 1: 编写概览与弹窗失败测试**

```tsx
expect(view.getByRole('button', { name: /盈亏情况/ })).toHaveTextContent('-¥5,000')
fireEvent.click(view.getByRole('button', { name: /盈亏情况/ }))
const dialog = await view.findByRole('dialog', { name: '盈亏详情' })
expect(within(dialog).getByRole('button', { name: '持仓以来' })).toHaveAttribute('aria-pressed', 'true')
expect(within(dialog).getByRole('radio', { name: /时间加权收益率/ })).toBeChecked()
expect(within(dialog).getByText('历史记录始于 2026-08-01')).toBeTruthy()
```

增加 7/15/30 日、半年、1 年、自定义请求；非法自定义区间不发请求；XIRR 不可计算解释；空、加载、保留旧值刷新、部分行情与错误重试；关闭后焦点返回卡片的测试。

- [ ] **Step 2: 运行组件测试确认 RED**

Run: `cd frontend && pnpm exec vitest run packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx`

Expected: FAIL because the performance card, dialog and request state do not exist.

- [ ] **Step 3: 实现即时盈亏摘要**

在 `ResearchWorkbenchPage` 用严格完整性检查计算 `currentCost/currentValue/currentProfit/costReturn`；任一持仓缺数量、成本或实时价时合计为 `undefined`。把新卡插在总资产现价与风险画像之间，显示带正负号金额、`成本收益率 ±x.xx%` 和明确空态文案，并用独立 `performanceOpen` 打开详情。

- [ ] **Step 4: 实现按需表现资源和筛选状态**

仅在弹窗打开时请求表现接口；7/15/30 日按包含今天的自然日窗口计算，半年和 1 年按本地日历月/年回退，`since_inception` 省略开始日期。切换算法只使用已有响应，切换区间与提交有效自定义日期才发新请求；刷新保留旧值并显示数据时间，关闭弹窗不清空最后成功结果。

- [ ] **Step 5: 实现可访问弹窗与原生曲线**

`PortfolioPerformanceDialog` 复用 `DetailDialog`，渲染摘要指标、区间分段控件、算法单选组、质量/限制说明、原生 SVG 折线、同数据的日期表、贡献事实列表和算法说明。SVG 使用 `role="img"` 与包含起止日期和收益方向的 `aria-label`；只有一个数据点时显示无曲线空态。

- [ ] **Step 6: 实现响应式和主题样式**

工作台五卡在宽屏为五列、1024 附近为三加二、768 为两列、390 为单列；弹窗摘要在宽屏四列、窄屏两列或单列，筛选器可换行，贡献表在窄屏转为纵向事实项。全部颜色引用现有语义 token，正负值同时保留 `+/-` 文本。

- [ ] **Step 7: 运行任务 4 GREEN 验证**

Run: `cd frontend && pnpm exec vitest run packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx packages/client/ui-investment-research/tests/data-pages.client.spec.tsx`

Expected: PASS with all existing overview behavior and new performance states green.

---

### 任务 5：文档、跨层验证与真实 UAT

**Files:**
- Modify: `backend/dsh-trading-core/docs/API-接口文档.md`
- Modify: `backend/dsh-trading-core/docs/前端接入指南.md`
- Modify: `frontend/packages/client/ui-investment-research/README.md`
- Modify: `frontend/packages/client/ui-investment-research/README.zh.md`
- Modify: `frontend/packages/client/ui-investment-research/README.i18n.yaml`
- Test: files from tasks 1–4.

**Interfaces:**
- Consumes: the complete API and UI contracts from tasks 1–4.
- Produces: documented endpoint, package behavior, paired README record and real-browser acceptance evidence.

- [ ] **Step 1: 更新权威接口与产品文档**

在 trading-core API 文档记录 `/portfolio/performance` 参数、返回字段、算法边界、legacy seed 和错误；前端接入指南增加固定调用示例。同步更新投研 UI 英中 README，说明五卡概览、区间、TWR 和估算 XIRR，并只为该 README 重新记录 i18n 哈希。

- [ ] **Step 2: 运行定向后端与前端验证**

Run: `cd backend/dsh-trading-core && python -m unittest tests.test_portfolio_performance tests.test_holdings tests.test_data_transfer`

Run: `cd frontend && pnpm exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx packages/client/ui-investment-research/tests/data-pages.client.spec.tsx packages/client/ui-investment-research/tests/product-pages.client.spec.tsx packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx`

Run: `cd frontend && pnpm run typecheck:contracts-ready`

Run: `cd frontend && pnpm --filter @deepseek-ai/dsh-client-ui-investment-research run bundle`

- [ ] **Step 3: 运行样式与文档检查**

Run: `cd frontend && pnpm run verify-client-theme-styles`

Run: `cd frontend && pnpm run verify-translation-pairing --write packages/client/ui-investment-research/README.md`

Run: `cd frontend && pnpm run verify-translation-pairing packages/client/ui-investment-research/README.md`

Run: `git diff --check`

既有无关失败必须用文件和测试名单独归因，不把失败门禁描述为通过。

- [ ] **Step 4: 在隔离后端验证持久化与计算**

用 `/private/tmp` 下新建 `DSH_INVESTMENT_STATE_DIR`，在非共享端口启动 trading-core；依次保存首个持仓、变化后的持仓并重启服务，确认快照仍存在、`available_since` 稳定、默认区间及自定义区间可查询、非法日期返回 422。若真实行情不可达，保留后端确定性 fixture 证据并把联网行情列为未验证，不伪造成功。

- [ ] **Step 5: 在投研 profile 完成浏览器 UAT**

重启或刷新 `http://127.0.0.1:3095/`，验收 1440×900、1024×768、768×900、390×844，浅色与深色主题。操作盈亏卡、全部预设区间、自定义日期、TWR/XIRR、重试、关闭和 Escape，检查焦点返回、无页面横向滚动、长名称与负大额值不遮挡；保留截图并将最终可验收弹窗标记为 deliverable。

- [ ] **Step 6: 最终工作区审计**

Run: `git status --short`

Run: `git diff --stat`

Run: `git diff --check`

确认仅包含前两项已知改动、本功能文件和规格/计划文档；报告已通过验证、既有失败、未联网验证项、当前服务地址和未执行的提交/推送操作。

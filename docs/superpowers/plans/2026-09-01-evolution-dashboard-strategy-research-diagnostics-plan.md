# 自进化看板与策略研究诊断分层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以远端自动闭环为统一进化写入路径，把侧栏自进化改造成全局只读看板，并让看板中的策略进入策略研究第 4 步完成单策略诊断和只读重新评估。

**Architecture:** 全局 `EvolutionDashboard` 只消费 status/attribution；单策略 `StrategyEvolutionDiagnostics` 只消费携带同一 `strategy_id` 的 status/attribution。两者共用后端纯判定函数，但都不调用 preview/run；只有启用的调度器通过 `evolve_auto()` 应用进化动作。

**Tech Stack:** Python 3.14、FastAPI、APScheduler、React 18、TypeScript、CSS Modules、Vitest、Testing Library、unittest、浏览器 DOM 度量。

**Spec:** `docs/superpowers/specs/2026-09-01-evolution-dashboard-strategy-research-diagnostics-design.md`

## Global Constraints

- 远端基线以执行时最新 `public/master` 为准；设计时已抓取的参考提交为 `0c7db5925a66efd8b5beaa99b3ad398632cbdcba`。
- 设计时目标 worktree `/Users/xiexin/.codex/worktrees/ee40/pa-investment-research` 处于 detached HEAD `e7eb52c36840571d952253674ffa2bf428847466`，并含大量继承未提交修改。
- 在没有新的明确授权前，不得在该 dirty worktree 中 stash、reset、switch、checkout、merge、暂存、提交或清理；不得覆盖范围外继承修改。
- 执行代码任务前，调度方必须提供一个以最新 `public/master` 为基线、具有唯一绝对路径的可写集成 worktree；它可以使用唯一特性分支，也可以按产品默认方式使用以 `public/master` 为精确基准的 Codex 托管 detached HEAD。若仍只提供上述 dirty detached worktree，执行代理在任务 1 停止。
- 目标特性分支名 `codex/restore-dashboard-kyc` 仅记录，暂不创建；未获得进一步授权前保持 Codex 托管 detached HEAD，不提交、推送或创建 PR。
- 旧任务的允许修改范围不足以承载远端闭环与新导航；执行前必须明确授权本计划各 Task 的 `Files` 清单。未获得扩展范围授权时，执行代理在任务 1 停止。
- 顶层 worktree-writer 是唯一写入者；子代理仅用于只读分析、审查和测试结果分析。
- 产品 UI 不调用 `evolution-preview` 或 `evolution-run`；旧接口仅保持兼容测试。
- `CLOSED_LOOP_ENABLED=true` 时，自动闭环按远端逻辑统一应用动作；页面重新评估永不写入。
- 全局看板请求不携带 `strategy_id`；策略研究 status/attribution 必须携带同一安全 `strategy_id`。
- 单策略安全标识继续匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`。
- 所有新增和更新的 Markdown 文档使用中文。
- 未获得端口授权前不启动服务；不得启动、停止或占用共享 `3080`。
- 除非用户另行明确授权，不创建提交、推送或 PR；各任务以测试与 `git diff --check` 作为检查点。

---

## 文件职责

- `backend/dsh-trading-core/adapter/evolution.py`：共享纯判定、全局/单策略状态、生命周期、最近应用、兼容 preview/run 和 `evolve_auto()`。
- `backend/dsh-trading-core/adapter/app.py`：全局/单策略 evolution 查询参数和 404 映射。
- `backend/dsh-trading-core/adapter/schemas.py`：兼容手动接口的可选安全 `strategy_id` 请求字段。
- `backend/dsh-trading-core/adapter/config.py`：自动闭环开关与运行时间。
- `backend/dsh-trading-core/adapter/scheduler.py`：统一闭环调度和执行顺序。
- `backend/dsh-trading-core/tests/test_evolution.py`：判定一致性、scope 隔离和只读保证。
- `backend/dsh-trading-core/tests/test_closed_loop.py`：自动闭环顺序、写入和调度开关。
- `backend/dsh-trading-core/tests/test_config_precedence.py`：闭环配置优先级。
- `frontend/packages/client/ui-investment-research/src/client/evolution-types.ts`：看板、诊断和导航共享的请求及生命周期分组类型。
- `frontend/packages/client/ui-investment-research/src/client/EvolutionDashboard.tsx`：全局只读看板容器。
- `frontend/packages/client/ui-investment-research/src/client/StrategyEvolutionDiagnostics.tsx`：固定单策略诊断与重新评估容器。
- `frontend/packages/client/ui-investment-research/src/client/EvolutionWorkspace.tsx`：迁移期兼容导出；不再承载预案生成和应用状态。
- `frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx`：策略研究生命周期和第 4 步装配。
- `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`：看板、策略研究和返回路径装配。
- `frontend/packages/client/ui-investment-research/src/client/state.ts`：受控策略阶段与看板返回上下文。
- `frontend/packages/client/ui-investment-research/src/client/assistant-intent.ts`：全局/单策略只读解释提示。
- `frontend/packages/investment-research/stock-analysis/src/client.ts`：investment_context 固定读取 status/attribution。
- `frontend/packages/investment-research/stock-analysis/src/index.ts`：工具 schema、呈现和执行参数。
- `frontend/packages/investment-research/python-runtime/src/data.ts`：把安全 `strategy_id` 透传给 evolution 读接口并保留旧 preview/run 兼容桥。
- `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`：看板、诊断和三档响应式布局。

---

### Task 1: 建立安全的远端集成基线

**Files:**
- Read: `AGENTS.md`
- Read: `docs/superpowers/specs/2026-09-01-evolution-dashboard-strategy-research-diagnostics-design.md`
- Read: `docs/superpowers/plans/2026-09-01-evolution-dashboard-strategy-research-diagnostics-plan.md`

**Interfaces:**
- Consumes: 调度方分配的唯一集成 worktree、最新 `public/master`，以及唯一分支或 Codex 托管 detached HEAD。
- Produces: 已包含远端更新且可安全写入的集成基线；后续任务不得自行改变 worktree 或分支。

- [x] **Step 1: 完整读取规格、计划和仓库约束**

```bash
cat AGENTS.md
cat docs/superpowers/specs/2026-09-01-evolution-dashboard-strategy-research-diagnostics-design.md
cat docs/superpowers/plans/2026-09-01-evolution-dashboard-strategy-research-diagnostics-plan.md
```

Expected: 无截断地读完三份文件；执行顺序固定为 Task 1 → 8。

- [x] **Step 2: 核对集成 worktree**

```bash
pwd
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse HEAD
git branch --show-current
git status --short
git worktree list --porcelain
git remote -v
```

Expected: 路径和基准与调度方分配完全一致；若有分支，该分支唯一且不是默认或共享分支；若为 Codex 托管 detached HEAD，必须精确指向最新 `public/master`。若仍是 `/Users/xiexin/.codex/worktrees/ee40/pa-investment-research` 的 detached dirty 状态，停止，不执行 stash、merge 或任何写操作。

- [x] **Step 3: 抓取并确认公共基线**

```bash
git fetch public master
git rev-parse public/master
git log --oneline --no-merges -4 public/master
```

Expected: 记录实际 `public/master`；若不再是设计时的 `0c7db5925a66efd8b5beaa99b3ad398632cbdcba`，先重新检查新增提交是否改变自动闭环或看板合同。

- [x] **Step 4: 确认远端更新均在集成基线中**

```bash
git merge-base --is-ancestor public/master HEAD
git diff --name-status public/master HEAD
```

Expected: 第一条退出码为 0。差异只能来自当前功能迁移，不得把远端回测窗口、行情批量报价或自动闭环文件恢复成旧版本。

- [x] **Step 5: 记录检查点（不提交）**

```bash
git status --short
git diff --cached --name-only
```

Expected: 暂存区为空；无来源不明的新修改。

**执行记录（2026-09-01）：** 集成 worktree 为 `/Users/xiexin/.codex/worktrees/9945/pa-investment-research`，Codex 托管 detached `HEAD` 与抓取后的 `public/master` 均为 `ca34626304d05678b02ee6e943213057885efe2e`；`public/master..HEAD` 无文件差异，开始实施前工作区与暂存区均为空。设计与计划已从 ee40 只读源原样纳入本 worktree，ee40 未发生写入。

---

### Task 2: 合并 scoped 判定与远端看板状态合同

**Files:**
- Modify: `backend/dsh-trading-core/adapter/app.py`
- Modify: `backend/dsh-trading-core/adapter/evolution.py`
- Modify: `backend/dsh-trading-core/adapter/schemas.py`
- Modify: `backend/dsh-trading-core/tests/test_evolution.py`
- Modify: `backend/dsh-trading-core/docs/API-接口文档.md`

**Interfaces:**
- Consumes: 当前 `_scoped_shadow_series(store, strategy_id)`、`attribution(store, strategy_id)`、scoped 路由兼容桥和远端生命周期字段。
- Produces: `_per_strategy_decisions(store, attr, strategy_id=None) -> tuple[list[dict], list[dict]]`、`status(store=None, strategy_id=None) -> dict`，以及可透传同一 `strategy_id` 的 HTTP 合同，供 Task 3、5、6 使用。

- [x] **Step 1: 写 scoped 看板状态红灯测试**

在 `tests/test_evolution.py` 增加：

```python
def test_scoped_status_exposes_only_target_strategy_without_writes(self):
    store = _store()
    _plant(store)
    before = copy.deepcopy(store.all("strategies"))
    result = status(store, strategy_id="strat-good")
    self.assertEqual([row["strategy_id"] for row in result["per_strategy"]], ["strat-good"])
    self.assertTrue(all(
        action.get("sid") == "strat-good" or action.get("parent") == "strat-good"
        for run in result["recent_applied"]
        for action in run["actions"]
    ))
    self.assertEqual(store.all("strategies"), before)

def test_global_status_exposes_closed_loop_dashboard_contract(self):
    result = status(_store())
    for key in (
        "closed_loop_enabled", "closed_loop_time", "lifecycle",
        "per_strategy", "recent_applied", "last_applied_at",
    ):
        self.assertIn(key, result)

def test_scoped_read_routes_forward_strategy_id_and_map_missing_to_404(self):
    with TestClient(app) as client:
        with patch("adapter.app.evolution.status") as scoped_status:
            scoped_status.return_value = {"ready": True}
            response = client.get("/evolution/status?strategy_id=strat-good")
            self.assertEqual(response.status_code, 200)
            scoped_status.assert_called_once_with(strategy_id="strat-good")

        response = client.get("/evolution/attribution?strategy_id=strat-missing")
        self.assertEqual(response.status_code, 404)
```

- [x] **Step 2: 运行后端红灯测试**

```bash
cd backend/dsh-trading-core
./env/bin/python -m unittest \
  tests.test_evolution.EvolutionTests.test_scoped_status_exposes_only_target_strategy_without_writes \
  tests.test_evolution.EvolutionTests.test_global_status_exposes_closed_loop_dashboard_contract -v
```

Expected: FAIL，缺少远端看板字段或 scoped 过滤。

- [x] **Step 3: 提取共享纯判定函数**

在 `adapter/evolution.py` 保留现有 preview 兼容逻辑，并实现：

```python
def _per_strategy_decisions(
    store: JsonStore,
    attr: dict,
    strategy_id: str | None = None,
) -> tuple[list[dict], list[dict]]:
    """返回当前策略判定条目与动作；只计算，不写库。"""
```

要求：

- 全局遍历 active 策略；指定策略时只读取目标策略。
- 非 active 策略返回只读行为说明和空动作。
- 升降级、退役、变异阈值逐字复用现有逻辑。
- `_build_preview` 与 `status` 均调用该函数。
- blocked/empty/pending、scope 指针和令牌合同保持不变。

- [x] **Step 4: 合入 scoped 生命周期与最近应用**

实现：

```python
def _recent_applied(
    store: JsonStore,
    strategy_id: str | None = None,
    limit: int = 5,
) -> list[dict]:
    rows: list[dict] = []
    for record in (store.all(_PREVIEW_COLLECTION) or {}).values():
        if not isinstance(record, dict) or record.get("preview_status") != "applied":
            continue
        actions = [action for action in record.get("actions") or [] if isinstance(action, dict)]
        if strategy_id is not None:
            actions = [action for action in actions if (
                action.get("sid") == strategy_id or action.get("parent") == strategy_id
            )]
        if not actions:
            continue
        rows.append({
            "applied_at": record.get("applied_at"),
            "count": len(actions),
            "actions": actions,
        })
    rows.sort(key=lambda row: str(row.get("applied_at") or ""), reverse=True)
    return rows[:limit]

def _last_applied_at(store: JsonStore, strategy_id: str | None = None) -> str | None:
    rows = _recent_applied(store, strategy_id, limit=1)
    return None if not rows else str(rows[0].get("applied_at") or "") or None

def _lifecycle(store: JsonStore, strategy_id: str | None = None) -> dict[str, list[dict]]:
    groups = {key: [] for key in (
        "active", "candidate", "mutated", "retired", "watch", "rejected",
    )}
    for record in (store.all("strategies") or {}).values():
        if not isinstance(record, dict):
            continue
        entry = _lifecycle_entry(record)
        status_value = str(record.get("status") or "")
        evolve_state = str((record.get("evolve") or {}).get("state") or "")
        if record.get("source") == "evolution":
            groups["mutated"].append(entry)
        if status_value in groups:
            groups[status_value].append(entry)
        if status_value == "active" and evolve_state in {"watch", "retired"}:
            groups[evolve_state].append(entry)
    if strategy_id is None:
        return groups
    all_entries = {
        str(entry.get("strategy_id")): entry
        for entries in groups.values()
        for entry in entries
    }
    related = {strategy_id}
    changed = True
    while changed:
        changed = False
        for sid, entry in all_entries.items():
            parent = str(entry.get("mutated_from") or "")
            if sid in related and parent and parent not in related:
                related.add(parent)
                changed = True
            if parent in related and sid not in related:
                related.add(sid)
                changed = True
    return {
        key: [entry for entry in entries if str(entry.get("strategy_id")) in related]
        for key, entries in groups.items()
    }
```

`_lifecycle_entry(record)` 返回远端合同中的 `strategy_id`、`name`、`kind`、`tier`、`symbols`、`mutated_from` 和 `source`，不做存储写入。

过滤规则：

- 全局返回远端全部生命周期语义。
- 单策略 `per_strategy` 只含目标策略。
- 单策略 `recent_applied` 只保留命中目标 `sid` 或以目标为 `parent` 的动作；空轮次不返回。
- 单策略 `lifecycle` 只返回目标策略和解释 `mutated_from` 母子链所需节点。
- 非 active 策略仍可返回历史，但 decision 为 `none`，动作为空。

- [x] **Step 5: 扩展 status 返回合同**

```python
return {
    "as_of": _now(),
    "days_of_data": n,
    "min_days": settings.evolve_min_days,
    "ready": ready,
    "counts": counts,
    "lifecycle": lifecycle,
    "per_strategy": per_strategy,
    "recent_applied": recent_applied,
    "last_applied_at": last_applied_at,
    "closed_loop_enabled": settings.closed_loop_enabled,
    "closed_loop_time": settings.closed_loop_time,
    "note": note,
}
```

指定 `strategy_id` 时 days、ready、counts、归因和判定全部来自同一策略作用域，不回退全局。

- [x] **Step 6: 恢复 scoped HTTP 兼容桥**

- `/evolution/status`、`/evolution/attribution` 和兼容 `/evolution/preview` 接受可选、安全的 query `strategy_id` 并原样转发。
- `EvolutionRunRequest` 保留可选、安全的 body `strategy_id`；`/evolution/run` 原样转发。
- 非法标识在 evolution 存储读取前返回 `422`；不存在的策略映射为 `404`。
- 不新增产品 UI 的 preview/run 调用。

- [x] **Step 7: 运行后端绿灯与兼容回归**

```bash
cd backend/dsh-trading-core
./env/bin/python -m unittest tests.test_evolution -v
```

Expected: 新状态测试和旧 preview/run scope、blocked、empty、pending 测试全部 PASS。

- [x] **Step 8: 更新 API 合同并检查**

API 文档写明全局与 scoped status 字段、非 active 只读行为，以及页面重新评估不产生写入。

```bash
git diff --check
```

Expected: PASS；不改写旧 preview/run 兼容合同。

**执行记录（2026-09-01）：** scoped status/attribution、生命周期母子链、最近应用过滤和安全 HTTP 兼容桥已按 TDD 合入；blocked/empty 非动作结果不生成可应用令牌。`./env/bin/python -m unittest tests.test_evolution -v` 共 28 项通过，`git diff --check` 通过，暂存区为空。

---

### Task 3: 接入远端统一自动闭环

**Files:**
- Modify: `backend/dsh-trading-core/adapter/config.py`
- Modify: `backend/dsh-trading-core/adapter/evolution.py`
- Modify: `backend/dsh-trading-core/adapter/scheduler.py`
- Modify: `backend/dsh-trading-core/tests/test_closed_loop.py`
- Modify: `backend/dsh-trading-core/tests/test_config_precedence.py`

**Interfaces:**
- Consumes: Task 2 `_per_strategy_decisions` 和现有全局 `evolve(store, apply, preview_token)`。
- Produces: `evolve_auto(store=None) -> dict`、`_run_closed_loop_job() -> None` 和闭环配置字段。

- [x] **Step 1: 写统一闭环红灯测试**

保留远端 `test_closed_loop.py`，并增加：

```python
def test_evolve_auto_applies_ready_actions_through_exact_preview(self):
    store = _store()
    _plant(store)
    result = evolve_auto(store)
    self.assertTrue(result["applied"])
    self.assertEqual(result["preview_status"], "applied")
    self.assertEqual(store.get("strategies", "strat-good")["evolve"]["tier"], 2)
```

调度测试继续断言 `shadow → evolve_auto → candidate backtest → push` 顺序，以及 `CLOSED_LOOP_ENABLED=false` 不注册 job。

- [x] **Step 2: 运行自动闭环红灯测试**

```bash
cd backend/dsh-trading-core
./env/bin/python -m unittest tests.test_closed_loop tests.test_config_precedence -v
```

Expected: FAIL，直到远端配置、调度和当前 scoped evolution 正确合并。

- [x] **Step 3: 合入闭环配置**

```python
self.closed_loop_enabled = os.getenv("CLOSED_LOOP_ENABLED", "false").lower() == "true"
self.closed_loop_time = os.getenv("CLOSED_LOOP_TIME", "15:35")
```

不得改变既有进化阈值默认值。

- [x] **Step 4: 实现 evolve_auto**

```python
def evolve_auto(store: JsonStore | None = None) -> dict:
    store = store or JsonStore()
    preview = evolve(store, apply=False)
    if preview.get("preview_status") != "pending" or not preview.get("actions"):
        return preview
    return evolve(store, apply=True, preview_token=preview.get("preview_token"))
```

waiting/blocked 和 ready/empty 均不应用；只有动作非空且令牌有效的全局 pending 进入 apply。该函数不接受 `strategy_id`，确保统一闭环始终按全局最新证据判定。

- [x] **Step 5: 合入调度顺序与异常隔离**

- 非交易日跳过整轮。
- shadow、进化、候选回测和 push 分段捕获异常。
- 只回测 `verification_status: pending` 的候选。
- 调度注册由 `closed_loop_enabled` 和 `closed_loop_time` 控制。
- 不改变简报和独立 shadow 调度的既有开关。

- [x] **Step 6: 运行自动闭环绿灯**

```bash
cd backend/dsh-trading-core
./env/bin/python -m unittest \
  tests.test_closed_loop \
  tests.test_config_precedence \
  tests.test_evolution -v
```

Expected: 全部 PASS；自动闭环和手动兼容接口共用同一动作规则。

- [x] **Step 7: 检查点（不提交）**

```bash
git diff --check
git status --short
```

Expected: 无格式错误；未覆盖远端 scheduler/config 的无关更新。

**执行记录（2026-09-01）：** 最新 `public/master` 已包含与计划示例等价的自动应用测试、闭环配置、`evolve_auto()`、交易日门禁、分段异常隔离、候选验证和推送顺序，因此未人为制造重复实现。计划回归 `tests.test_closed_loop tests.test_config_precedence tests.test_evolution` 共 39 项通过；Task 3 未修改 scheduler/config 及其测试文件，`git diff --check` 通过。

---

### Task 4: 收敛 AI 上下文为只读 status/attribution

**Files:**
- Modify: `frontend/packages/client/ui-investment-research/src/client/assistant-intent.ts`
- Modify: `frontend/packages/client/ui-investment-research/tests/assistant-intent.client.spec.ts`
- Modify: `frontend/packages/investment-research/python-runtime/src/data.ts`
- Modify: `frontend/packages/investment-research/python-runtime/tests/data.spec.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/src/client.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/src/index.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/client.spec.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`
- Modify: `frontend/packages/investment-research/stock-analysis/README.zh.md`

**Interfaces:**
- Consumes: `{ kind: 'evolution'; strategyId?: string }` 和安全标识校验。
- Produces: 只读取两条固定 evolution URL 的 `investment_context`，供 Task 5、6 AI 按钮使用。

- [x] **Step 1: 写 AI 上下文红灯测试**

```ts
it('单策略 evolution 上下文只读取 status 和 attribution', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return response({ source: url })
  }))
  await getInvestmentContext(BASE, 'evolution', undefined, { strategyId: 'strat-a' })
  expect(calls).toEqual([
    `${BASE}/evolution/status?strategy_id=strat-a`,
    `${BASE}/evolution/attribution?strategy_id=strat-a`,
  ])
})
```

assistant intent 测试断言全局提示解释闭环状态，单策略提示解释预计判定，二者都不承诺人工 apply。

同时在 `python-runtime/tests/data.spec.ts` 保留或补充桥接测试，断言：

```ts
const release = vi.fn(async () => {})
const acquire = vi.fn(async () => ({
  baseUrl: 'http://127.0.0.1:8000',
  release,
}))
const calls: Array<[string, string, string | undefined]> = []
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  calls.push([url, init?.method ?? 'GET', init?.body as string | undefined])
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}))
await requestInvestmentData({
  operation: 'trading-core.evolution-status',
  input: { strategy_id: 'strategy:alpha' },
}, acquire)
await requestInvestmentData({
  operation: 'trading-core.evolution-attribution',
  input: { strategy_id: 'strategy:alpha' },
}, acquire)
expect(calls).toEqual([
  ['http://127.0.0.1:8000/evolution/status?strategy_id=strategy%3Aalpha', 'GET', undefined],
  ['http://127.0.0.1:8000/evolution/attribution?strategy_id=strategy%3Aalpha', 'GET', undefined],
])
```

- [x] **Step 2: 运行红灯测试**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/assistant-intent.client.spec.ts \
  packages/investment-research/python-runtime/tests/data.spec.ts \
  packages/investment-research/stock-analysis/tests/client.spec.ts \
  packages/investment-research/stock-analysis/tests/plugin.spec.ts
```

Expected: FAIL，因为当前 evolution context 仍读取 preview，提示仍围绕人工预案。

- [x] **Step 3: 移除 preview 上下文读取**

```ts
evolution: [
  ['status', '/evolution/status'],
  ['attribution', '/evolution/attribution'],
]
```

继续对两条路径追加同一编码后的 `strategy_id`；非法标识和非 evolution 参数在 fetch 前拒绝。`python-runtime` 的 `evolutionRead(path)` 同样只接受可选 `strategy_id`，并把它编码到 query；旧 `evolution-preview` 和 `evolution-run` 的 scoped 兼容能力继续保留，但产品 UI 不调用。

- [x] **Step 4: 更新 intent、schema 与呈现**

- 全局 intent 解释闭环状态、生命周期、策略判定和最近自动动作。
- 单策略 intent 解释该策略证据、预计判定和历史，不请求写入。
- tool schema 继续回显可选 `strategy_id`。
- `presentCall` 标题区分“自进化全局看板”和“策略进化诊断”。

- [x] **Step 5: 运行绿灯测试**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/assistant-intent.client.spec.ts \
  packages/investment-research/python-runtime/tests/data.spec.ts \
  packages/investment-research/stock-analysis/tests/client.spec.ts \
  packages/investment-research/stock-analysis/tests/plugin.spec.ts
```

Expected: 全部 PASS；不存在 preview URL。

- [x] **Step 6: 更新 README 并检查**

说明 evolution context 只读取 status/attribution，AI 无写入能力。

```bash
git diff --check
```

Expected: PASS。

**执行记录（2026-09-01）：** evolution AI 上下文已收敛为只读 `status`/`attribution`，全局与单策略 intent、插件 schema 和呈现标题已区分，旧 preview/run 仅保留兼容桥；非法 scoped 标识与跨域参数均在网络请求前拒绝。计划绿灯命令共 49 项通过，`git diff --check` 通过；仅出现仓库既有的 `vite-tsconfig-paths` 迁移提示。

---

### Task 5: 实现全局只读 EvolutionDashboard

**Files:**
- Create: `frontend/packages/client/ui-investment-research/src/client/evolution-types.ts`
- Create: `frontend/packages/client/ui-investment-research/src/client/EvolutionDashboard.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/EvolutionWorkspace.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- Modify: `frontend/packages/client/ui-investment-research/src/client/index.ts`
- Modify: `frontend/packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`
- Modify: `frontend/packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx`

**Interfaces:**
- Consumes: Task 2 全局 status/attribution 和 Task 4 `{ kind: 'evolution' }`。
- Produces: `EvolutionDashboardProps` 与 `EvolutionDashboard`，供 Task 6 Shell 导航装配。

- [x] **Step 1: 写看板只读红灯测试**

```tsx
it('全局看板只读取状态与归因且没有人工应用入口', async () => {
  const requestData = vi.fn(async ({ operation }: InvestmentDataRequest) => {
    if (operation === 'trading-core.evolution-status') return {
      closed_loop_enabled: false,
      lifecycle: {},
      per_strategy: [],
      recent_applied: [],
      counts: {},
    }
    if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
    throw new Error(`unexpected operation ${operation}`)
  })
  render(<EvolutionDashboard
    requestData={requestData}
    onAnalyze={() => {}}
    onOpenStrategy={() => {}}
  />)
  expect(await screen.findByText('策略演化链路')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '生成进化预案' })).toBeNull()
  expect(screen.queryByRole('button', { name: '确认并应用' })).toBeNull()
  expect(requestData.mock.calls.map(([request]) => request.operation)).toEqual([
    'trading-core.evolution-status',
    'trading-core.evolution-attribution',
  ])
})
```

另加闭环关闭文案测试，断言“自动闭环未启用”且不出现“正在每日自动运行”。

- [x] **Step 2: 运行看板红灯测试**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx \
  packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx
```

Expected: FAIL，当前页面仍包含作用域切换和人工 preview/run。

- [x] **Step 3: 创建 EvolutionDashboard**

先创建不依赖 React 组件的共享类型：

```ts
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'

export type EvolutionRequestData = (request: InvestmentDataRequest) => Promise<unknown>

export type EvolutionLifecycleGroup =
  | '' | 'active' | 'candidate' | 'mutated' | 'retired' | 'watch' | 'rejected'
```

看板接口：

```ts
export interface EvolutionDashboardProps {
  readonly requestData: EvolutionRequestData
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onOpenStrategy: (strategyId: string, returnGroup?: EvolutionLifecycleGroup) => void
  readonly onOpenStock?: (code: string) => void
  readonly initialLifecycleGroup?: EvolutionLifecycleGroup
}
```

从远端看板迁移：闭环状态、生命周期分组、策略现状、仅生效策略及母链、最近自动进化。策略行、链路节点和历史动作调用 `onOpenStrategy`；股票 chip 调用 `onOpenStock`。

- [x] **Step 4: 实现闭环状态文案**

```ts
const closedLoopEnabled = statusRecord.closed_loop_enabled === true
const title = closedLoopEnabled ? '自进化 · 自动闭环' : '自进化 · 闭环看板'
const description = closedLoopEnabled
  ? '系统按计划统一执行影子验证、归因、进化应用与候选验证'
  : '自动闭环未启用；当前仅展示已有证据、判定与执行历史'
```

AI 按钮发送 `{ kind: 'evolution' }`，标题为“AI 解释当前判定”。

- [x] **Step 5: 收缩 EvolutionWorkspace 兼容出口**

`EvolutionWorkspace.tsx` 不再保留 preview/run 状态机，迁移期只做 re-export：

```ts
export { EvolutionDashboard, EvolutionDashboard as EvolutionPage } from './EvolutionDashboard.tsx'
```

Task 6 创建诊断文件后再补导出；不得留下可达的人工应用 UI。

- [x] **Step 6: 合入样式并保持响应式**

迁移远端生命周期、策略详情、链路和时间线样式；继续使用主题 token。按组件容器实现 1280、650、500px 布局，不用 `overflow-x: hidden` 掩盖溢出。

- [x] **Step 7: 运行看板绿灯测试**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx \
  packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx
```

Expected: 看板测试 PASS；没有 evolution-preview/run 调用。

- [x] **Step 8: 检查点（不提交）**

```bash
git diff --check
```

Expected: PASS。

**执行记录（2026-09-01）：** 经用户授权，基线不存在但 ee40 中为未跟踪文件的 `EvolutionWorkspace.tsx` 与 `evolution-entry.client.spec.tsx` 按 Create 处理。全局 `EvolutionDashboard` 已独立只读 status/attribution，策略现状、生命周期、母子链与自动历史均可进入策略诊断；闭环关闭时明确显示只读观测文案。计划绿灯命令共 24 项通过，`git diff --check` 通过；复用既有响应式主题样式，未新增人工 preview/run 入口。

---

### Task 6: 实现看板跳转与单策略只读诊断

**Files:**
- Create: `frontend/packages/client/ui-investment-research/src/client/StrategyEvolutionDiagnostics.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/evolution-types.ts`
- Modify: `frontend/packages/client/ui-investment-research/src/client/EvolutionWorkspace.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx`
- Modify: `frontend/packages/client/ui-investment-research/src/client/state.ts`
- Modify: `frontend/packages/client/ui-investment-research/src/client/index.ts`
- Modify: `frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css`
- Modify: `frontend/packages/client/ui-investment-research/tests/state.client.spec.ts`
- Modify: `frontend/packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx`
- Modify: `frontend/packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`

**Interfaces:**
- Consumes: Task 2 scoped status/attribution、Task 4 单策略 AI intent、Task 5 `onOpenStrategy`。
- Produces: `StrategyEvolutionDiagnosticsProps`、受控 `strategyStage` 导航和返回看板路径。

- [x] **Step 1: 写导航状态红灯测试**

```ts
export type StrategyResearchStage = 'form' | 'backtest' | 'shadow' | 'evolution'

export interface InvestmentNavigationContext {
  readonly stockCode?: string
  readonly strategyId?: string
  readonly strategyStage?: StrategyResearchStage
  readonly evolutionReturnGroup?: EvolutionLifecycleGroup
}
```

```ts
it('从自进化看板携带策略和第4阶段进入策略研究', () => {
  const state = new InvestmentUiState()
  state.navigate('framework', {
    strategyId: 'strat-a',
    strategyStage: 'evolution',
    evolutionReturnGroup: 'retired',
  })
  expect(state.getSnapshot()).toMatchObject({
    route: 'framework',
    selectedStrategyId: 'strat-a',
    strategyResearchStage: 'evolution',
    evolutionReturnGroup: 'retired',
  })
})
```

- [x] **Step 2: 写单策略重新评估红灯测试**

```tsx
it('重新评估只读取当前策略且不调用 preview/run', async () => {
  const requestData = vi.fn(async ({ operation, input }: InvestmentDataRequest) => {
    expect(input).toEqual({ strategy_id: 'strat-a' })
    if (operation === 'trading-core.evolution-status') return {
      as_of: '2026-09-01 12:00:00',
      closed_loop_enabled: true,
      lifecycle: { active: [{ strategy_id: 'strat-a' }] },
      per_strategy: [{ strategy_id: 'strat-a', decision: 'none' }],
      recent_applied: [],
    }
    if (operation === 'trading-core.evolution-attribution') return { overall: {}, strategies: [] }
    throw new Error(`unexpected operation ${operation}`)
  })
  render(<StrategyEvolutionDiagnostics
    requestData={requestData}
    strategyId="strat-a"
    strategyLabel="策略 A"
    strategyStatus="active"
    onAnalyze={() => {}}
    onBack={() => {}}
  />)
  fireEvent.click(await screen.findByRole('button', { name: '重新评估' }))
  await waitFor(() => expect(requestData).toHaveBeenCalledTimes(4))
  expect(requestData.mock.calls.every(([request]) => (
    ['trading-core.evolution-status', 'trading-core.evolution-attribution'].includes(request.operation)
    && request.input?.strategy_id === 'strat-a'
  ))).toBe(true)
})
```

另加 retired 策略只读测试：存在历史和返回按钮，但没有“重新评估”。

- [x] **Step 3: 运行导航与诊断红灯**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/state.client.spec.ts \
  packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx
```

Expected: FAIL，缺少导航字段和新诊断组件。

- [x] **Step 4: 扩展 InvestmentUiState**

snapshot 增加：

```ts
readonly strategyResearchStage: StrategyResearchStage
readonly evolutionReturnGroup: EvolutionLifecycleGroup
```

默认分别为 `form` 和空字符串。带 `strategyStage` 的显式导航更新阶段；普通侧栏进入策略研究重置为 `form`。返回 tasks 时保留 `evolutionReturnGroup`。

- [x] **Step 5: 创建 StrategyEvolutionDiagnostics**

```ts
export interface StrategyEvolutionDiagnosticsProps {
  readonly requestData: EvolutionRequestData
  readonly strategyId: string
  readonly strategyLabel: string
  readonly strategyStatus: string
  readonly archived?: boolean
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onBack: () => void
  readonly onOpenStock?: (code: string) => void
}
```

组件加载和“重新评估”都只读取 scoped status/attribution。展示当前生命周期、预计判定、影子证据、阈值理由、母子链、最近自动应用、`as_of` 和下次运行时间。只有 active 且未归档策略显示“重新评估”；AI 发送 `{ kind: 'evolution', strategyId }`。

- [x] **Step 6: 装配 StrategyResearchPage**

- 第 4 步标题改为“进化诊断”，描述改为“查看当前策略判定并按最新证据重新评估；动作由统一闭环执行”。
- 从看板携带 `initialStage="evolution"` 时直接进入，不显示旧教育弹窗。
- 用户在策略研究内手动首次点击第 4 步时保留教育弹窗，但文案改成只读诊断和统一闭环，不再出现人工确认。
- 候选、退役、拒绝和归档策略通过 deep-link 进入只读诊断，不自动退出第 4 步。
- “返回自进化看板”调用 `onBack()`。

- [x] **Step 7: 装配 InvestmentShell**

```tsx
<EvolutionDashboard
  requestData={requestData}
  onAnalyze={prepareAssistant}
  initialLifecycleGroup={snapshot.evolutionReturnGroup}
  onOpenStrategy={(strategyId, group) => {
    navigate('framework', {
      strategyId,
      strategyStage: 'evolution',
      evolutionReturnGroup: group,
    })
  }}
/>
```

策略研究接收 `snapshot.strategyResearchStage`，返回时执行 `navigate('tasks', { evolutionReturnGroup: snapshot.evolutionReturnGroup })`。

- [x] **Step 8: 迁移旧测试语义**

- 删除或重写侧栏作用域切换器测试。
- 删除人工生成、AI 复核预案和确认应用的页面测试。
- 保留后端兼容接口测试。
- 更新教育弹窗为只读诊断文案；dashboard deep-link 必须绕过弹窗。
- 增加看板 → 非 active 策略只读诊断 → 返回看板测试。

- [x] **Step 9: 运行导航与诊断绿灯**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/state.client.spec.ts \
  packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx
```

Expected: 全部 PASS；请求日志无 `trading-core.evolution-preview` 或 `trading-core.evolution-run`。

- [x] **Step 10: 检查点（不提交）**

```bash
git diff --check
git diff --cached --name-only
```

Expected: `git diff --check` 退出码 0；暂存区为空。

**执行记录（2026-09-01）：** `InvestmentUiState` 已支持受控第 4 阶段与看板返回分组；看板 deep-link 可直接进入候选、退役等单策略只读诊断，策略研究内手动进入仍保留只读教育提示。加载与“重新评估”均只请求同一 `strategy_id` 的 status/attribution，active 未归档策略之外不展示重新评估，AI intent 同样携带 scoped 标识。计划绿灯命令共 32 项通过，`git diff --check` 通过且暂存区为空。

---

### Task 7: 更新文档、回归矩阵和迁移说明

**Files:**
- Modify: `backend/dsh-trading-core/docs/API-接口文档.md`
- Modify: `backend/dsh-trading-core/docs/前端接入指南.md`
- Modify: `frontend/packages/investment-research/stock-analysis/README.zh.md`
- Modify: `docs/prd/0.1.0-rc.7/04-验收发布/03-回归测试矩阵.md`
- Modify: `docs/prd/0.1.0-rc.7/04-验收发布/04-需求追踪矩阵.md`

**Interfaces:**
- Consumes: Task 2～6 的最终合同和页面行为。
- Produces: 自动闭环、全局看板、单策略诊断和只读重新评估的验收依据。

- [x] **Step 1: 更新 API 文档**

写明全局 status 看板字段、scoped status/attribution、重新评估只读语义、`evolve_auto()` 统一写入，以及 preview/run 兼容状态。

- [x] **Step 2: 更新前端指南和 AI README**

记录看板全局读取、策略研究 scoped 读取、investment_context 不读 preview，以及受控 `strategyId`/`strategyStage` 导航。

- [x] **Step 3: 重写 PRD 回归场景**

用以下场景取代旧双入口人工确认验收：

- 看板无写入按钮且闭环开关文案准确。
- 生命周期、现状、链路和最近动作跳到正确策略。
- active 策略可只读重新评估，非 active 策略只读。
- 重新评估无 preview/run 或策略状态变化。
- 返回看板恢复生命周期分组。
- 自动闭环统一应用并留痕。

状态只能根据实际验证结果填写。

- [x] **Step 4: 更新需求追踪矩阵**

把 EVO、STRAT 和 CTX 关联到新规格、新计划、后端调度测试、前端导航测试和浏览器场景。旧设计与计划标记为历史证据。

- [x] **Step 5: 文档检查点**

```bash
rg -n "人工确认|确认并应用|策略池视角|单策略视角|evolution/preview" \
  backend/dsh-trading-core/docs/API-接口文档.md \
  backend/dsh-trading-core/docs/前端接入指南.md \
  frontend/packages/investment-research/stock-analysis/README.zh.md \
  docs/prd/0.1.0-rc.7/04-验收发布/03-回归测试矩阵.md \
  docs/prd/0.1.0-rc.7/04-验收发布/04-需求追踪矩阵.md
git diff --check
```

Expected: 命中内容只用于兼容接口或历史需求；`git diff --check` PASS。

**执行记录（2026-09-01）：** API、前端接入、AI 工具 README、回归矩阵和需求追踪矩阵已统一为“全局只读看板 + scoped 单策略诊断 + 唯一自动闭环”，preview/run 仅记录为兼容合同。经用户追加授权，新旧两组 Agent Note 双语文档已建立部分取代的双向链接并更新 i18n 哈希；命名配对校验 2 组一致。计划关键词检查无命中，`git diff --check` 通过。

---

### Task 8: 完整回归、构建和真实浏览器验收

**Files:**
- Test: `backend/dsh-trading-core/tests/test_evolution.py`
- Test: `backend/dsh-trading-core/tests/test_closed_loop.py`
- Test: `backend/dsh-trading-core/tests/test_config_precedence.py`
- Test: `frontend/packages/client/ui-investment-research/tests/state.client.spec.ts`
- Test: `frontend/packages/client/ui-investment-research/tests/product-pages.client.spec.tsx`
- Test: `frontend/packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx`
- Test: `frontend/packages/client/ui-investment-research/tests/assistant-intent.client.spec.ts`
- Test: `frontend/packages/investment-research/stock-analysis/tests/client.spec.ts`
- Test: `frontend/packages/investment-research/stock-analysis/tests/plugin.spec.ts`

**Interfaces:**
- Consumes: Task 1～7 完整实现。
- Produces: 自动闭环、看板、诊断、AI、响应式和远端无关更新的最终证据。

- [x] **Step 1: 运行后端完整回归**

```bash
cd backend/dsh-trading-core
./env/bin/python -m unittest \
  tests.test_evolution \
  tests.test_closed_loop \
  tests.test_config_precedence -v
```

Expected: 全部 PASS。

- [x] **Step 2: 运行前端功能套件**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/state.client.spec.ts \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx \
  packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx \
  packages/client/ui-investment-research/tests/assistant-intent.client.spec.ts \
  packages/investment-research/stock-analysis/tests/client.spec.ts \
  packages/investment-research/stock-analysis/tests/plugin.spec.ts
```

Expected: 全部 PASS。

- [x] **Step 3: 运行共享 UI 与 KYC 回归**

```bash
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/research-workbench.client.spec.tsx \
  packages/client/ui-investment-research/tests/kyc-profile-panel.client.spec.tsx \
  packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx
```

Expected: 全部 PASS。

- [x] **Step 4: 验证远端无关更新未回退**

```bash
cd backend/market-watch
python -m unittest tests.test_quote_resolution tests.test_quotes_batch -v
cd ../../
pnpm --dir frontend exec vitest run \
  packages/client/ui-investment-research/tests/quote-polling.client.spec.tsx \
  packages/investment-research/python-runtime/tests/data.spec.ts
```

Expected: 行情批量报价、重试和运行时数据测试全部 PASS。

- [x] **Step 5: 运行构建、类型和样式门禁**

```bash
pnpm --dir frontend --filter @deepseek-ai/dsh-client-ui-investment-research run bundle
pnpm --dir frontend run typecheck:contracts-ready
pnpm --dir frontend run verify-client-theme-styles
git diff --check
```

Expected: 分别记录退出码。主题门禁若命中继承问题，列出精确文件和行号，不宣称全绿，也不未经授权扩大范围。

- [x] **Step 6: 获得唯一端口授权并启动隔离服务**

执行前检查端口；不得默认复用正在运行的旧 3187，也不得操作 3080。获准端口若为 3187：

```bash
lsof -nP -iTCP:3187 -sTCP:LISTEN
DSH_HOME=/private/tmp/pa-investment-evolution-dashboard-dsh-home \
pnpm --dir frontend dsh --profile investment-research --host 127.0.0.1 --port 3187
```

Expected: 使用新隔离 DSH_HOME 加载最终 bundle。

- [x] **Step 7: 真实浏览器验收**

使用至少一条 active 和一条非 active 策略：

1. 看板展示闭环状态、生命周期、策略现状、链路和最近记录。
2. 页面没有作用域切换器、生成预案或确认按钮。
3. 闭环关闭时明确显示未启用，不宣称正在自动运行。
4. active 策略进入策略研究第 4 步，标题和请求绑定该策略。
5. “重新评估”只有 scoped status/attribution 请求且策略状态未变化。
6. AI 绑定同一 `strategy_id`，上下文不请求 preview。
7. 返回看板恢复原生命周期分组。
8. 非 active 策略进入只读诊断，没有重新评估按钮。
9. 1280、650、500px 下 `scrollWidth === clientWidth`。
10. 控制台无未解释 error/warn。

若隔离数据缺少 active 或非 active 策略，明确记录未覆盖项，不以空态冒充通过。

- [x] **Step 8: 停止本任务启动的隔离服务**

只停止 Step 6 启动的进程，确认授权端口释放；不得停止其他任务服务或 3080。

- [x] **Step 9: 最终只读审计**

```bash
git status --short
git diff --cached --name-only
git diff --check
git diff --stat
git rev-parse HEAD
git branch --show-current
```

Expected: 暂存区为空；HEAD 及分支或 Codex 托管 detached 状态符合调度方分配；未提交、推送、创建 PR 或清理 worktree。报告必须区分远端基线、当前功能修改和继承修改。

**执行记录（2026-09-01）：** 后端计划回归 39 项、前端功能 57 项、共享 UI/KYC 20 项、行情回归 10 项、报价轮询与运行时 27 项均通过；裸 `python` 因系统 Conda 的旧 `openai` 不符合 requirements 而在导入阶段失败，改用本 worktree 已授权隔离后端环境后通过。Host/Client/Web 完整构建、目标包 bundle 与 `typecheck:contracts-ready` 通过；主题样式门禁实际执行但仍命中 `InvestmentShell.module.css` 第 860、1255、1256、1276、1278、1494 行共 8 处基线继承的未声明 token，按计划未扩大范围且不宣称该门禁全绿。用户授权独占 3287，隔离服务最终启动并在验收后停止，端口已释放；未操作 3080 或旧 3187。真实浏览器确认闭环关闭文案、只读按钮集合、全局 AI 只读提示、1280/650/500px 无横向溢出且控制台无 warn/error；隔离数据无 active 或非 active 策略，因此看板到两类策略诊断、scoped 重新评估、返回分组与 scoped AI 的真实浏览器场景未覆盖，不以空态冒充通过，其组件/合同回归已通过。最终暂存区为空，HEAD 保持 `ca34626304d05678b02ee6e943213057885efe2e` 的 Codex 托管 detached 状态，未提交、推送、创建 PR 或清理 worktree。

**基线重放执行记录（2026-09-01）：** 经用户授权，将 Codex 托管 detached `HEAD` 三方更新到最新 `public/master` `aa6195d5f35d63c4cc43b13531ee7147fee44045`。`InvestmentShell.tsx` 保留主干聊天式投研与 `prepareAssistantWithoutReturn`，同时保留看板到策略研究第 4 步的导航；runtime 与 stock-analysis 两处测试冲突均保留主干会话上下文用例和本计划 scoped evolution 用例。按 TDD 将 evolution scoped 安全标识与主干策略修订合同统一为允许 `@`，后端目标红灯为 422、两个前端目标红灯均在网络前拒绝，最小实现后全部转绿。重放后后端计划回归 39 项、前端功能 60 项、共享 UI/KYC 31 项、报价轮询与运行时 37 项、行情隔离环境回归 10 项均通过；目标 bundle、`typecheck:contracts-ready`、Host/Client/Web 构建及主题样式门禁全部通过。沿用用户为本 Task 8 授权的独占 3287 完成隔离浏览器复验并释放端口；看板只读边界、闭环关闭文案、AI 只读提示、1280/650/500px 无横向溢出及空控制台通过，隔离数据仍无 active 或非 active 策略，相关真实深链场景继续明确为未覆盖。

**提交前冲突审计执行记录（2026-09-01）：** 两轮只读代码审查发现并修复作用域与呈现缺口：单策略诊断禁止回退其他策略或全局归因，缺少目标证据时不渲染伪默认判定；目标作为母策略时保留子策略链路及自动变异历史；重叠生命周期按 `retired/rejected/watch/candidate/active/mutated` 明确优先，重新评估只依据本次 scoped status 的 active 状态；全局看板展示逐策略归因、成交与股票入口；看板各入口携带当前生命周期返回分组。后端在任何存储访问前校验 scoped 标识，单策略生命周期计数只统计目标策略本身。新增红灯分别稳定复现旧行为，最小实现后后端计划回归 40 项、前端功能 63 项、共享 UI/KYC 31 项、行情隔离环境 10 项、报价轮询单独复验 3 项和运行时其余 34 项均通过；系统 Conda Python 仍因旧版 `openai` 导入失败，隔离环境复验通过。目标 bundle、`typecheck:contracts-ready`、Host/Client/Web 构建、主题样式门禁及 `git diff --check` 均通过。

**发布前基线核对记录（2026-09-01）：** 创建提交前再次抓取发现 `public/master` 从 `aa6195d5f35d63c4cc43b13531ee7147fee44045` 前移到 `4c955c971bdecef65129c779d65b10ca0ad26af2`；只读审计确认新增内容仅将 `backend/dsh-trading-core/adapter/scheduler.py` 的闭环事件生成超时从 4 秒调整为 20 秒，本任务未修改该文件。Codex 托管 detached `HEAD` 已 fast-forward 到同一最新基线，保留远端 scheduler 更新且无冲突；随后后端 evolution/closed-loop/config 40 项重新通过，scheduler 相对 `public/master` 无差异。

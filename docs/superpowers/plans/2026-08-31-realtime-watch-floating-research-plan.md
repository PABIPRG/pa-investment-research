# 实时盯盘悬浮研究窗实施计划

> **面向智能体执行者：** 必须使用 <code>superpowers:subagent-driven-development</code>（推荐）或 <code>superpowers:executing-plans</code> 逐任务执行，并使用 <code>superpowers:test-driven-development</code> 完成测试先行循环。每个步骤使用复选框跟踪。

**目标：** 交付 0.1.0-rc.9 实时盯盘改造：修复指数、扫描和北交所 K 线根因，以固定右侧悬浮研究窗承载证券详情，并保证移动端、AI 助理、资讯归属和异步切股行为可验收。

**架构：** 后端以统一证券市场事实生成供应商代码，以结构化状态表达指数、扫描、K 线和个股资讯的可用性；投资运行时只暴露固定白名单操作。前端由 Shell 级右侧表面协调器管理研究窗与 AI 助理，研究内容使用按操作和证券键隔离的有界资源仓库，扫描页只发出打开详情或分析意图。

**技术栈：** Python 3、FastAPI、pandas、unittest、TypeScript、React 18、CSS Modules、Vitest、Testing Library、DSH 投资运行时与 market-watch DSH 插件。

**规格：** [实时盯盘悬浮研究窗技术设计](../specs/2026-08-31-realtime-watch-floating-research-design.md)

## 全局约束

- 实现必须覆盖 <code>WATCH-011</code> 至 <code>WATCH-023</code>，且保持既有 <code>market-watch.indices</code>、<code>market-watch.scan</code>、成功态 <code>market-watch.tech-signal</code> 和 <code>stock-detail</code> 路由兼容。
- 首次进入实时盯盘只能请求指数和扫描；不得自动选择榜首，不得预取技术信号、个股资讯或证券详情。
- 研究窗固定在右侧，不挤压主页面，不支持拖动或自由缩放；不大于 900px 时派生为模态覆盖层。
- 研究窗与 AI 助理共用右侧展开区域并互斥；历史抽屉和报告中心继续拥有更高层的按键处理优先级。
- 所有浏览器数据请求继续经过 <code>InvestmentDataOperation</code> 固定白名单，不允许调用方传入 origin、URL 或路径。
- 外部源故障测试必须使用桩或故障注入；真实网络烟测只验证可诊断降级，不作为唯一门禁。
- 不触碰或清理现有 <code>.superpowers/</code> 视觉评审产物，也不覆盖来源不明或与本任务无关的工作区改动。
- 本计划中的提交步骤只是执行检查点，不构成提交授权。当前未获得 commit、push 或 PR 授权；未收到用户明确授权时跳过所有提交命令。若后续获准提交，先在本 Codex worktree 创建 <code>codex/realtime-watch-floating-research</code>，AI 提交信息必须以 <code>[AI] </code> 开头。
- 每个实现任务都遵循：新增一个失败测试、确认它因目标行为缺失而失败、实现最小责任单元、运行聚焦测试、再运行相邻回归。

## 文件结构映射

| 层级 | 现有文件 | 计划新增或重点修改 |
|---|---|---|
| 市场身份 | <code>backend/market-watch/market_watch/quotes.py</code> | 新建 <code>market_identity.py</code>，统一 sh/sz/bj 与供应商代码 |
| K 线状态 | <code>quotes.py</code>、<code>app.py</code>、<code>config.py</code> | 新增结构化 K 线读取结果、失败短缓存和 202/200 领域状态 |
| 指数可靠性 | <code>briefs.py</code>、<code>app.py</code> | 新建 <code>normalization.py</code>，增加逐项有限数清理和最近有效项缓存 |
| 扫描可靠性 | <code>scanner.py</code>、<code>quotes.py</code>、<code>app.py</code> | 来源能力表、来源诊断、扫描条件缓存和 422/503 分类 |
| 个股资讯 | <code>news.py</code>、<code>app.py</code> | 结构化个股资讯快照与 <code>GET /news/stock</code> |
| 固定运行时 | <code>frontend/packages/investment-research/python-runtime/src/types.ts</code>、<code>data.ts</code> | 新增 <code>market-watch.security-news</code> 并验证 202 JSON 透传 |
| 前端资源层 | <code>InvestmentShell.tsx</code> 内现有 <code>useRequestResource</code> | 新建 <code>research-resource.ts</code>，只服务证券研究按键资源 |
| 前端研究窗 | <code>InvestmentShell.tsx</code>、<code>InvestmentShell.module.css</code> | 新建 <code>research-types.ts</code>、<code>ResearchFloatingSurface.tsx</code>、<code>SecurityResearchContent.tsx</code> |
| 扫描页集成 | <code>InvestmentShell.tsx</code> | 删除常驻详情区和自动选择，扫描项拆分主体、详情、智能分析操作 |
| AI 协作 | <code>InvestmentShell.tsx</code>、<code>state.ts</code> | Shell 内存协调状态、返回证券详情和直接关闭后的最小化恢复 |
| DSH 消费者 | <code>backend/market-watch/dsh-plugin/src/index.ts</code>、<code>render.ts</code> | 技术信号三状态 schema 与渲染 |
| 验收与文档 | PRD、API 文档、前端版本 | 需求追踪证据、0.1.0-rc.9 品牌版本和完整回归 |

---

### Task 1：统一证券市场识别并修复北交所映射

**覆盖需求：** <code>WATCH-021</code>

**文件：**

- 新建：<code>backend/market-watch/market_watch/market_identity.py</code>
- 新建：<code>backend/market-watch/tests/test_market_identity.py</code>
- 修改：<code>backend/market-watch/market_watch/quotes.py</code>

**接口：**

~~~python
from typing import Literal

Market = Literal["sh", "sz", "bj"]

def resolve_market(code: str) -> Market: ...
def sina_symbol(code: str) -> str: ...
def eastmoney_secid(code: str) -> str: ...
def baostock_code(code: str) -> str: ...
~~~

<code>resolve_market</code> 的判断顺序固定为北交所 <code>92/4/8</code>、沪市 <code>6/5/9</code>、深市 <code>0/1/2/3</code>。<code>baostock_code</code> 对北交所抛出可识别的 <code>UnsupportedProviderMarket</code>，调用链跳过该源而不是改用沪市代码。

- [ ] **步骤 1：写失败测试锁定 920223 和各供应商标识**

测试至少断言：

~~~python
self.assertEqual(resolve_market("920223"), "bj")
self.assertEqual(sina_symbol("920223"), "bj920223")
self.assertEqual(eastmoney_secid("920223"), "0.920223")
with self.assertRaises(UnsupportedProviderMarket):
    baostock_code("920223")
self.assertEqual(sina_symbol("600519"), "sh600519")
self.assertEqual(sina_symbol("000001"), "sz000001")
~~~

- [ ] **步骤 2：运行测试并确认缺少统一模块**

运行：

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_market_identity -v
~~~

预期：失败并报告无法导入 <code>market_watch.market_identity</code>，证明测试没有误命中旧的分散规则。

- [ ] **步骤 3：实现市场事实并替换旧映射**

在 <code>quotes.py</code> 中让 <code>_sina_sym</code>、<code>_secid</code> 和 <code>_bs_code</code> 委托新模块；搜索结果的市场标签也从 <code>resolve_market</code> 生成。北交所进入 K 线供应商链时按“新浪 → 东财 → 跳过 baostock”执行。

- [ ] **步骤 4：运行聚焦测试和证券 API 回归**

运行：

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_market_identity tests.test_security_api -v
~~~

预期：映射测试和现有证券搜索、详情合同全部通过。

- [ ] **步骤 5：如已获提交授权，提交单一根因修复**

~~~bash
git add backend/market-watch/market_watch/market_identity.py backend/market-watch/market_watch/quotes.py backend/market-watch/tests/test_market_identity.py
git commit -m "[AI] 修复北交所行情代码映射"
~~~

---

### Task 2：把 K 线冷请求改为可轮询的领域生命周期

**覆盖需求：** <code>WATCH-018</code>、<code>WATCH-021</code>、<code>WATCH-022</code>

**文件：**

- 修改：<code>backend/market-watch/market_watch/quotes.py</code>
- 修改：<code>backend/market-watch/market_watch/config.py</code>
- 修改：<code>backend/market-watch/market_watch/app.py</code>
- 修改：<code>backend/market-watch/tests/test_kline_latency.py</code>
- 修改：<code>backend/market-watch/tests/test_security_api.py</code>

**接口：**

~~~python
@dataclass(frozen=True)
class KlineRead:
    status: Literal["ready", "preparing", "unavailable"]
    frame: pd.DataFrame | None = None
    stale: bool = False
    as_of: str | None = None
    retry_after_ms: int | None = None
    reason_code: str | None = None
    message: str | None = None

def read_kline(code: str, lookback: int = 120) -> KlineRead: ...
~~~

保留 <code>get_kline</code> 作为内部兼容包装：ready 返回 DataFrame，preparing 继续抛现有 <code>KlineDeadlineExceeded</code>，unavailable 返回 None。Web 路由和独立详情改用 <code>read_kline</code>，从而不再把前台预算耗尽当作最终故障。

- [ ] **步骤 1：扩展失败测试覆盖后台四种结局**

在 <code>test_kline_latency.py</code> 增加以下用例：

- 冷 flight 超过预算返回 <code>preparing</code>，且六个并发请求仍只有一个源调用；
- 后台完成后同键下一次读取返回 <code>ready</code>；
- 后台返回空或异常后写入短时 <code>unavailable</code>，短缓存期内不重启供应商链；
- 有 stale 成功缓存时刷新失败仍返回旧数据和原始 <code>as_of</code>。

在 <code>test_security_api.py</code> 把旧的 504 断言改为：

~~~python
response = client.post("/tech-signal", json={"code": "600519", "lookback": 120})
self.assertEqual(response.status_code, 202)
self.assertEqual(response.json()["status"], "preparing")
self.assertIn("retry_after_ms", response.json())
~~~

并新增 ready 与 unavailable 的 200 合同测试。

- [ ] **步骤 2：运行测试并确认旧 504/None 行为导致失败**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_kline_latency tests.test_security_api -v
~~~

预期：preparing 用例收到旧异常或 504；负缓存用例观察到重复源调用。

- [ ] **步骤 3：实现结构化结果、负缓存和回调写入**

在 <code>config.py</code> 增加有界配置：

~~~python
self.kline_failure_ttl = float(os.getenv("MW_KLINE_FAILURE_TTL", "30"))
self.kline_failure_cache_size = int(os.getenv("MW_KLINE_FAILURE_CACHE_SIZE", "128"))
self.kline_retry_after_ms = int(os.getenv("MW_KLINE_RETRY_AFTER_MS", "1500"))
~~~

在 <code>quotes.py</code> 中以 <code>(code, lookback)</code> 为键维护成功缓存、single-flight 和 LRU 失败缓存。future 回调必须原子地写入成功或失败终态、移除 flight 并释放准入信号量；存在合格 stale 成功数据时，不让负缓存遮蔽它。

- [ ] **步骤 4：稳定映射 FastAPI 状态**

<code>POST /tech-signal</code>：

- ready：HTTP 200，保留 <code>code/name/as_of/bars/last/indicators/signals</code> 并增加 <code>status/stale</code>；
- preparing：HTTP 202，返回 <code>status/code/as_of/retry_after_ms/message</code>；
- unavailable：HTTP 200，返回 <code>status/code/as_of/reason_code/message/retryable</code>；
- 输入错误：HTTP 422。

- [ ] **步骤 5：运行并发、API 和北交所聚焦回归**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_market_identity tests.test_kline_latency tests.test_security_api -v
~~~

预期：所有测试通过；preparing 期间 flight 数不增长；920223 不进入 baostock。

- [ ] **步骤 6：如已获提交授权，提交 K 线生命周期**

~~~bash
git add backend/market-watch/market_watch/quotes.py backend/market-watch/market_watch/config.py backend/market-watch/market_watch/app.py backend/market-watch/tests/test_kline_latency.py backend/market-watch/tests/test_security_api.py
git commit -m "[AI] 增加技术信号准备与终态合同"
~~~

---

### Task 3：保证指数响应始终是合法 JSON 并支持逐项缓存

**覆盖需求：** <code>WATCH-019</code>、<code>WATCH-022</code>

**文件：**

- 新建：<code>backend/market-watch/market_watch/normalization.py</code>
- 新建：<code>backend/market-watch/tests/test_indices_reliability.py</code>
- 修改：<code>backend/market-watch/market_watch/briefs.py</code>
- 修改：<code>backend/market-watch/market_watch/config.py</code>
- 修改：<code>backend/market-watch/market_watch/app.py</code>
- 修改：<code>backend/market-watch/tests/test_security_api.py</code>

**接口：**

~~~python
def finite_number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None

def indices_snapshot() -> dict:
    return {"as_of": ..., "items": ..., "stale": ..., "warnings": ...}
~~~

- [ ] **步骤 1：写失败测试注入 NaN、正负无穷和局部缺失**

用 FastAPI TestClient 调用真实 <code>GET /indices</code> 响应边界，断言：

- 响应状态 200 且 <code>response.json()</code> 可解析；
- 非有限字段为 null；
- 同批次合法指数仍保留；
- 第二次源失败时，合格缓存项保留旧 <code>as_of</code> 且 <code>stale=true</code>。

- [ ] **步骤 2：运行测试并复现 Starlette 序列化失败**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_indices_reliability -v
~~~

预期：旧实现对 NaN/Inf 返回 500 或直接抛出 <code>Out of range float values are not JSON compliant</code>。

- [ ] **步骤 3：实现有限数边界和按指数代码缓存**

<code>indices_snapshot</code> 逐行清理数值；缓存只保存具备代码、名称和至少一个有效数值的项，容量固定为四个主指数，陈旧窗口由 <code>MW_INDICES_STALE_TTL</code> 控制，默认 300 秒。读取缓存不得重写事实时间。

- [ ] **步骤 4：让简报兼容使用清理后的列表**

<code>indices_spot()</code> 继续返回列表供简报调用，但其内容必须来自同一归一化路径；<code>GET /indices</code> 使用结构化 <code>indices_snapshot()</code>。

- [ ] **步骤 5：运行指数、证券 API 与简报相邻测试**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_indices_reliability tests.test_security_api tests.test_health_contract -v
~~~

预期：所有响应均为合法 JSON，既有指数主要字段保持不变。

- [ ] **步骤 6：如已获提交授权，提交指数边界修复**

~~~bash
git add backend/market-watch/market_watch/normalization.py backend/market-watch/market_watch/briefs.py backend/market-watch/market_watch/config.py backend/market-watch/market_watch/app.py backend/market-watch/tests/test_indices_reliability.py backend/market-watch/tests/test_security_api.py
git commit -m "[AI] 增强指数数据的局部降级"
~~~

---

### Task 4：为市场扫描增加来源能力、最近成功缓存和正确错误分类

**覆盖需求：** <code>WATCH-020</code>、<code>WATCH-022</code>

**文件：**

- 新建：<code>backend/market-watch/tests/test_scanner_reliability.py</code>
- 修改：<code>backend/market-watch/market_watch/scanner.py</code>
- 修改：<code>backend/market-watch/market_watch/quotes.py</code>
- 修改：<code>backend/market-watch/market_watch/config.py</code>
- 修改：<code>backend/market-watch/market_watch/app.py</code>
- 修改：<code>backend/market-watch/tests/test_security_api.py</code>

**接口：**

~~~python
class MarketDataUnavailable(RuntimeError):
    pass

SCAN_CAPABILITIES = {
    "gainers": ("eastmoney", "sina"),
    "volume_ratio": ("eastmoney",),
    "limit": ("eastmoney", "sina"),
    "turnover": ("eastmoney", "sina"),
    "amount": ("eastmoney", "sina"),
}
~~~

扫描成功响应增加可选 <code>source/stale/complete/warnings</code>，仍保留每种 kind 的原主要字段。

- [ ] **步骤 1：写失败测试区分参数错误、备用源、缓存和 503**

测试以下确定性场景：

- 非法 kind 仍为 422；
- 东财断连且新浪支持时返回 200、<code>source=sina</code> 和降级 warning；
- limit 使用新浪双向榜并标记 <code>complete=false</code>；
- volume_ratio 主源失败时不伪造新浪结果；
- 同键先成功后全源失败时返回旧 <code>as_of</code>、<code>stale=true</code>；
- 全源失败且无缓存时路由返回 503。

- [ ] **步骤 2：运行测试并确认旧实现把源故障映射为 422**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_scanner_reliability -v
~~~

预期：旧路由对上游失败返回 422，且响应没有 source/stale/complete。

- [ ] **步骤 3：让 quotes 返回来源事实而不是吞掉回退路径**

把 <code>_scan_rows</code> 改为返回类似以下结构，不在 quotes 层丢失实际来源：

~~~python
@dataclass(frozen=True)
class ScanRows:
    rows: list[dict]
    source: Literal["eastmoney", "sina"]
    complete: bool
    warnings: tuple[str, ...] = ()
~~~

limit 的新浪回退分别按涨跌幅降序和升序取样，再使用既有涨跌停规则过滤；量比没有备用源。

- [ ] **步骤 4：实现扫描条件 LRU 缓存和日志**

缓存键包含 <code>kind/top_n/min_amount_yi</code>，默认 fresh 15 秒、stale 300 秒、最多 64 项。命中 stale 时保留原 <code>as_of</code>。日志记录 kind、来源、异常类别、耗时、回退路径和缓存命中，不记录响应正文或代理凭据。

- [ ] **步骤 5：修正 app 的 HTTP 映射**

只把输入 <code>ValueError</code> 映射为 422；<code>MarketDataUnavailable</code> 映射为 503。正常空榜单仍是 200 空状态。

- [ ] **步骤 6：运行扫描、机会首屏和安全 API 回归**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_scanner_reliability tests.test_opportunity_latency tests.test_security_api -v
~~~

预期：所有测试通过，备用源缺失字段保持 null。

- [ ] **步骤 7：如已获提交授权，提交扫描恢复能力**

~~~bash
git add backend/market-watch/market_watch/scanner.py backend/market-watch/market_watch/quotes.py backend/market-watch/market_watch/config.py backend/market-watch/market_watch/app.py backend/market-watch/tests/test_scanner_reliability.py backend/market-watch/tests/test_security_api.py
git commit -m "[AI] 增加市场扫描来源降级与缓存"
~~~

---

### Task 5：新增与证券绑定的结构化资讯端点

**覆盖需求：** <code>WATCH-017</code>、<code>WATCH-022</code>

**文件：**

- 新建：<code>backend/market-watch/tests/test_stock_news_api.py</code>
- 修改：<code>backend/market-watch/market_watch/news.py</code>
- 修改：<code>backend/market-watch/market_watch/config.py</code>
- 修改：<code>backend/market-watch/market_watch/app.py</code>
- 修改：<code>backend/market-watch/tests/test_security_api.py</code>

**接口：**

~~~python
@dataclass(frozen=True)
class StockNewsSnapshot:
    status: Literal["ready", "stale", "unavailable"]
    code: str
    as_of: str
    items: tuple[dict, ...]
    complete: bool
    message: str | None = None

def stock_news_snapshot(code: str, limit: int = 8) -> StockNewsSnapshot: ...
~~~

FastAPI 路由使用 <code>Query(default=8, ge=5, le=20)</code> 校验 limit，并在进入资讯服务前调用 <code>quotes.normalize_code(code)</code>；两类输入错误均稳定返回 422。

- [ ] **步骤 1：写失败 API 合同测试**

测试 <code>GET /news/stock?code=600519&limit=8</code>：

- 请求代码归一化并原样出现在响应；
- 成功空列表是 <code>status=ready</code>，不是错误；
- 来源异常且有缓存时返回 <code>stale</code> 和旧时间；
- 来源异常且无缓存时返回 <code>unavailable</code>；
- 不能用市场快讯填充个股空列表；
- 非六位数字和越界 limit 返回 422。

- [ ] **步骤 2：运行测试并确认路由缺失**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_stock_news_api -v
~~~

预期：404 或导入失败。

- [ ] **步骤 3：重构个股资讯抓取并保留列表兼容包装**

把 AkShare 调用的“成功空”和“异常”分开；缓存按 <code>(code, limit)</code> 隔离，默认 fresh 60 秒、stale 300 秒、最多 64 项。旧 <code>fetch_stock_news(code, top)</code> 继续返回列表，供简报和兼容代码使用。

- [ ] **步骤 4：新增固定 GET 路由并复用到独立详情**

<code>security_detail</code> 从同一快照读取 items；preparing/unavailable 的技术结果写入 warnings 并保留 quote、fund flow 和 news。

- [ ] **步骤 5：运行个股资讯、定向新闻和证券详情回归**

~~~bash
cd backend/market-watch
env/bin/python -m unittest tests.test_stock_news_api tests.test_directed_news tests.test_security_api -v
~~~

预期：所有测试通过；个股空列表和全市场资讯没有混用。

- [ ] **步骤 6：如已获提交授权，提交个股资讯合同**

~~~bash
git add backend/market-watch/market_watch/news.py backend/market-watch/market_watch/config.py backend/market-watch/market_watch/app.py backend/market-watch/tests/test_stock_news_api.py backend/market-watch/tests/test_security_api.py
git commit -m "[AI] 新增证券关联资讯接口"
~~~

---

### Task 6：把个股资讯加入投资运行时固定白名单

**覆盖需求：** <code>WATCH-017</code>、<code>WATCH-018</code>

**文件：**

- 修改：<code>frontend/packages/investment-research/python-runtime/src/types.ts</code>
- 修改：<code>frontend/packages/investment-research/python-runtime/src/data.ts</code>
- 修改：<code>frontend/packages/investment-research/python-runtime/tests/data.spec.ts</code>

**接口：**

~~~ts
type InvestmentDataOperation =
  | 'market-watch.security-news'
  // 保留其他既有联合成员
~~~

同时新增固定证券代码校验器：

~~~ts
function securityCode(input: Record<string, unknown>, key = 'code'): string {
  const code = stringValue(input, key)
  if (!/^\d{6}$/.test(code)) {
    throw new TypeError('investment data: code must be exactly six digits')
  }
  return code
}
~~~

固定映射：

~~~ts
'market-watch.security-news': {
  backendId: 'market-watch',
  method: 'GET',
  path: input => query('/news/stock', {
    code: securityCode(input),
    limit: integer(input, 'limit', 8, 5, 20),
  }),
}
~~~

- [ ] **步骤 1：写失败测试固定 URL、输入边界和 202 透传**

在 <code>data.spec.ts</code> 增加：

- security-news 映射到编码后的固定 GET 路径；
- 未知键、非法代码和 limit 4/21 在 fetch 前失败；
- tech-signal 收到 HTTP 202 JSON 时原样 resolve；
- 每种成功或失败路径都释放 lease。

- [ ] **步骤 2：运行聚焦测试并确认操作不受支持**

~~~bash
pnpm --dir frontend exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts
~~~

预期：失败并报告 unsupported operation。

- [ ] **步骤 3：实现联合类型和 RequestSpec**

代码校验必须只接受六位数字证券代码，不能把任意 URL 或路径暴露给浏览器。保留 <code>response.ok</code> 逻辑，使 202 与 200 一样解析 JSON。

- [ ] **步骤 4：运行运行时数据与公开 API 测试**

~~~bash
pnpm --dir frontend exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts packages/investment-research/python-runtime/tests/public-api.spec.ts
~~~

预期：全部通过，lease 调用次数与请求次数一致。

- [ ] **步骤 5：如已获提交授权，提交固定运行时操作**

~~~bash
git add frontend/packages/investment-research/python-runtime/src/types.ts frontend/packages/investment-research/python-runtime/src/data.ts frontend/packages/investment-research/python-runtime/tests/data.spec.ts
git commit -m "[AI] 暴露固定个股资讯运行时操作"
~~~

---

### Task 7：实现按请求键隔离的有界证券研究资源仓库

**覆盖需求：** <code>WATCH-016</code>、<code>WATCH-018</code>、<code>WATCH-022</code>

**文件：**

- 新建：<code>frontend/packages/client/ui-investment-research/src/client/research-resource.ts</code>
- 新建：<code>frontend/packages/client/ui-investment-research/tests/research-resource.client.spec.ts</code>
- 修改：<code>frontend/packages/client/ui-investment-research/src/client/index.ts</code>（只在测试或其他组件需要公开类型时）

**接口：**

~~~ts
export type ResearchResourcePhase =
  | 'idle' | 'preparing' | 'ready' | 'refreshing' | 'stale' | 'unavailable'

export interface ResearchResourceSnapshot<T> {
  readonly phase: ResearchResourcePhase
  readonly value?: T
  readonly error: string
  readonly asOf?: string
}

export interface ResearchResourceStore {
  getSnapshot<T>(key: string): ResearchResourceSnapshot<T>
  read<T>(key: string, load: () => Promise<T>): Promise<T>
  peek<T>(key: string): T | undefined
  subscribe(key: string, listener: () => void): () => void
  invalidate(key: string): void
  schedule(owner: string, key: string, delayMs: number, callback: () => void): void
  clearTimers(owner: string): void
}

export function createResearchResourceStore(limit?: number): ResearchResourceStore
~~~

- [ ] **步骤 1：写纯资源层失败测试**

覆盖：

- 同键并发只调用一次 loader；
- A→B 时 A 晚到结果只写 A 缓存，不通知 B 当前视图；
- A→B→A 可复用 A flight 或缓存；
- 第 21 个证券键插入后淘汰最久未使用项；
- invalidate 后旧代次不能更新当前订阅；
- owner 清理会取消 preparing 轮询计时器。

- [ ] **步骤 2：运行测试并确认模块缺失**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/research-resource.client.spec.ts
~~~

预期：失败并报告无法解析 <code>research-resource.ts</code>。

- [ ] **步骤 3：实现 single-flight、代次和 LRU**

仓库只存本次 Shell 生命周期内的数据，不写 localStorage。键由调用方用稳定 JSON 序列化生成，至少包含 operation、code 和影响结果的参数。淘汰时不得删除仍有 flight 的键；flight 完成后再执行容量收敛。

- [ ] **步骤 4：运行资源层测试并检查无悬挂计时器**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/research-resource.client.spec.ts --reporter=verbose
~~~

预期：所有用例通过，Vitest 不报告未结束计时器或未处理 Promise。

- [ ] **步骤 5：如已获提交授权，提交资源仓库**

~~~bash
git add frontend/packages/client/ui-investment-research/src/client/research-resource.ts frontend/packages/client/ui-investment-research/tests/research-resource.client.spec.ts frontend/packages/client/ui-investment-research/src/client/index.ts
git commit -m "[AI] 增加证券研究按键资源仓库"
~~~

---

### Task 8：实现固定右侧悬浮研究窗外壳与可访问状态

**覆盖需求：** <code>WATCH-013</code>、<code>WATCH-014</code>、<code>WATCH-023</code>

**文件：**

- 新建：<code>frontend/packages/client/ui-investment-research/src/client/research-types.ts</code>
- 新建：<code>frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx</code>
- 新建：<code>frontend/packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx</code>
- 修改：<code>frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css</code>

**接口：**

~~~ts
export interface ResearchSubject {
  readonly code: string
  readonly name?: string
  readonly quote?: {
    readonly price?: number
    readonly pctChange?: number
    readonly volumeRatio?: number
    readonly amountYi?: number
  }
}

export type ResearchSurfaceMode = 'closed' | 'minimized' | 'docked' | 'expanded'

export type RequestData = (request: InvestmentDataRequest) => Promise<unknown>
~~~

<code>research-types.ts</code> 从投资运行时导入 <code>InvestmentDataRequest</code>，并接管当前 <code>InvestmentShell.tsx</code> 内部的 RequestData 别名。<code>ResearchFloatingSurface</code> 接收 mode、subject、触发元素 ref、模式回调和 children；不直接请求业务数据。

- [ ] **步骤 1：写失败组件测试固定四状态和语义**

测试：

- closed 不渲染；
- minimized 显示证券名称或代码恢复入口；
- desktop docked 使用 <code>role=complementary</code>；
- expanded 和不大于 900px 的 docked 使用 <code>role=dialog</code>、<code>aria-modal=true</code>；
- Escape 依次 expanded→docked、docked→closed；
- modal 状态限制焦点并锁背景，关闭后恢复 scrollTop 和触发焦点；
- 图标按钮有中文 aria-label，触控目标至少 44×44；
- CSS 中不存在拖动手柄或 resize。

- [ ] **步骤 2：运行测试并确认组件缺失**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx
~~~

预期：模块解析失败。

- [ ] **步骤 3：实现外壳、模式按钮与响应式模态判断**

桌面 docked 使用固定 <code>top:68px; right:24px; bottom:24px</code> 和约 <code>clamp(420px,42vw,620px)</code>；expanded 四边 16px。移动端在媒体查询和 <code>matchMedia</code> 两处都以 900px 为同一断点，不复制第二套事实状态。

- [ ] **步骤 4：实现滚动、焦点、inert 和减少动态效果**

模态进入时记录 <code>.pageScroll</code> 的 scrollTop、锁定 body、对主工作台设置 inert/aria-hidden；退出时先恢复滚动，再用 requestAnimationFrame 恢复焦点。<code>prefers-reduced-motion</code> 下关闭研究窗和遮罩的非必要动画。

- [ ] **步骤 5：运行组件测试和主题样式门禁**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx packages/client/ui-investment-research/tests/theme-styles.client.spec.ts
pnpm --dir frontend run verify-client-theme-styles
~~~

预期：组件测试通过，CSS 只使用既有语义 token。

- [ ] **步骤 6：如已获提交授权，提交悬浮窗外壳**

~~~bash
git add frontend/packages/client/ui-investment-research/src/client/research-types.ts frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css frontend/packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx
git commit -m "[AI] 实现响应式证券悬浮研究窗"
~~~

---

### Task 9：实现研究内容的技术状态、个股资讯和市场快讯标签

**覆盖需求：** <code>WATCH-016</code>、<code>WATCH-017</code>、<code>WATCH-018</code>、<code>WATCH-022</code>

**文件：**

- 新建：<code>frontend/packages/client/ui-investment-research/src/client/SecurityResearchContent.tsx</code>
- 新建：<code>frontend/packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx</code>
- 修改：<code>frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx</code>
- 修改：<code>frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css</code>

**接口：**

~~~ts
interface SecurityResearchContentProps {
  readonly subject: ResearchSubject
  readonly requestData: RequestData
  readonly resources: ResearchResourceStore
  readonly active: boolean
  onAnalyze(intent: AssistantIntent): void
  onOpenFullDetail(code: string): void
}
~~~

- [ ] **步骤 1：写失败测试固定区域独立性和资讯归属**

测试：

- 打开 A 后并行请求 A tech-signal 与 A security-news；
- 默认标签是“个股相关”，请求携带 A 代码；
- 市场快讯只在首次打开标签时请求，并显示“不特指当前证券”；
- A 个股资讯为空时显示专属空状态，不混入市场快讯；
- A→B 且 A 最后返回时，标题、技术信号和个股资讯仍属于 B；
- 一个区域失败时其他区域继续显示。

- [ ] **步骤 2：写技术 preparing 自动继续测试**

使用 fake timers 让第一次技术响应为：

~~~ts
{ status: 'preparing', code: '920223', retry_after_ms: 1500 }
~~~

断言界面显示中性“技术信号准备中”，推进 1500ms 后同键自动请求，ready 时无点击显示结果；切股、最小化关闭或卸载后不再轮询。unavailable 且无缓存才显示局部 alert 和手动重试。

- [ ] **步骤 3：运行测试并确认内容组件缺失**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx
~~~

预期：模块解析失败。

- [ ] **步骤 4：实现行情摘要、技术状态和资讯标签**

扫描项提供的 quote 立即显示；缺失值统一显示“—”。tech ready/stale 保留内容和事实时间，preparing 只安排 1–5 秒范围内的下一次读取，unavailable 不自动无限重试。市场快讯使用全局键，不包含证券代码。

- [ ] **步骤 5：运行内容、资源层和安全链接回归**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx packages/client/ui-investment-research/tests/research-resource.client.spec.ts packages/client/ui-investment-research/tests/data-pages.client.spec.tsx
~~~

预期：所有测试通过，外链仍只接受无凭据 HTTP(S)。

- [ ] **步骤 6：如已获提交授权，提交研究内容**

~~~bash
git add frontend/packages/client/ui-investment-research/src/client/SecurityResearchContent.tsx frontend/packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css frontend/packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx
git commit -m "[AI] 增加证券研究独立数据区域"
~~~

---

### Task 10：重构实时盯盘列表为显式打开研究

**覆盖需求：** <code>WATCH-011</code>、<code>WATCH-012</code>、<code>WATCH-013</code>

**文件：**

- 修改：<code>frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx</code>
- 修改：<code>frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css</code>
- 修改：<code>frontend/packages/client/ui-investment-research/tests/data-pages.client.spec.tsx</code>

**接口变化：**

~~~ts
interface OpportunityPageProps {
  requestData: RequestData
  initialQuery: string
  activeCode: string
  onOpenResearch(subject: ResearchSubject): void
  onAnalyzeResearch(subject: ResearchSubject): void
}
~~~

- [ ] **步骤 1：先改测试固定首次零证券请求**

首次 render 后等待指数和扫描完成，断言 requestData 只收到：

~~~ts
[
  { operation: 'market-watch.indices' },
  { operation: 'market-watch.scan', input: { kind: 'gainers', top_n: 12 } },
]
~~~

并断言没有 tech-signal、security-news、security-detail 或 news-flash。

- [ ] **步骤 2：增加扫描项动作和无嵌套按钮测试**

断言每项存在可独立聚焦的卡片主体、“详情”和“智能分析”；点击主体或详情传递同一 <code>ResearchSubject</code>，点击智能分析只触发分析回调。DOM 中不得出现 button 内嵌 button。

- [ ] **步骤 3：运行测试并确认旧自动选择与快讯请求使其失败**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/data-pages.client.spec.tsx
~~~

预期：观察到旧 news-flash 请求、扫描成功后的 tech-signal 请求和常驻详情区。

- [ ] **步骤 4：删除 OpportunityPage 的证券资源和常驻详情**

页面只保留 indices、scan、筛选、刷新和轻量引导。扫描项从单一 button 改为 article + 主体 button + 两个动作 button。主页面刷新只刷新指数和扫描，不影响已经打开研究窗的证券资源。

- [ ] **步骤 5：处理显式 initialQuery**

空 initialQuery 不做任何证券动作；从独立详情返回携带的非空代码视为显式上下文，由 Shell 只打开一次 docked 研究窗。不得因为扫描榜单返回而替换该代码。

- [ ] **步骤 6：运行数据页与页面回归**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/data-pages.client.spec.tsx packages/client/ui-investment-research/tests/product-pages.client.spec.tsx
~~~

预期：首次零证券请求、动作结构和其他页面详情跳转全部通过。

- [ ] **步骤 7：如已获提交授权，提交实时盯盘列表重构**

~~~bash
git add frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css frontend/packages/client/ui-investment-research/tests/data-pages.client.spec.tsx
git commit -m "[AI] 改造实时盯盘显式研究入口"
~~~

---

### Task 11：在 Shell 协调研究窗与 AI 助理

**覆盖需求：** <code>WATCH-014</code>、<code>WATCH-015</code>、<code>WATCH-023</code>

**文件：**

- 修改：<code>frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx</code>
- 修改：<code>frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css</code>
- 修改：<code>frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx</code>
- 新建：<code>frontend/packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx</code>

**状态：**

~~~ts
interface ResearchSurfaceState {
  readonly subject?: ResearchSubject
  readonly mode: ResearchSurfaceMode
  readonly suspendedByAssistant: boolean
}

interface ResearchReturnTarget {
  readonly subject: ResearchSubject
  readonly restoreMode: 'minimized' | 'docked'
}
~~~

该状态只存在于 <code>InvestmentShell</code> 生命周期内，不加入持久化 <code>InvestmentUiSnapshot</code>。

- [ ] **步骤 1：写失败集成测试固定互斥和返回路径**

覆盖：

- 打开研究窗时若 AI 已展开，则关闭 AI 后只显示研究窗；
- 从扫描项“智能分析”直接进入 AI，prompt 中代码与该项一致；
- 从研究窗“带入智能分析”后研究窗隐藏，AI 出现“返回证券详情”；
- 点击返回恢复同一证券 docked；
- 直接关闭 AI 时恢复同一证券 minimized；
- 不存在返回目标时，既有 AI 关闭行为完全不变；
- 历史与报告抽屉打开时，Escape 不被底层研究窗抢占。

- [ ] **步骤 2：运行测试并确认当前 Shell 没有研究表面协调状态**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx
~~~

预期：新测试找不到研究窗或返回按钮；既有 AI 回归仍通过。

- [ ] **步骤 3：实现 Shell 级协调器**

在 Shell 创建一次 <code>ResearchResourceStore</code>，保存研究状态和 return target。所有打开 AI 的本地入口通过包装函数记录或清除返回目标；同时用 assistantMode effect 捕获外部 <code>prepareAssistant</code> 导致的模式变化，保证两个展开表面不会同屏。

- [ ] **步骤 4：把返回操作接入 AssistantFloatingSurface**

只有存在 return target 时显示“返回证券详情”。显式返回与直接关闭使用不同处理函数，避免 effect 把 docked 恢复降为 minimized。

- [ ] **步骤 5：验证移动端滚动与焦点恢复**

在 jsdom 中模拟 <code>matchMedia('(max-width: 900px)')</code>、设置 pageScroll.scrollTop、打开详情、进入 AI、返回和关闭，断言背景锁定撤销、滚动位置不变、焦点回到原触发按钮。

- [ ] **步骤 6：运行 Shell、浮窗、助手和 state 回归**

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx packages/client/ui-investment-research/tests/state.client.spec.ts
~~~

预期：全部通过，没有同屏展开表面或焦点丢失。

- [ ] **步骤 7：如已获提交授权，提交右侧表面协调**

~~~bash
git add frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx frontend/packages/client/ui-investment-research/src/client/InvestmentShell.module.css frontend/packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx
git commit -m "[AI] 协调证券研究窗与 AI 助理"
~~~

---

### Task 12：更新 DSH 消费者、版本、文档并完成分层验收

**覆盖需求：** <code>WATCH-011</code> 至 <code>WATCH-023</code>

**文件：**

- 新建：<code>backend/market-watch/dsh-plugin/test/render-status.spec.ts</code>
- 修改：<code>backend/market-watch/dsh-plugin/src/index.ts</code>
- 修改：<code>backend/market-watch/dsh-plugin/src/render.ts</code>
- 修改：<code>backend/market-watch/dsh-plugin/package.json</code>
- 修改：<code>backend/market-watch/docs/API-接口文档.md</code>
- 修改：<code>backend/market-watch/docs/前端接入指南.md</code>
- 修改：<code>frontend/packages/client/ui-investment-research/package.json</code>
- 修改：<code>frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx</code>
- 修改：<code>docs/prd/0.1.0-rc.9/04-验收发布/01-产品验收与回归矩阵.md</code>
- 修改：<code>docs/prd/0.1.0-rc.9/04-验收发布/02-需求追踪矩阵.md</code>

- [ ] **步骤 1：写 DSH 渲染失败测试**

用 <code>node:assert/strict</code> 直接验证：

- preparing 渲染“技术信号正在准备”，不渲染买卖判断；
- unavailable 渲染安全消息和可重试提示；
- ready 继续渲染既有指标；
- tool output schema 声明 <code>status/stale/retry_after_ms/reason_code/message/retryable</code>，同时保留旧成功字段。

- [ ] **步骤 2：运行测试并确认旧渲染器不识别状态**

~~~bash
pnpm --dir backend/market-watch/dsh-plugin exec tsx test/render-status.spec.ts
~~~

预期：preparing/unavailable 被旧渲染器当作空 ready 内容，断言失败。

- [ ] **步骤 3：实现 DSH schema 和三状态渲染**

在 package.json 增加聚焦单元脚本；不要把 <code>market-watch.security-news</code> 暴露为任意 URL 工具。插件只需更新技术信号消费合同。

- [ ] **步骤 4：把产品品牌版本更新为 0.1.0-rc.9**

修改 UI package version，并把品牌回归测试从 rc.8 更新到 rc.9。运行：

~~~bash
pnpm --dir frontend exec vitest run packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx
~~~

预期：品牌显示 <code>0.1.0-rc.9 · 智能投研系统</code>。

- [ ] **步骤 5：更新 API、接入和需求追踪证据**

文档必须写明：

- indices 的 null/stale/warnings；
- scan 的 source/stale/complete/warnings 与 422/503；
- tech-signal 的 200 ready、202 preparing、200 unavailable；
- <code>GET /news/stock</code> 的代码绑定与空/失败区别；
- 需求追踪矩阵中每个 WATCH ID 对应的实现文件和自动化测试。

- [ ] **步骤 6：运行后端全量测试**

~~~bash
cd backend/market-watch
env/bin/python -m unittest discover -s tests -v
~~~

预期：全部通过，无真实外部源作为硬依赖。

- [ ] **步骤 7：运行运行时与前端聚焦套件**

~~~bash
pnpm --dir frontend exec vitest run packages/investment-research/python-runtime/tests/data.spec.ts packages/client/ui-investment-research/tests/research-resource.client.spec.ts packages/client/ui-investment-research/tests/research-floating-surface.client.spec.tsx packages/client/ui-investment-research/tests/security-research-content.client.spec.tsx packages/client/ui-investment-research/tests/data-pages.client.spec.tsx packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx packages/client/ui-investment-research/tests/right-surface-coordination.client.spec.tsx packages/client/ui-investment-research/tests/product-pages.client.spec.tsx packages/client/ui-investment-research/tests/state.client.spec.ts
~~~

预期：全部通过，无未处理 Promise、act 警告或悬挂计时器。

- [ ] **步骤 8：运行类型、插件和样式门禁**

~~~bash
pnpm --dir frontend run typecheck
pnpm --dir frontend run verify-client-theme-styles
pnpm --dir backend/market-watch/dsh-plugin run typecheck
pnpm --dir backend/market-watch/dsh-plugin exec tsx test/render-status.spec.ts
pnpm --dir backend/market-watch/dsh-plugin run smoke
~~~

预期：所有命令退出码为 0。插件 live 检查若外部源不可达只能按既有规则跳过，schema 覆盖错误不能跳过。

- [ ] **步骤 9：启动真实 profile 完成浏览器验收**

运行：

~~~bash
pnpm dsh --profile investment-research --host 127.0.0.1 --port 3080
~~~

按 PRD 的 RC9-E2E-01 至 RC9-E2E-21 验收，至少截取并检查：

- 1440×900：标准 docked、expanded、minimized，榜单不重排；
- 1042×889：榜单首项详情和分析入口无需滚到底部；
- 390×844：覆盖层、安全区、内部滚动、关闭后位置恢复；
- 920223：请求使用 bj920223/0.920223，技术区 preparing 后自动变 ready 或准确 unavailable；
- 个股相关随切股变化，市场快讯保持全局且有“不特指当前证券”说明；
- 指数非有限数和扫描断连故障注入只影响对应局部区域。

- [ ] **步骤 10：执行最终差异与文档完整性检查**

~~~bash
git diff --check
rg -n "WATCH-0(1[1-9]|2[0-3])" docs/prd/0.1.0-rc.9 docs/superpowers/specs/2026-08-31-realtime-watch-floating-research-design.md docs/superpowers/plans/2026-08-31-realtime-watch-floating-research-plan.md
rg -n "T[B]D|TO[D]O|待[补]|待[定]" docs/prd/0.1.0-rc.9 docs/superpowers/specs/2026-08-31-realtime-watch-floating-research-design.md docs/superpowers/plans/2026-08-31-realtime-watch-floating-research-plan.md
~~~

预期：<code>git diff --check</code> 为 0；13 个 WATCH ID 在 PRD、设计、计划和追踪矩阵中可定位；占位符搜索无结果。

- [ ] **步骤 11：如已获提交授权，提交消费者与验收证据**

~~~bash
git add backend/market-watch/dsh-plugin backend/market-watch/docs frontend/packages/client/ui-investment-research/package.json frontend/packages/client/ui-investment-research/tests/analysis-assistant-regression.client.spec.tsx docs/prd/0.1.0-rc.9
git commit -m "[AI] 完成实时盯盘悬浮研究窗验收"
~~~

## 实施完成判定

- <code>WATCH-011</code> 至 <code>WATCH-023</code> 在需求追踪矩阵中均有实现路径和通过的测试证据。
- 后端全量 unittest、前端聚焦 Vitest、前端 typecheck、主题样式门禁和 DSH 插件检查全部通过。
- 三个基准视口和真实 profile 验收通过；外部源抖动时展示准确的准备、缓存、局部失败或空状态。
- 工作区中没有被覆盖、清理、暂存或提交的无关修改；没有未经授权的 Git 写操作。
- 完成结论必须引用当轮验证输出，不能以“代码看起来正确”替代测试证据。

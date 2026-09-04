# PAB-9 rc.10 演示链路 Deep UAT

## 当前结论

**Ready** — 第二轮已关闭首轮两个发布阻断点。`RC10-E2E-16` 与 `RC10-E2E-17` 均通过：确定性演示夹具可经正式任务账本、报告存储与 renderer 生成回测/影子历史及报告引用；隔离 market-watch、industry-chain、trading-core 与前端可连续完成事件、产业链、策略、影子、自进化和报告彩排。

## 验收范围

- `RC10-E2E-16`：演示数据准备、验证、失败恢复、重复准备与 marker 限定清理。
- `RC10-E2E-17`：从画像/持仓，经事件与产业链、策略回测、影子历史、自进化四桶、变异回流到报告/AI 解释的完整彩排。
- 桌面端浅色 `1440×900` 与移动端 `390×844`。
- 隔离前端 `3180`、trading-core `8180`、market-watch fixture `8280`、industry-chain `8380`。
- 隔离状态目录 `/private/tmp/pa-rc10-pab9-uat`；不操作共享 `3080` 服务。

## 第二轮验收矩阵

| 用例 | 状态 | 证据 |
| --- | --- | --- |
| 演示脚本静态语法与权限 | passed | Python 入口通过 `py_compile`，shell 入口通过 `bash -n`，新增服务夹具入口可执行 |
| 演示准备、验证与 preflight | passed | 5 个固定交易日、四类场景、5 项动作、2 个变异子策略、1 条回测任务、1 条影子任务、2 份报告均通过校验 |
| 回测任务历史与报告引用 | passed | `demo-promote` 页面显示完成态、首次自动、1 年窗口、样本外 6 笔、通过结论、重新运行与查看报告；报告编号为 `aaaaaaaa…` |
| 影子任务历史与报告/净值引用 | passed | 页面显示任务 `bbbbbbbb…`、完成态、4 成功/0 失败/0 跳过；四条逐策略结果均显示 `shadow_equity / 2026-09-04 / bbbbbbbb…` 与报告编号 |
| 产业链权重来源 | passed | 浦发银行图谱同时显示披露关系占比 5%/12%、默认关系权重 20%/10% 且标注“非披露占比”、推断关系置信度 82% |
| 事件传导受限降级契约 | passed | 上游 55 个唯一事件加 1 个重复副本；trading-core 去重并返回 50 条，`page_info={mode: bounded, pagination_supported: false, max_visible: 50}`；页面明确提示“当前最多展示 50 条事件；上游暂不支持翻页” |
| 事件 → 产业链连续链路 | passed | 首条事件直接标的 600000，经真实 industry-chain 扩展出 300033/600036，并在工作台及产业链事件区展示传导来源 |
| 五日自进化与变异回流 | passed | 页面显示 `5 / 5 日`、正常/观察/升级/淘汰 `1/1/1/1`、最近自动应用 5 项动作、候选 2 条并保留母策略链路 |
| 桌面浅色与移动端 | passed | `1440×900` 和 `390×844` 的 `documentElement.scrollWidth` 分别等于视口宽度；关键导航、刷新、报告与策略证据可达 |
| 刷新持久性 | passed | 页面刷新后工作台仍读取确定性事件与影子风险；再次进入业务页可继续查询隔离任务与报告 |
| 服务失败与恢复 | passed | 停止 8380 后产业链页显示“真实数据暂不可用”和“重试”；重启服务并点击重试后恢复 3 家核心公司，错误提示消失 |
| 浏览器日志 | passed | 第二轮浏览器控制台与页面错误日志为 0 条 |
| 默认状态隔离 | passed | 一次回归测试曾误写默认 `decisions.json`；已只撤销本轮新增记录并恢复原始 SHA-256。五个默认 JSON 最终哈希与验收前完全一致 |
| 清理 | passed | 浏览器标签已关闭并恢复视口；3180/8180/8280/8380 均停止监听；marker 限定 clean 后隔离根目录不存在 |

## RC10 用例结论

| 用例 | 状态 | 证据 |
| --- | --- | --- |
| `RC10-E2E-16` | passed | 固定日期为 `2026-08-31` 至 `2026-09-04`；四类场景齐全；动作包含 promote/mutate/demote/retire；重复准备、门禁失败恢复与 marker 限定清理已验证 |
| `RC10-E2E-17` | passed | 画像/持仓入口、50 条有界事件、产业链三类权重来源、策略回测历史、影子任务历史、五日自进化、变异回流及两份报告可在同一隔离产品组合连续取证 |

## 自动化与构建证据

```text
trading-core：100 tests passed
industry-chain：10 tests passed
frontend：6 files / 101 tests passed
frontend contracts typecheck：passed
ui-investment-research bundle：passed
demo prepare / verify / preflight：passed
```

执行命令：

```text
/private/tmp/pa-rc10-pab11-uat/venv/bin/python -m unittest \
  tests.test_demo_evolution tests.test_backtest_tasks tests.test_shadow_tasks \
  tests.test_reports tests.test_portfolio_route_latency tests.test_closed_loop \
  tests.test_strategy_verification

/private/tmp/pa-rc10-pab11-uat/venv/bin/python -m unittest \
  tests.test_graph_weight_provenance tests.test_app_data_routes

pnpm exec vitest run \
  packages/client/ui-investment-research/tests/product-pages.client.spec.tsx \
  packages/client/ui-investment-research/tests/strategy-research.client.spec.tsx \
  packages/client/ui-investment-research/tests/evolution-entry.client.spec.tsx \
  packages/client/ui-investment-research/tests/task-client.client.spec.ts \
  packages/client/ui-investment-research/tests/assistant-intent.client.spec.ts \
  packages/investment-research/python-runtime/tests/data.spec.ts

pnpm run typecheck:contracts-ready
pnpm --filter @deepseek-ai/dsh-client-ui-investment-research run bundle
```

后端回归首次运行因隔离虚拟环境缺少仓库已声明的 `openai>=1,<2` 而出现 9 个导入错误；补齐该临时环境依赖后，同一组 100 个测试全部通过。测试中的故障日志均来自显式的失败恢复用例。

## 隔离环境与接口证据

```text
前端：http://127.0.0.1:3180
trading-core：http://127.0.0.1:8180
market-watch fixture：http://127.0.0.1:8280
industry-chain：http://127.0.0.1:8380
状态：/private/tmp/pa-rc10-pab9-uat
DSH_HOME：/private/tmp/pa-rc10-pab9-dsh-home
trading-core：ADAPTER_RUNNER=fake、EVOLVE_MIN_DAYS=5、闭环/自动复测关闭
```

- market-watch fixture 按既有 `/news/events` 与 `/securities/search` 合同提供确定性输入，不新增业务接口。
- industry-chain 使用真实应用与隔离 seed，`/graph/single/600000`、`/graph/chain/600000` 返回 `disclosed/default/inferred` 三类来源。
- trading-core `/personalized/impact?limit=50` 返回 50 个去重事件和明确的 bounded page contract。
- `/strategies/demo-promote/backtests`、`/shadow/history`、`/reports` 通过生产 collection 与正式 API 返回历史及引用。
- 未发送真实模型请求；AI 验收仅确认入口与现有证据上下文。

## 默认状态最终哈希

```text
ea55f4378f6763677be34a12b4d67bb223ed732d53d662aff6e7811d10a88f61  behavior.json
a09c3fa7cc893fdae0c8231e60740e8d66e13db1b05fe3a5c6fc9eebd7867383  decisions.json
84d36c090d1e997c222deae096eb48ab4647455855fd5f5d679aee9c397183cd  reports.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  shadow_tasks.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  strategy_backtests.json
```

## 首轮记录（已关闭）

首轮结论为 **Not ready**：五日四桶与变异回流已经可见，但演示夹具没有回测/影子任务历史与报告引用，且只启动 3180/8180，无法在同一隔离组合取证事件与产业链。第二轮通过复用正式任务账本、报告存储/renderer，以及隔离的 market-watch 合同 fixture 与真实 industry-chain 服务关闭了这两个阻断点。

## 剩余风险

- market-watch 使用的是确定性合同 fixture，而非依赖外部资讯与模型的完整生产进程；本次验收覆盖接口消费、去重、上限与跨服务传导，不覆盖外部数据源质量。
- 前端页头仍显示产品版本 `0.1.0-rc.8`，与本次 rc.10 验收名称不一致；不影响 PAB-9 演示链路，但发布前应由版本发布流程统一校正。

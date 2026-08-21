# industry-chain · 产业链关联图谱

第三个独立插件模块（前两个：dsh-trading-core :8000、market-watch :8100）。
上市公司产业链知识图谱：**全图网络拓扑 / 产业链展开 / 单公司 5 列视图**。

- 后端适配器：FastAPI，端口 **:8200**，全部同步查询端点
- dsh 对话插件：4 个只读工具，dsh UI 端口 **:3082**
- 产品壳入口：首页「⛓️ 产业链图谱」或导航 `#/chain`

## 端口

| 服务 | 端口 |
|---|---|
| FastAPI 适配器 | :8200 |
| dsh Web UI（带插件） | :3082 |

## 端点

| 端点 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /stats` | 图统计（节点/边/公司/社区） |
| `GET /companies?keyword=&limit=` | 公司搜索（名称/代码/行业模糊） |
| `GET /companies/{code}` | 核心公司档案（行业/市值/描述/上下游计数） |
| `GET /graph/entity/{key}` | 通用实体档案：① 核心公司完整档案 ② 非核心实体聚合全图关系档案 ③ 图谱外 A 股的基础档案（全 A 股兜底） |
| `GET /graph/single/{code}` | 单公司 5 列：供应商 → 原材料 → 核心公司 → 主营产品 → 下游客户 |
| `GET /graph/chain/{code}?depth_up=&depth_down=&top_up=&top_down=` | 产业链展开：BFS 上下游逐层、每层 TOP-N、环回去重 |
| `GET /graph/network?min_degree=&min_market_cap=&min_share=` | 全局网络切片（服务端过滤，客户端不拉全量） |

## 安装与运行

```bash
./init.sh        # venv + 依赖 + .env + 下载种子数据（5 个 JSON 约 25MB，落 data/seed/）
./start.sh       # 适配器 :8200 + dsh :3082（已运行自动跳过）
./verify.sh      # 适配器冒烟 + dsh 插件冒烟（4 工具注册 + 实时 schema 校验）
./stop_all.sh    # 停 :8200 / :3082
```

Windows：`init.bat` / `start_all.bat` / `verify.bat` / `stop_all.bat`。

种子数据可随时重刷：`python scripts/fetch_seed_data.py`（幂等，已存在则跳过）。

## 数据出处与免责

种子数据打包自 **[IDUXGRAPH / iducsite](https://villadora.github.io/iducsite/)**（「公司产业链数据分析」，托管于 GitHub Pages）：
`stats / companies / market-caps / view-data-all / network-data` 五个 JSON 文件。

该数据来自公开财报/研报的自动抽取 + 图内推断（Neo4j），原始站点 footer 声明同样适用于本项目：

> **数据仅供研究参考，不构成投资建议。** 供应商/客户/原材料等关联由算法推断，可能存在缺失或误差；使用前请以官方披露为准。

- 数据版权归原始来源所有，本项目仅作研究缓存，不重新分发、不用于商业用途。
- 刷新脚本依赖第三方站点可用性；站点不可达时请保留本地 `data/seed/` 缓存。
- 若原始站点的数据许可不适用于你的用途，请删除 `data/seed/` 并停止使用本模块。

## 自建研报管线（增量补充）

iducsite 图谱只覆盖约 8600 个产业实体；为让「任何 A 股公司点开都有档案」并持续补充产业链信息，
在图谱之上加了两层数据：

```
python scripts/build_universe.py                                # ① 全 A 股兜底清单（东财行情接口，~5900 家）
python scripts/build_report_pipeline.py --codes=600315,688363    # ② 研报深度（抓取 → DeepSeek 抽取 → overlay 合并）
```

- **全 A 股兜底**：`data/a_share_universe.json`，代码/名称/行业/市值/板块，图谱外的 A 股经 `/graph/entity/{code}` 返回基础档案（标注「暂无关产业链数据」）。
- **研报深度**：东财研报列表 + 详情页全文 → DeepSeek 抽取供应链关系（materials/products）、关联公司（related）、经营指标（metrics）→ 写入 `data/reports/overlay.json`，graph 加载时叠加到图谱记录（`/graph/entity`、`/graph/single`、`/companies/{code}` 均生效）。

要点与边界：
- overlay 独立于 `view-data-all.json`（iducsite 原数据不被改写；删 overlay 即还原；重复跑幂等）。
- DeepSeek key：`IC_DEEPSEEK_API_KEY`（从 `dsh-trading-core/.env` 复制到本地 `.env`，真实 key 不进 git）。
- 研报抽取依赖券商研报覆盖：小盘 / 次新 / 北交所常无研报，这类公司只有兜底基础档案。
- 全 A 股兜底手动 `--force` 重拉，无自动刷新。
- 免责声明同 iducsite：抽取内容仅供研究参考，不构成投资建议。

## 数据模型

- `companies.json`：1297 家核心上市公司 `{code, name, industry, exchange, is_subject, ...}`
- `view-data-all.json`：每公司 `{id, code, name, industry, desc, materials[], products[]}`（含供应商/客户链）
- `network-data.json`：全局图 `{nodes[], links[], macro_communities[], stats}`，节点含 ForceAtlas2 预计算坐标 `init_x/init_y`
- `a_share_universe.json`：~5900 家 A 股基础档案（东财行情接口，可重建，不在 git）
- `data/reports/`：研报抓取产物 + `overlay.json`（研报增量，可重建，不在 git）
- 图查询层（`industry_chain/graph.py`）对种子数据做**首次访问懒加载** + 模块级缓存；研报 overlay 在加载时叠加（重启后生效）

## 实现说明

- 纯内存 JSON 图谱查询，依赖极简：`fastapi / uvicorn / pydantic / python-dotenv / requests`（无数据库、无调度器、无 SSE）
- 全图视图直接用预计算 `init_x/init_y` + 轻量松弛迭代（节点 >800 降迭代），不做客户端 Leiden 聚类（复用服务端 macro_communities 着色）
- 中文编码：适配器返回 UTF-8；Windows 下测试请用 Python `requests` 或浏览器（避免 Git Bash curl 的 GBK 陷阱）

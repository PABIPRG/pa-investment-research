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
| `GET /companies/{code}` | 公司档案（行业/市值/描述/上下游计数） |
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

## 数据模型

- `companies.json`：1297 家核心上市公司 `{code, name, industry, exchange, is_subject, ...}`
- `view-data-all.json`：每公司 `{id, code, name, industry, desc, materials[], products[]}`（含供应商/客户链）
- `network-data.json`：全局图 `{nodes[], links[], macro_communities[], stats}`，节点含 ForceAtlas2 预计算坐标 `init_x/init_y`
- 图查询层（`industry_chain/graph.py`）对两大数据集做**首次访问懒加载** + 模块级缓存，重启后自动重建

## 实现说明

- 纯内存 JSON 图谱查询，依赖极简：`fastapi / uvicorn / pydantic / python-dotenv`（无数据库、无调度器、无 SSE）
- 全图视图直接用预计算 `init_x/init_y` + 轻量松弛迭代（节点 >800 降迭代），不做客户端 Leiden 聚类（复用服务端 macro_communities 着色）
- 中文编码：适配器返回 UTF-8；Windows 下测试请用 Python `requests` 或浏览器（避免 Git Bash curl 的 GBK 陷阱）

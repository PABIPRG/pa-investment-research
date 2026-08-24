# industry-chain · 产业链图谱适配器 API 接口文档

> 面向：后端联调 / 前端桥接层开发者 / 部署运维。
> 本文档描述 **产业链图谱适配器（FastAPI，`industry_chain/app.py`，端口 8200）** 暴露的全部 HTTP 接口。
> 版本：适配器 0.1.0 · 覆盖代码当前实现（公司检索 / 公司档案 / 实体档案 / 单公司产业链 / 多层展开 / 全局网络切片）。

---

## 1. 总体说明

### 1.1 架构与接口类型

```
前端 UI / dsh 插件（任何 HTTP 客户端）
        │  HTTP（只读，无 SSE）
        ▼
   FastAPI 产业链适配器  (127.0.0.1:8200)
        │
        ▼
   纯内存图谱查询（数据懒加载自 data/seed/，无外部 I/O 依赖）
```

| 类型 | 特点 |
|---|---|
| 全部只读 | 所有端点均为**秒级只读查询**，无写操作、无任务式接口、无 SSE |
| 内存图谱 | 图谱数据懒加载入模块级缓存（两份 ~10-15MB JSON），首次查询触发加载，之后全内存 |
| 服务端切片 | `/graph/network` 在服务端过滤后返回渲染子集，浏览器**不拉 14.8MB 全量** |
| 三层实体 | 图谱核心公司 / 图谱非核心实体 / 全 A 股兜底，统一走 `/graph/entity` |

### 1.2 通用约定

- **Base URL**：`http://127.0.0.1:8200`（可通过 `--host` / `--port` 修改）
- **请求**：全部为 GET，参数走 Query（`code` / `key` 走路径段）
- **响应体**：`application/json`（中文已 `ensure_ascii=False`，UTF-8）
- **CORS**：`allow_origins=["*"]`，浏览器跨域可直接调用
- **错误格式**：FastAPI 标准错误 `{"detail": "..."}`；自定义错误码见下表
- **认证**：当前无鉴权（仅绑定 127.0.0.1 默认；对外部署需自行加反向代理/网关）
- **数据语义**：`is_subject=true` 表示图谱内核心研报公司（1297 家）；`share` 为供应链权重占比（%），缺失时后端按方向给默认值（上游 20 / 下游 10）；`type` ∈ `direct`（直接）/ `inferred`（LLM 推断边）

### 1.3 错误码速查

| 状态码 | 场景 |
|---|---|
| 200 | 成功 |
| 404 | 未找到公司 / 实体（代码需为图谱内核心公司 code，或实体的 id/name，或 6/8 位 A 股代码） |
| 422 | 路径/Query 参数不合法（`limit` 超界、`depth` 超界等，由 FastAPI 校验） |
| 503 | **种子数据缺失**：`data/seed/` 未下载，需先跑 `scripts/fetch_seed_data.py` 或 `init.sh` |

### 1.4 种子数据

| 文件 | 内容 |
|---|---|
| `companies.json` | 1297 家上市公司列表 `{code,name,industry,exchange,is_subject}` |
| `view-data-all.json` | 每公司 `{materials:[{...,suppliers}], products:[{...,customers}]}`（图谱本体） |
| `network-data.json` | 全局网络 `{nodes, links, macro_communities, stats}`（含坐标/社区） |
| `market-caps.json` | 市值（按名称索引，少量核心公司） |
| `stats.json` | 图统计 |

研报 overlay 增量（`data/reports/overlay.json`）在加载时按 name 合并进每公司记录（`related` / `metrics` / 补充 `materials` / `products`），运行期不变、重启后生效。

---

## 2. 端点总表

| # | 方法 | 路径 | 说明 | 类型 |
|---|---|---|---|---|
| 1 | GET | `/health` | 健康检查 | 只读 |
| 2 | GET | `/stats` | 图谱统计 | 只读 |
| 3 | GET | `/companies` | 公司模糊搜索（名称/代码/行业） | 只读 |
| 4 | GET | `/companies/{code}` | 单公司档案 | 只读 |
| 5 | GET | `/graph/entity/{key}` | 通用实体档案（核心公司/非核心实体/A 股兜底） | 只读 |
| 6 | GET | `/graph/single/{code}` | 单公司 5 列产业链视图 | 只读 |
| 7 | GET | `/graph/chain/{code}` | 上下游多层 BFS 展开 | 只读 |
| 8 | GET | `/graph/network` | 全局网络切片（服务端过滤） | 只读 |

---

## 3. 公司检索与档案

### 3.1 GET /companies —— 公司模糊搜索

**Query**：`keyword`（名称/代码/行业子串，空 = 全部）、`limit`（1–100，默认 20）。

```jsonc
GET /companies?keyword=电池&limit=10
// 200
{
  "items": [
    { "code": "300750", "name": "宁德时代", "industry": "电池", "exchange": "SZ", "is_subject": true }
  ],
  "count": 1
}
// 503（种子数据缺失）
{ "detail": "种子数据缺失: ... —— 请先运行 init.sh 或 scripts/fetch_seed_data.py 下载" }
```

### 3.2 GET /companies/{code} —— 单公司档案

`code` 需为**图谱内核心公司 code**（非图谱实体请用 `/graph/entity/{key}`）。

```jsonc
GET /companies/300750
// 200
{
  "id": "cn-300750", "code": "300750", "name": "宁德时代",
  "industry": "电池", "desc": "……",
  "is_subject": true,
  "market_cap_cny": 850000000000, "market_cap_display": "8500.00亿",
  "stock_price": 218.5,
  "material_count": 12, "product_count": 3,
  "supplier_count": 40, "customer_count": 8,
  "related": [ { "name": "宁德时代", "code": "300750", "relation": "自身" } ],   // 研报 overlay，可空 []
  "metrics": [ { "label": "毛利率", "value": "26.2%" } ]                         // 可空 []
}
// 404（code 不在图谱内）
{ "detail": "未找到公司 999999（代码需为图谱内核心公司 code）" }
```

---

## 4. 图谱查询

### 4.1 GET /graph/entity/{key} —— 通用实体档案

`key` 可以是核心公司 code / name、非核心实体的 id / name、或 6/8 位 A 股代码。按三种形态返回（由服务端判定）：

**① 图谱核心公司** → 同 `/companies/{code}` 档案，附 `"is_subject": true`。

```jsonc
GET /graph/entity/300750
// 200
{ "id": "cn-300750", "code": "300750", "name": "宁德时代", "is_subject": true, "industry": "电池", "...": "同 §3.2" }
```

**② 图谱非核心实体**（供应商 / 原材料 / 客户等）→ 全图关系档案：

```jsonc
GET /graph/entity/正极材料
// 200
{
  "id": "mat-xxx", "name": "正极材料", "is_subject": false,
  "appearance_count": 23,                       // 作为供应商+客户出现的总次数
  "as_supplier": [
    { "company_code": "300750", "company_name": "宁德时代", "item": "三元正极", "share": 30, "type": "direct", "note": null }
  ],
  "as_customer": [],
  "metrics": [],                                // 研报 overlay，可空
  "related": [],
  "report_materials": [],
  "report_products": []
}
```

**③ 全 A 股兜底**（图谱外的 6/8 位 A 股代码）→ 基础档案：

```jsonc
GET /graph/entity/000002
// 200
{
  "code": "000002", "name": "万科A", "industry": "房地产", "market_cap": 9200000000,
  "board": "主板", "is_subject": false, "source": "a_share_universe",
  "appearance_count": 0, "as_supplier": [], "as_customer": [],
  "metrics": [], "related": [],
  "note": "全 A 股基础档案：暂无关产业链数据（该股尚未被研报/图谱覆盖）"
}
// 404（完全无法解析）
{ "detail": "未找到实体 xxx" }
```

### 4.2 GET /graph/single/{code} —— 单公司 5 列产业链视图

列式数据（前端画 SVG 边）：**供应商 → 原材料 → 核心公司 → 主营产品 → 下游客户**。供应商/客户经多材料/多产品出现时合并为一条并聚合 `vias`。

```jsonc
GET /graph/single/300750
// 200
{
  "company": { "...": "同 §3.2 company_profile" },
  "materials": [
    { "id": "mat-xxx", "name": "三元正极", "share": 30, "confidence": 0.9 }
  ],
  "suppliers": [
    { "id": "s-xxx", "name": "华友钴业", "type": "direct", "share": 20, "note": null, "vias": ["三元正极", "钴酸锂"] }
  ],
  "products": [
    { "id": "p-xxx", "name": "动力电池", "share": null, "confidence": null }
  ],
  "customers": [
    { "id": "c-xxx", "name": "特斯拉", "type": "direct", "share": 10, "note": null, "vias": ["动力电池"] }
  ]
}
// 404（code 不在图谱内）
{ "detail": "未找到公司 999999（代码需为图谱内核心公司 code）" }
```

### 4.3 GET /graph/chain/{code} —— 上下游多层 BFS 展开

**Query**：`depth_up`（1–3，默认 2）、`depth_down`（1–3，默认 2）、`top_up`（每层上游 TOP-N，1–5，默认 3）、`top_down`（1–5，默认 2）。环回去重。

```jsonc
GET /graph/chain/300750?depth_up=2&depth_down=2&top_up=3&top_down=2
// 200
{
  "center": { "...": "同 §3.2 company_profile" },
  "up_levels": [
    {
      "level": -1,            // 负数 = 上游
      "nodes": [
        { "id": "s-xxx", "name": "华友钴业", "share": 20, "type": "direct", "via": "三元正极", "note": null,
          "parent_id": "cn-300750", "depth": 1 }
      ]
    },
    { "level": -2, "nodes": [ /* 再上一级 */ ] }
  ],
  "down_levels": [
    { "level": 1, "nodes": [ /* 正数 = 下游 */ ] }
  ]
}
// 404（code 不在图谱内）
{ "detail": "未找到公司 999999（代码需为图谱内核心公司 code）" }
```

> `node.parent_id` = 父层节点标识（能解析为核心公司时为其 code，否则为 name）；`depth` = 距中心的层数（1 起）。前端可据此画树/递进图。

### 4.4 GET /graph/network —— 全局网络切片

**Query**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `min_degree` | int | 3 | 最低度数（连线数）过滤节点 |
| `min_market_cap` | float | 0 | 最低市值（元，`0` = 不限） |
| `min_share` | float | 10 | 连线最低权重 %（`0` = 不限；`share=null` 的边恒保留） |
| `subject_only` | int | 0 | `1` 时只保留核心公司（`is_subject`），滤掉供应商/原材料等外部实体 |
| `include_universe` | int | 0 | `1` 时**全 A 股模式**：输出全部 5901 家 A 股 + A→A 供应链真实边 |

**普通模式**（`include_universe=0`）：

```jsonc
GET /graph/network?min_degree=3&min_share=10&subject_only=1
// 200
{
  "nodes": [
    { "id": "cn-300750", "code": "300750", "name": "宁德时代", "industry": "电池",
      "is_subject": true, "role": "core", "tier": 0, "radius": 12,
      "color": "#f59e0b", "glowColor": null, "market_cap_cny": 850000000000,
      "badge": "电力设备", "degree": 48, "upCount": 40, "downCount": 8,
      "macroId": 1, "macroName": "新能源", "init_x": 320.5, "init_y": 210.2,
      "subId": 5, "subName": "电池", "scaleText": "核心",
      "board": null, "market_cap": null, "has_view": null }
  ],
  "links": [
    { "source": "cn-300750", "target": "cn-002460", "kind": "supplier",
      "type": "direct", "share": 15, "item": "三元正极" }
  ],
  "macro_communities": [
    { "macroId": 1, "name": "新能源", "palette": "…", "size": 42, "industry": "电池" }
  ],
  "stats": { "total_nodes": 1297, "total_edges": 8642, "companies": 1297, "items": 4203, "relationships": 8642, "macro_communities": 12, "subject_count": 1297 }
}
```

**全 A 股模式**（`include_universe=1`）：忽略 `min_degree` / `min_market_cap` / `subject_only`；`min_share` 仅过滤数值型 `share`。节点全部为 6 位 A 股 code；可复用 network 坐标/社区/度数的复用，否则用行业簇坐标 + 真实 A→A 边度数合成。

```jsonc
GET /graph/network?include_universe=1&min_share=0
// 200
{
  "nodes": [
    { "id": "300750", "code": "300750", "name": "宁德时代", "industry": "电池",
      "board": "创业板", "market_cap": 850000000000, "market_cap_cny": 850000000000,
      "has_view": true, "is_subject": true, "radius": 12, "color": "#f59e0b",
      "degree": 48, "upCount": 40, "downCount": 8, "macroId": 1,
      "init_x": 320.5, "init_y": 210.2 }
  ],
  "links": [
    { "source": "300750", "target": "002460", "kind": "supplier",
      "type": "direct", "share": 15, "item": "三元正极", "count": 1,
      "confidence": null }        // LLM 推断边 type="inferred"，confidence 分级显示
  ],
  "macro_communities": [ { "macroId": 1, "name": "新能源", "palette": "…", "size": 42, "industry": "电池" } ],
  "stats": {
    "total_nodes": 5901, "total_links": 8642,
    "universe_mode": true, "subject_count": 1297, "macro_communities_count": 12
  }
}
```

> **slim node** 字段全集见 §5.3（`_slim_node` 保留键）。`stats` 普通模式直接透传 `network-data.json` 的 stats。

---

## 5. 数据结构速查（TypeScript 视角，供前端对齐）

### 5.1 公司

```ts
interface CompanyItem {
  code: string; name: string
  industry: string | null; exchange: string | null
  is_subject: boolean
}
interface CompanyProfile {
  id: string; code: string; name: string
  industry: string | null; desc?: string
  is_subject: boolean
  market_cap_cny: number | null      // 元
  market_cap_display: string         // 展示文案（可空）
  stock_price: number | null
  material_count: number; product_count: number
  supplier_count: number; customer_count: number
  related: Array<{ name: string; code?: string; relation?: string }>   // 研报 overlay，可空
  metrics: Array<{ label: string; value: string }>                     // 可空
}
```

### 5.2 实体档案

```ts
interface EntityProfile {
  id?: string; code?: string; name?: string
  is_subject: boolean
  industry?: string; market_cap?: number; board?: string
  source?: 'a_share_universe'                    // ③ 兜底形态才带
  appearance_count?: number
  as_supplier?: Array<{ company_code: string; company_name: string; item: string; share: number; type: string; note: string | null }>
  as_customer?: Array<同 as_supplier>
  metrics?: Array<{ label: string; value: string }>
  related?: Array<{ name: string; relation?: string }>
  report_materials?: unknown[]; report_products?: unknown[]
  note?: string                                   // ③ 兜底说明
}
```

### 5.3 图谱节点 / 边

```ts
interface GraphNode {                            // _slim_node 保留键全集
  id: string; code?: string; name: string
  industry?: string; is_subject?: boolean
  role?: string; tier?: number
  radius?: number; color?: string; glowColor?: string | null
  market_cap_cny?: number | null; badge?: string
  degree?: number; upCount?: number; downCount?: number
  macroId?: number | null; macroName?: string | null
  init_x?: number; init_y?: number
  subId?: number; subName?: string; scaleText?: string
  board?: string | null; market_cap?: number | null; has_view?: boolean | null
}
interface GraphLink {
  source: string; target: string
  kind?: 'supplier' | 'customer'
  type?: 'direct' | 'inferred'
  share?: number | null
  item?: string
  count?: number            // 全 A 股模式：同一 pair 聚合出现次数
  confidence?: number | null
}
interface MacroCommunity { macroId?: number; name?: string; palette?: string; size?: number; industry?: string | null }
```

### 5.4 单公司视图 / 多层展开

```ts
interface SupplyNode {
  id: string; name: string; type: string
  share: number            // 默认：上游 20 / 下游 10
  via?: string; note?: string | null
  vias?: string[]          // 仅 graph_single：多材料/产品聚合
}
interface GraphSingle {
  company: CompanyProfile
  materials: Array<{ id?: string; name: string; share?: number; confidence?: number }>
  suppliers: SupplyNode[]
  products: Array<{ id?: string; name: string; share?: number; confidence?: number }>
  customers: SupplyNode[]
}
interface ChainLevel { level: number; nodes: Array<SupplyNode & { parent_id: string; depth: number }> }
interface GraphChain { center: CompanyProfile; up_levels: ChainLevel[]; down_levels: ChainLevel[] }
```

---

## 6. 与宿主工具 / 前端的映射

| dsh 插件工具 / 宿主侧 | 底层端点 |
|---|---|
| `chain_search`（公司搜索） | GET `/companies` |
| `chain_profile`（公司/实体档案） | GET `/companies/{code}`、GET `/graph/entity/{key}` |
| `chain_graph`（单公司产业链） | GET `/graph/single/{code}` |
| `chain_expand`（上下游多层展开） | GET `/graph/chain/{code}` |
| 全局网络拓扑（前端 `#/chain` 全图） | GET `/graph/network`（`include_universe=1` 全 A 股模式） |
| 图谱统计（数据体检） | GET `/stats` |

> **跨模块联动**：前端 `#/chain` 用 `/companies?keyword=…&limit=1` 做名称→code 解析，命中后调 `/graph/single` / `/graph/chain` / `/graph/entity` 绘制；首页事件预警的个股名（`event-alerts` 的 `name`）也会跳到 `#/chain` 聚焦该代码。

---

## 7. 数据与状态

- **纯只读、无写接口**：适配器不落任何业务数据；数据全部来自 `data/seed/` 静态种子文件 + `data/reports/overlay.json` 研报增量。
- **模块级懒加载缓存**：首次访问触发读取，之后全内存（进程内共享）；`POST` 无 `invalidate` 端点，数据变更后**重启适配器**生效。
- 种子数据缺失（`data/seed/` 不存在）→ 所有查询端点返回 **503**（`/health` 除外）；数据就绪后自动恢复。
- 研报管线（`reports/` 生成 overlay）是**内部脚本驱动**，无 HTTP 接口。

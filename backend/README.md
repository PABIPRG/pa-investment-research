# Backend 模块清单

本目录下每个子文件夹是一个**独立服务/模块**，各自拥有依赖和启动方式，互不依赖。

## 模块列表

| 模块 | 职责 | 端口 | 启动方式 | 技术栈 |
|---|---|---|---|---|
| [dsh-trading-core](./dsh-trading-core) | 多智能体 A 股分析引擎，作为 dsh 插件运行（无状态 FastAPI 适配器） | 8000（uvicorn 默认） | 见其 [README](./dsh-trading-core/README.md) | Python + FastAPI |
| [market-watch](./market-watch) | 盘中实时盯盘 Agent：条件触发告警、异动扫描、技术信号、新闻速递、LLM 盘前/盘后简报与触发解读，作为 dsh 插件运行 | 8100（uvicorn 默认） | 见其 [README](./market-watch/README.md) | Python + FastAPI |

> 新增模块时在此登记一行，端口先到先得。

## 端口分配约定

| 端口 | 模块 |
|---|---|
| 8000 | dsh-trading-core（adapter） |
| 8100 | market-watch（adapter） |

建议新模块从 **8100** 起分配，间隔 10 预留。

## 约定

- **依赖隔离**：每个模块独立 `requirements.txt`（或 `pyproject.toml`）与 venv，venv 目录（如 `.venv/`）加入该模块的 `.gitignore`。
- **配置隔离**：`.env` 放各模块内，由模块自行读取；跨模块共享的外部资源（数据库、API Key 等）在模块 README 中说明来源。
- **文档**：每个模块根目录必须有 `README.md`，说明职责、依赖安装、启动/停止命令。

# PA-INVESTMENT-RESEARCH

投资研究项目：`frontend/` 为前端（源自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，通过 git subtree 同步上游），`backend/` 为后端，`dsh-trading-core/` 为前后端共用的 A 股分析插件。

## 快速开始

所有常用操作通过根目录入口 `start.sh` 完成（跨平台：Linux / macOS 原生支持，Windows 需在 Git Bash 中运行）：

```bash
./start.sh          # 交互式菜单（↑↓ 选择，回车运行）
./start.sh <命令>   # 直接执行，如 ./start.sh investment-web --port 8090
```

### 首次使用

```bash
bash scripts/init.sh
cd frontend && pnpm run investment:python:init
```

先安装并构建前端，再初始化投研所需的两个 Python 后台环境。macOS 下会自动移除 native 模块的 quarantine 标记，避免 Gatekeeper 拦截。

### 可用命令

| 命令 | 说明 |
|------|------|
| `backend-start` | 启动投研后台服务：`trading-core(:8000)` 和 `market-watch(:8100)` |
| `investment-web` | 构建并启动 Web 版投研；可继续传入 `--host`、`--port` 等 Web 参数 |
| `investment-electron` | 构建并启动 Electron 版投研 |
| `sync-upstream` | 同步上游 deepseek-harness 到 `frontend/`（git subtree + squash） |

### 同步上游

`frontend/` 目录通过 git subtree 跟踪上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（默认分支 `master`）：

```bash
./start.sh sync-upstream              # 同步 upstream/master
./start.sh sync-upstream <branch>     # 同步指定分支
```

要求工作区无未提交的跟踪文件变更。若与本地改动冲突（常见于 `frontend/packages/` 下被移出的 `dsh-trading-core`），需手动解决后提交。

## 新增脚本

1. 在 `scripts/` 下新建脚本（如 `scripts/foo.sh`）
2. 在 `scripts/main.sh` 的 `SCRIPTS` 数组中注册一行：

```bash
"foo|脚本描述（菜单中显示）|scripts/foo.sh"
```

第三段以 `.sh` 结尾按脚本文件执行，否则按 shell 命令执行（如 `cd frontend && pnpm run xxx`）。注册后菜单和 `./start.sh foo` 直达命令自动生效。

## 开发文档

- [投研新后端模块与前端 UI 接入 SOP](docs/sop/investment-research-backend-ui-integration-sop.md)：面向贡献者的后端模块、Host operation、投研页面和测试接入流程。

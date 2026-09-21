# PAB-29 镜像安全加固设计与实施计划

关联：[PAB-29](https://linear.app/pabiprg/issue/PAB-29)，里程碑 `0.2.0-alpha.3`，状态保持 In Progress。
基准：`ba13a94ac41157fd658d5dcc31258957108c5bda`；独立工作树 `/Users/xiexin/.codex/worktrees/0b24/pa-investment-research`，托管 detached HEAD，目标分支 `codex/pab-29-image-security-hardening`。

## 能力映射

| 用户动作 | 现有入口/接口 | 权威状态及副作用 | 重叠或缺口 | 决策 | 证据/未知 |
|---|---|---|---|---|---|
| 构建运行镜像 | Dockerfile、build-investment-container-app.ts | pnpm production deploy 与独立 sidecar，单次构建 | 基镜像和部分运行依赖存在可修复告警 | Extend | 旧镜像 Trivy 报告；升级后需 Linux 重建 |
| 打包 Python 后端 | build-investment-python-sidecar.ts、investment-backend-package-policy.ts | 暂存目录、白名单、哈希描述文件 | 第三方 py_vapid 测试私钥不属于后端白名单范围 | Extend | py-vapid 1.9.4 的测试文件与官方 wheel 哈希一致 |
| 验证候选身份 | investment-container.yml 的 config ID、源码标签、docker save | 同一受测归档进入 artifact 和 publish | 尚无全层安全门禁 | Extend | 旧归档 config ID c53ef7ac…；既有发布不重建 |
| 阻止带秘密的产物上传 | 既有一次性全层审计脚本 | 只读解析所有历史层及 metadata | CI 尚未调用，归档解包需资源限制和链接保护 | Create | ops 下新增离线门禁，复用审计算法；不增加服务 |
| 阻止漏洞镜像发布 | 官方 Trivy 镜像归档扫描 | 最终文件系统、包版本、漏洞数据库 | 无确定性裁决及缺失报告阻断 | Compose | Trivy 与现有 image-smoke/upload/publish 顺序组合 |

## 确定性规则

身份、层哈希、扫描器版本及发行 SHA256、报告结构、严重性、退出码和上传顺序全部由代码决定，不调用模型裁决。全历史层秘密扫描不应用 whiteout 合并，也不覆盖同路径的旧条目；包括完整 config/history、归档路径和链接目标元数据。只复制常规文件，不创建或跟随镜像链接，不执行镜像代码。扫描工作目录私有、临时、受容量与时间限制。

Gitleaks 所有命中阻断；Trivy HIGH/CRITICAL/UNKNOWN 阻断，不忽略未修复漏洞。工具错误、超时、警告导致的不完整扫描、报告缺失或身份不一致均阻断。只有安全摘要允许上传，原始报告、扫描日志和秘密正文不得进入 Actions 输出/artifact。当前没有授权例外；精确误报候选也继续阻断。后续例外须另行提交具体漏洞/规则、包版本及文件/层哈希、证据、到期日期和审核授权，禁止目录级或全部未修复豁免。

## 实施顺序

1. 为归档旧层秘密、metadata、链接/路径、扫描失败/超时/缺失报告、身份不符和输出脱敏编写先失败测试。
2. 在 sidecar 描述文件生成之前精确清理 py_vapid/tests，核对包版本与测试文件哈希，保留运行模块与 dist-info；变更来源时阻断而非盲删。
3. 添加官方固定版本/校验下载和隔离扫描，绑定归档 SHA256、config ID、源码 SHA、层 diff IDs；发布前再次检查安全摘要身份。
4. 核验官方依赖版本与兼容范围后升级必要依赖，保持现有产品行为；无法证明可用的升级保留为阻塞项。
5. 运行授权的聚焦测试、actionlint、diff 检查，形成中文验收证据并更新既有 PAB-29 进展。

## 失败恢复与验证边界

门禁失败时不上传候选镜像、不进入 GHCR publish；删除临时扫描资料，只输出固定错误类别、计数与下文规定的脱敏定位摘要。修复后必须重新构建和扫描同一候选归档，不复用旧镜像通过结论。没有部署或数据格式变化，代码可回退，但不得为放行产物绕过安全门禁。

本方案不修改共享引用、公开 GHCR、部署或操作生产；本地不安装/运行 Docker，不启常驻服务，不操作共享 3080。Linux 实际重建、依赖加载、同一镜像扫描及 Compose 验收由 PR CI 完成。负责人为后续 CI 实施代理与维护者；关闭期限为首次发布该加固候选之前，证据需包含 run、源码 SHA、归档 SHA256、config ID、扫描器/数据库版本、零阻塞结果和运行回归。

## 表格导入体验契约

目标用户为导入券商持仓表的投研用户；主要动作仍为选择 `.xls/.xlsx`、查看首工作表解析预览、确认后替换持仓。复用 `holdings-import.ts` 与原导入弹窗，状态由原调用方持有（决策 Reuse）；本次仅替换官方 SheetJS 版本，不改组件、数据字段、中文文案、页面层级、主题、键盘或响应式规则。

| 状态 | 适用性与验证 |
|---|---|
| 加载、禁用 | 适用，沿用文件读取过程和原按钮逻辑 |
| 空数据、错误 | 适用，覆盖空首表、损坏输入 |
| 部分成功 | 适用，沿用逐行错误与有效行预览，不能自动导入错误行 |
| 成功、确认/撤销 | 适用，保留预览及用户确认边界，解析函数无持久化副作用 |
| 刷新、筛选无结果、过期 | 不适用，本次操作为一次本地文件解析，无远端刷新、筛选或时效状态 |
| 无权限 | 解析函数不管理认证，沿用上层权限，不增加新入口 |

聚焦导入回归和构建验证依赖兼容性；本次禁止启动常驻服务，真实产品上传文件、预览、确认及主题/视口验收仍未验证，不能以单元测试代替 UI 完成证据。

## 依赖来源与保留告警

| 对象 | 本次修改 | 核验来源与边界 |
|---|---|---|
| Node 基镜像 | 24.8.0 → 24.21.0，build/runtime 同一固定 index digest `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`；同层 apt upgrade | [Node 官方发行](https://nodejs.org/en/blog/release/v24.21.0)、[Docker 官方 repo-info](https://github.com/docker-library/repo-info/blob/master/repos/node/remote/24.21.0-bookworm-slim.md)；registry 在本机不可达，摘要从官方 repo-info 读取，Linux CI 必须实际拉取核对 |
| fast-uri | 3.1.3 → 3.1.6 精确 override | [官方 npm 元数据](https://registry.npmjs.org/fast-uri/3.1.6)，同主版本，不新增依赖 |
| ip-address | 10.2.0 → 10.3.1 精确 override | [官方 npm 元数据](https://registry.npmjs.org/ip-address/10.3.1)，同主版本；旧基镜像工具链中的 9.0.5 不用跨主版本 override 盲替换 |
| js-yaml | 所有匹配 4.x 当前依赖 → 4.3.2 精确 override | [官方 npm 元数据](https://registry.npmjs.org/js-yaml/4.3.2)，沿用 argparse 2.x；loader/CLI 的 YAML 消费需聚焦验证 |
| sharp | 0.35.3 → 0.35.4，包含对应 @img 平台包 | [官方 npm 元数据](https://registry.npmjs.org/sharp/0.35.4)，Node 要求 ≥20.9.0；目标 Linux 原生库仍需 CI 运行证据 |
| SheetJS xlsx | 0.18.5 → 官方 CDN 0.20.3 原始归档，随 UI 包存放并通过 `file:` 引用，由 pnpm 记录 SHA512 integrity | [官方本地归档方式](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/#vendoring)，保留 `xlsx/xlsx.mjs` 现有入口；不使用非官方 fork |
| py-vapid | 不升级或改运行代码，精确删除两个测试文件 | [官方 PyPI 1.9.4](https://pypi.org/pypi/py-vapid/1.9.4/json)，wheel 下载摘要与两个文件摘要均实际核对；策略中固定文件哈希 |

ChromaDB 1.5.9 的旧报告含 CVE-2026-45829、45830、45831、45833，未提供修复版本。
[45829 官方公告](https://github.com/advisories/GHSA-f4j7-r4q5-qw2c) 描述 Chroma HTTP collections
接口接受不可信模型仓库与远端代码选项。本项目 `adapter/engine_bridge.py` 在所有配置覆盖之后
强制 `memory_enabled=false`；`trading_graph.py` 的 memory 分支才创建 Chroma manager。
`test_engine_depth.py` 的 3 个测试验证了配置覆盖后仍关闭 memory。runtime 的服务启动采用
`python -m uvicorn` 加 sidecar 中三个后端模块，没有配置 `chroma run` 或 `chromadb.server` 入口。
仓库内其他 Chroma 调用使用 `chromadb.Client(Settings(...))`；旧镜像实际包的默认实现为
`chromadb.api.rust.RustBindingsAPI`，但 Settings 继承 BaseSettings、可读取环境与 `.env`，且包中
仍存在 HTTP 客户端/服务及 embedding 实现。因此只能说明正常 adapter 分析路径没有启动该
memory/HTTP 服务，不能证明整包、其他调用或所有部署环境不可达。本次不创建豁免，保持阻断。

CVE-2023-45853 的 [Debian 官方跟踪](https://security-tracker.debian.org/tracker/CVE-2023-45853)
指出 MiniZip 与 zlib 发行构建的适用性差异。旧候选没有发现 minizip/libminizip/pyminizip；
这只是精确误报核验候选，新镜像仍需检查最终包清单及发行版状态。本次没有授权例外。
第三方仍有 AkShare/Tushare 常量等秘密候选，未盲删运行代码、未验证 token 有效性；命中仍阻断。
不能将旧镜像的 11 严重/114 高危计数称为升级后残余计数，后者尚待新 Linux 镜像扫描。

## 本次验收记录（2026-09-21）

环境：macOS arm64，Node 24.15.0，仓库要求的 pnpm 11.7.0（经隔离 COREPACK_HOME 调用），
Python 3.14.4。源码为上述基准加本 PR 的安全加固实现；执行本地验证时改动尚未提交，没有修改共享引用。

| 实测命令/对象 | 结果 |
|---|---|
| `pnpm exec vitest run scripts/investment-container.spec.ts scripts/build-investment-python-sidecar.spec.ts scripts/investment-backend-package-policy.spec.ts packages/client/ui-investment-research/tests/holdings-import.client.spec.ts packages/attachment/attachment-local/tests/image.spec.ts packages/preset/agent-presets/tests/metadata.spec.ts`（frontend 内） | 6 文件、68 测试通过 |
| `python3 -B -m unittest discover -s ops/pa-investment -p 'test_*.py'` | 42 测试中 41 通过、1 GNU tar/Linux 专用恢复用例跳过；其中新增门禁 15 项通过 |
| `PYTHONPATH=backend/dsh-trading-core python3 -B -m unittest discover -s backend/dsh-trading-core/tests -p 'test_engine_depth.py'` | 3 测试通过，提供 adapter memory 关闭证据 |
| `pnpm run build:lib`、`pnpm run build:web`（frontend 内） | 均通过；Web 保留既有大 chunk 提示，无构建错误 |
| `pnpm exec tsc --ignoreConfig --types node --strict --noEmit --skipLibCheck --module nodenext --target es2022 --allowImportingTsExtensions scripts/investment-backend-package-policy.ts scripts/build-investment-python-sidecar.ts` | 聚焦脚本类型检查通过 |
| `actionlint 1.7.12 .github/workflows/investment-container.yml`、`git diff --check` | 通过 |
| 官方扫描器下载器的真实 `install` 调用 | Linux 发行包 SHA256 均通过；只下载与解包，没有在 Mac 执行 Linux 二进制 |
| 实际 py-vapid 文件副本运行默认清理器 | tests 目录剔除，`__init__.py` 哈希不变，dist-info 保留；没有执行第三方 Python 代码 |
| 真实 Gitleaks 8.30.1 对两层无效私钥测试夹具扫描 | 退出 10、发现 1 项，后续 whiteout 删除不掩盖旧层；未输出匹配正文 |
| 当前门禁扫描旧候选归档 | 退出 1，固定类别 `secret-findings-block-publication`；在秘密阻断后不继续执行漏洞扫描，不产出通过摘要 |
| 当前确定性裁决读取旧 Trivy 报告 | 严重 11、高危 114、未知 3，阻断；旧报告身份与各层 diff IDs 核对，不作为新镜像结果 |

首次依赖安装遇到系统 pnpm 10 与锁文件不兼容以及网络下载超时，使用仓库版本、隔离缓存和延长下载超时后完成 frozen 安装，禁用了生命周期脚本。首次单独编译 client 缺 host 生成的 remote 声明，按现有 `build:lib` 顺序完成后已关闭；未为环境问题修改业务代码。

已验证的关键负例还包括：目录穿越、读取链接目标阻止、重复路径的旧内容保留、扫描错误/超时、
错误/缺失报告、不同镜像身份、不完整包清单、资源上限、秘密正文不进入 CLI/摘要、变更归档不能
复用通过摘要、未经核验的依赖文件不会被清理、失败不能替换原 sidecar。无宽泛忽略或授权例外。

未验证：Linux 新基镜像拉取与构建、Linux native/Python 依赖加载、该新镜像的全层扫描与
实际残余告警、Compose smoke、真实产品文件上传/预览/确认（含主题与视口）。没有本机 Docker、
共享 3080、生产、SSH、GHCR 可见性、Environment 或 workflow_dispatch 操作。
验证债务负责人为后续 CI 实施代理与维护者，到期点为首次发布该候选前；关闭条件为获准 PR CI
产出的源码 SHA/归档 SHA/config ID、一致的扫描通过摘要、运行回归及真实导入验收证据。
ChromaDB、第三方秘密候选与 MiniZip 适用性仍是明确的后续阻断项；本次不能宣称镜像全部安全，
PAB-29 保持 In Progress。

## PR #136 生产打包回归修复（2026-09-21）

首轮 Linux 镜像及三个桌面平台的 CI 均在生产 `pnpm deploy --prod --legacy` 阶段报 `ERR_PNPM_EXOTIC_SUBDEP`：SheetJS 官方 URL 在工作区内作为直接依赖安装成功，但生产依赖树中的同一 UI 包成为间接依赖，触发 pnpm 的远程来源限制。此前的单元测试和编译没有覆盖实际生产 deploy。

修复采用官方建议的本地归档方式，将原始 `xlsx-0.20.3.tgz` 放入 UI 包的 `vendor/`，通过 `file:vendor/xlsx-0.20.3.tgz` 引用，并在发布文件清单及其工作区约束中登记精确文件名。归档的 SHA512 与原 CDN 锁定值完全一致；包内源码、版本和许可证均未改动。工作区显式保持 `blockExoticSubdeps: true`，没有添加 URL 豁免或关闭供应链检查。来源、摘要和升级规则见该目录的 `README.md`。

在 macOS arm64 上使用仓库固定 pnpm 11.7.0 完成以下验证：

- frozen lockfile 安装及 1526 项供应链策略校验通过；锁文件仅替换 SheetJS 的来源路径，其他平台的可选依赖保持原状。
- 容器所用 CLI 与桌面端 Electron 的两条真实 `pnpm deploy --prod --legacy` 均通过，依赖生命周期脚本正常执行，输出位于隔离临时目录。
- 两份部署产物内的 SheetJS 归档 SHA512 均匹配；按实际 ESM 入口 `xlsx/xlsx.mjs` 加载并往返写入、读取中文持仓表成功，依赖解析路径位于各自产物内。
- 持仓导入和容器约束两份 Vitest 文件共 21 项通过；第三方声明校验、工作区约束及 diff 检查通过。

这些证据关闭本次依赖部署失败的本地回归验证。新提交的 Linux 镜像构建、安全扫描及各平台完整打包仍需 CI 结果；前述安全告警、Compose 和真实产品 UAT 的发布阻断条件保持有效。

## PR #136 安全门禁脱敏诊断（2026-09-21）

提交 `72382ae` 的三个桌面平台打包及类型检查均已通过。[Linux run 35574599795](https://github.com/PABIPRG/pa-investment-research/actions/runs/35574599795) 的镜像构建、边界检查和 Compose smoke 通过，但全层秘密检查以 `secret-findings-block-publication` 阻断；镜像 artifact 未上传，Trivy 尚未运行。原日志只有错误类别，无法区分 Gitleaks 命中与敏感路径命中，不能据此判为误报或无影响。

本次只扩展失败诊断，不改变检测范围、阻断条件、例外策略或上传顺序。日志中的 JSON 单独绑定源码 SHA、镜像 ID、归档 SHA256，标记 `passed: false` 和 `vulnerabilityScan: not-run`，不写入可供发布复核的安全摘要。只输出固定规则标签（`generic-api-key`、`private-key`；其他为 `other` 加规则名哈希）、完整分类计数及每类最多 50 条样本；样本含层号、条目序号、固定来源类别、路径 SHA256 和扫描文件行号，不含原始路径、嵌套成员名、秘密值、匹配文本、作者或报告指纹。无法映射的位置只保留路径哈希，不能猜测其所属包。所有命中和格式异常仍阻断，临时资料仍自动删除。

验证：先运行新增测试并观察失败，再实现诊断；ops Python 共 47 项，46 通过、1 项 Linux GNU tar 专属测试在 macOS 跳过。真实 Gitleaks 8.30.1 对两层无效私钥夹具检出 1 项，正确定位旧层及条目，后层 whiteout 不掩盖命中；嵌套 ZIP 夹具也正确定位外层文件。日志无原始路径/正文、无通过摘要，临时扫描目录已清理。新候选的 Linux 扫描结论仍以更新后的 CI 为准。

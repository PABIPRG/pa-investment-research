# PAB-29 镜像安全加固设计与实施计划

关联：[PAB-29](https://linear.app/pabiprg/issue/PAB-29)，里程碑 `0.2.0-alpha.3`，状态保持 In Progress。
基准：`ba13a94ac41157fd658d5dcc31258957108c5bda`；独立工作树 `/Users/xiexin/.codex/worktrees/0b24/pa-investment-research`，托管 detached HEAD，目标分支 `codex/pab-29-image-security-hardening`。

## 能力映射

| 用户动作 | 现有入口/接口 | 权威状态及副作用 | 重叠或缺口 | 决策 | 证据/未知 |
|---|---|---|---|---|---|
| 构建运行镜像 | Dockerfile、build-investment-container-app.ts | Trixie 构建 pnpm production deploy 与独立 sidecar，Distroless 只承载运行产物 | 普通 Debian slim 运行层包含应用不需要且暂无稳定版修复的系统工具 | Extend | 精简为官方 Node 24 Debian 13 Distroless；Linux CI 验证 ABI、Compose 和扫描 |
| 打包 Python 后端 | build-investment-python-sidecar.ts、investment-backend-package-policy.ts | 暂存目录、白名单、哈希描述文件 | 第三方 py_vapid 测试私钥不属于后端白名单范围 | Extend | py-vapid 1.9.4 的测试文件与官方 wheel 哈希一致 |
| 容器执行投研图 | adapter/engine_bridge.py、trading_graph.py | adapter 在合并配置后强制关闭 memory；桌面目标可启用 Chroma memory | 图模块曾在关闭 memory 时仍顶层导入 Chroma，使容器必须携带整套依赖 | Extend | 将 memory 导入移入启用分支；只从 Linux 锁移除 Chroma 闭包，桌面锁保留 |
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
| Node 构建/运行基线 | 构建阶段使用 Node 24.21.0 Trixie Linux amd64 manifest digest `sha256:b64fccfbcd1ae10d11b969a868b50e1c2530a7054813d5cdea04ac3bce551697`；运行阶段使用 Node 24 Debian 13 Distroless digest `sha256:4ac45c93b6c4b2304876569196e5962e55e8ba4ba095e7dde7bf6d7e00efc3b8` | [Node 官方发行](https://nodejs.org/en/blog/release/v24.21.0)、[Docker 官方 repo-info](https://github.com/docker-library/repo-info/blob/master/repos/node/remote/24.21.0-trixie-slim.md)、[Distroless 官方支持列表](https://github.com/GoogleContainerTools/distroless#what-images-are-available)；运行镜像无 shell/包管理器，Linux CI 必须实际拉取并核对 Node 24、ABI 和运行行为 |
| fast-uri | 3.1.3 → 3.1.6 精确 override | [官方 npm 元数据](https://registry.npmjs.org/fast-uri/3.1.6)，同主版本，不新增依赖 |
| ip-address | 10.2.0 → 10.3.1 精确 override | [官方 npm 元数据](https://registry.npmjs.org/ip-address/10.3.1)，同主版本；旧基镜像工具链中的 9.0.5 不用跨主版本 override 盲替换 |
| js-yaml | 所有匹配 4.x 当前依赖 → 4.3.2 精确 override | [官方 npm 元数据](https://registry.npmjs.org/js-yaml/4.3.2)，沿用 argparse 2.x；loader/CLI 的 YAML 消费需聚焦验证 |
| sharp | 0.35.3 → 0.35.4，包含对应 @img 平台包 | [官方 npm 元数据](https://registry.npmjs.org/sharp/0.35.4)，Node 要求 ≥20.9.0；目标 Linux 原生库仍需 CI 运行证据 |
| SheetJS xlsx | 0.18.5 → 官方 CDN 0.20.3 原始归档，随 UI 包存放并通过 `file:` 引用，由 pnpm 记录 SHA512 integrity | [官方本地归档方式](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/#vendoring)，保留 `xlsx/xlsx.mjs` 现有入口；不使用非官方 fork |
| py-vapid | 不升级或改运行代码，精确删除两个测试文件 | [官方 PyPI 1.9.4](https://pypi.org/pypi/py-vapid/1.9.4/json)，wheel 下载摘要与两个文件摘要均实际核对；策略中固定文件哈希 |

ChromaDB 1.5.9 的旧报告含 CVE-2026-45829、45830、45831、45833，未提供修复版本。
[45829 官方公告](https://github.com/advisories/GHSA-f4j7-r4q5-qw2c) 描述 Chroma HTTP collections
接口接受不可信模型仓库与远端代码选项。本项目 `adapter/engine_bridge.py` 在所有配置覆盖之后
强制 `memory_enabled=false`，容器运行路径不创建 memory。此前 `trading_graph.py` 仍顶层导入
memory 模块，使关闭功能也必须安装 Chroma。现将该导入移入 `memory_enabled` 分支，并只从
`linux-x64` 运行锁删除 ChromaDB 及其 36 个专用传递依赖；macOS/Windows 桌面锁继续保留
ChromaDB 1.5.9 和原有 memory 能力。该处理不依赖漏洞豁免；Linux CI 必须证明 sidecar 安装、
图加载、Compose smoke 和完整扫描均通过，才能关闭此项阻断。

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

## 容器测试载荷清理与完整安全结果（2026-09-21）

`c61e8fbc03` 的 [Linux CI 35577389001](https://github.com/PABIPRG/pa-investment-research/actions/runs/35577389001/job/106262211249) 构建和 Compose 通过，秘密规则命中 69 条，敏感路径为 0。路径指纹比对发现五个不参与运行的测试文件触发 12 条命中；另有普通变量引用、公开文档示例、公共签名材料和第三方运行常量，需要逐项判断，不能整体放行。

以下清理发生在构建暂存目录、进入运行镜像层之前。Node 产物在工作区链接实体化后清理，Linux Python 在收集 `runtime.json` 文件哈希前清理。每组先验证所有文件再删除，仅处理表内文件；遇到内容漂移、已安装包中缺失文件或符号链接就失败，保留其余文件和许可证。

| 来源 | 相对文件 | SHA256 |
|---|---|---|
| Zod 4.4.3 | `src/v4/mini/tests/string.test.ts` | `efb9ef22f2179e700a2033edd4e1e03a6fe4f6b95fa4bc0bd29223065e1ec0a0` |
| Zod 4.4.3 | `src/v4/classic/tests/string.test.ts` | `a69bdc042c58e8d940e6a5f09ed93646e697af04869a65cf45e9244e950cfb06` |
| 仓库 session-telemetry | `tests/redact.spec.ts` | `f3d6c306aa2b61b28db31ee066fb3abac6118ad2ef6c7cafe11d85ad802e795e` |
| Kubernetes 36.0.3 | `kubernetes/aio/config/kube_config_test.py` | `2e98b92ea15cf277de5738ee1430ee29718940c547367680d533fe63a6b9ca48` |
| NumPy 2.2.6 | `numpy/random/tests/test_generator_mt19937.py` | `67b0fc3dc885a1a605fd70ad20d1f37e3a2f5991ea816995389d948ef3645a53` |

来源核对：[Zod npm 发行包](https://registry.npmjs.org/zod/4.4.3)、[Kubernetes PyPI 36.0.3](https://pypi.org/pypi/kubernetes/36.0.3/json)、[NumPy PyPI 2.2.6](https://pypi.org/pypi/numpy/2.2.6/json)。实际下载发行归档并核对其完整 integrity/SHA256 和表内文件哈希；仓库测试文件与当前源码哈希相同。这是打包内容清理，不是秘密扫描例外。

同时修正串行检查只暴露首个阻断的问题：秘密检查完成后，即使有命中，也继续进行同一归档的漏洞扫描；两类结果汇总后统一阻断。秘密诊断先标记漏洞扫描 pending，完整结果标记 completed；失败摘要绝不能用于发布，异常/超时仍立即阻断。脱敏样本上限从 50 提至 100，并加入完整文件 SHA256，便于将新候选与官方发行内容精确比对；漏洞只输出规范 CVE/GHSA 编号与计数。例外清单仍为空。

本地验证：五份真实文件使用与 CI 相同的 Gitleaks 参数复现 12 条命中，精确清理后为 0；真实 CLI production deploy、工作区链接实体化、清理及默认 profile 插件解析通过。首次生产打包因沙箱 DNS 失败，获得联网执行权限后按同一构建入口成功重试。新的 Linux 镜像仍需 CI 证明整体剩余命中和漏洞情况，不将局部清理等同于镜像安全通过。

聚焦自动验证：4 个 Vitest 文件共 44 项通过；ops Python 共 49 项，48 通过、1 项 Linux GNU tar 专属用例在 macOS 跳过；新增清理器及其测试的严格类型检查、受影响脚本 lint、actionlint 与 diff 检查通过。

## Trivy 完整性判定修正与剩余测试载荷（2026-09-21）

`a34e684993` 的 [Linux CI 35580274265](https://github.com/PABIPRG/pa-investment-research/actions/runs/35580274265/job/106271298853) 镜像构建、边界检查和 Compose smoke 通过；秘密命中从 69 降至 57，敏感路径为 0。Trivy 已执行，但其成功扫描后的严重性来源通知被门禁当作 `scanner-incomplete`，因此没有汇总漏洞结果，镜像未上传或发布。

已用固定版本 Trivy 0.74.0 对保存的镜像归档复现：退出码为 0、报告完整，通知仅说明部分漏洞采用其他厂商评级，见[官方严重性选择说明](https://trivy.dev/docs/v0.74/guide/scanner/vulnerability/#severity-selection)。修正仅匹配该版本完整固定通知，且限定 `trivy image` 成功退出；其他警告、错误、改变后的文本仍阻断。真实扫描经过修正后的入口能够读取报告，原有 HIGH、CRITICAL、UNKNOWN 阈值保持不变；旧归档计数不作为新候选结果。

完整诊断还定位到以下两个官方 wheel 内的非运行测试文件。发行归档 SHA256 与文件 SHA256 均已核对，按相同精确清理规则加入清单：

| 来源 | 相对文件 | SHA256 |
|---|---|---|
| [pywebpush 2.5.0](https://pypi.org/pypi/pywebpush/2.5.0/json) | `pywebpush/tests/test_webpush.py` | `e0b6f8a8bb5e830d67a2337693b1f93558a48797c6881798a645c97357d2ac23` |
| [websocket-client 1.9.0](https://pypi.org/pypi/websocket-client/1.9.0/json) | `websocket/tests/test_websocket.py` | `3513609599e545922bc911b16107695064cf934022e37eb01e80353b0e580b99` |

七份真实文件以 CI 同参数 Gitleaks 复现 15 条命中，精确清理后为 0，许可证保留。4 个 Vitest 文件 44 项、清理器严格类型检查和受影响脚本 lint 通过；ops Python 50 项，49 通过、1 项 GNU tar 专属用例在 macOS 跳过。其他依赖文件命中及漏洞仍需审查，`exceptions` 仍为空，不以局部清理或通知修正宣称镜像安全通过。

## 新镜像完整结果与 npm 工具链补丁（2026-09-21）

`b49b33febd` 的 [Linux CI 35582415199](https://github.com/PABIPRG/pa-investment-research/actions/runs/35582415199/job/106278063614) 构建、边界、Compose 启动/健康/退出检查通过，两类扫描完整执行。秘密命中为 54，敏感路径为 0；漏洞为 CRITICAL 6、HIGH 58、UNKNOWN 1，按安装位置统计，共 27 个阻塞编号。镜像 ID 为 `sha256:5f62fdccdf0abe9299a22ceeec1bc8ae744360a0d5999f8cf387f76c89d37bba`，归档 SHA256 为 `3db8a8657d07c1c465af534b8d4a11818267b5150bbf4a2b4a3961d41ccfe95b`，CI 合并测试源码为 `3a9e17998fcaf43ca0692865ab15c21e7b1e0e80`。Trivy 数据库更新时间为 2026-09-21 07:13:21 UTC；没有上传镜像 artifact 或发布 GHCR。

其中 CVE-2026-14257、CVE-2026-69152、CVE-2026-69192、CVE-2026-73566 对应 Node 24.21.0 随附 npm 11.19.0 的 brace-expansion 5.0.7、ip-address 10.2.0、tar 7.5.19。已核验 [Node 官方固定源码](https://github.com/nodejs/node/tree/v24.21.0/deps/npm) 与 [npm 11.19.1 官方发行信息](https://registry.npmjs.org/npm/11.19.1)：补丁版完整发行包包含 brace-expansion 5.0.9、ip-address 10.5.0、tar 7.5.22。

Dockerfile 使用独立下载阶段，固定官方 npm 归档 SHA256 `9f58bff01604cb1b14008fef14dceb14d836a49225e45c6c2e37de3be3e707f0`，运行镜像构建时只读挂载、离线全局安装、禁用脚本和审计网络并删除缓存。保留 npm/npx，不跨 npm 主版本，也不修改项目锁文件或应用依赖。全历史层秘密扫描照常包含旧 npm 文件，不能用后续覆盖隐藏旧层。

本地隔离前缀完成相同官方归档的离线安装，核对 npm 和三个随附依赖的实际版本；真实 Trivy 0.74.0 rootfs 扫描识别 144 个包，HIGH/CRITICAL/UNKNOWN 为 0。13 项容器契约测试通过。新运行镜像整体结果仍需后续 CI 证明，不能用 npm 子树的通过结论代替。

54 条秘密命中的内容哈希全部与受限本地来源一致：48 条归入文档示例、类型/变量引用、文件哈希、公开证书/签名材料或 OAuth 公共标识候选，6 条涉及第三方运行常量。Node 当前发行包的 npm 文档与 Corepack 文件另经官方整包 SHA256 和逐文件哈希核对，Corepack 两份签名材料可解析为 EC 公钥。上述分类仍非例外授权；运行 token 候选、ChromaDB 及基础系统告警继续阻断，未以第三方公开发行或正常路径关闭 memory 证明其无影响。

## Linux 容器依赖收敛与 Trixie 基线（2026-09-21）

`a2c8b9ffcf` 的 [Linux CI 35584055076](https://github.com/PABIPRG/pa-investment-research/actions/runs/35584055076/job/106283168440) 完成镜像构建、边界检查、Compose 启动/健康/退出和两类扫描，最终由 `security-findings-block-publication` 正确阻断。秘密命中为 61，敏感路径为 0；漏洞为 CRITICAL 6、HIGH 54、UNKNOWN 1，共 23 个阻塞编号。镜像 ID 为 `sha256:cac3f2b6cb0b2599481377de5342f8a0c6ce1d098d10abb13b1b3a0ed7037b2c`，归档 SHA256 为 `bfbc928ec20469d87d49040cc21e391d781b596ad7123e6ceed451a8995211b4`，CI 合并测试源码为 `2f52e640cf1bf30211a29fa87665c7bea4578b33`。npm 补丁已消除前述四个工具链漏洞；镜像 artifact 和 GHCR publish 仍被跳过。

基础系统的阻塞告警中，Debian 已在 Trixie 修复 Bookworm 仍受影响的 util-linux 与 Perl 漏洞。build/runtime 因此统一改用官方 `node:24.21.0-trixie-slim` 的 Linux amd64 manifest digest，并继续在同层执行安全更新。该摘要来自 docker-library 官方 repo-info；不能用来源核对代替 CI 实际拉取、构建和扫描。

ChromaDB 在 Linux 容器中属于已关闭的 memory 能力，但此前顶层导入使包仍成为启动依赖。现有容器 adapter 在应用外部配置后强制 `memory_enabled=false`，所以将 memory 模块导入移入启用分支，并从 Linux 锁精确删除 ChromaDB 及由旧镜像 `dist-info` 依赖图计算出的 36 个专用传递依赖，共 37 个包。macOS/Windows 锁保持 ChromaDB 1.5.9，桌面 memory 能力不变；其他后端直接依赖保持原版本。

本地聚焦验证包括 4 个 Vitest 文件共 44 项、`test_engine_depth.py` 4 项、图模块语法编译、锁文件摘要和 `git diff --check`，均通过。本机成功下载并校验固定 Linux CPython 归档，但 macOS 无法执行 Linux ELF，sidecar 安装在启动 Linux Python 时返回 `ENOEXEC`；这不是通过证据。实际依赖安装、图加载、Compose smoke 和完整安全结果必须由下一次 Linux CI 给出，结果出来前 PR 继续保持 Draft，`exceptions` 继续为空。

## Trixie 完整扫描与 Distroless 运行层（2026-09-21）

`56034cf907` 的 [Linux CI 35615318536](https://github.com/PABIPRG/pa-investment-research/actions/runs/35615318536/job/106384390633) 实际拉取 Trixie、安装裁剪后的 Linux sidecar，并通过镜像构建、边界检查、Compose 启动/健康/正常退出和归档导出。完整门禁仍以 `security-findings-block-publication` 阻断；秘密命中为 43，敏感路径为 0，漏洞为 CRITICAL 0、HIGH 43、UNKNOWN 2，共 10 个阻塞编号。镜像 ID 为 `sha256:050c26303e3fb36bedfa94bdc61b51354a0cc0d25edfb29663894de2bae1e66e`，归档 SHA256 为 `b900acdda202cb74b0b76b3042730e7722294d22be2d52596539cce4ba37a50b`，CI 合并测试源码为 `b1deb497f602a2cf7e04679c40be3a8e9a400918`。artifact 上传和 GHCR 发布均被跳过。

Chroma 裁剪和 Trixie 升级使 CRITICAL 6 → 0、HIGH 54 → 43、秘密命中 61 → 43、阻塞编号 23 → 10，证明 sidecar 依赖边界可运行。剩余 HIGH 全部来自普通 Debian slim 运行层中的 ncurses、systemd、acl、util-linux 和 Perl；其中 util-linux 的新问题在 Trixie 尚无稳定版修复。继续升级同一 slim 家族不能消除这些非运行工具，因此运行阶段改用官方 Node 24 Debian 13 Distroless，只保留 Node、glibc/编译运行库、CA 和时区等运行依赖；构建阶段继续使用固定 Node 24.21.0 Trixie。

Distroless 没有 shell、apt、npm 或 Corepack。容器的 `dsh plugin` 命令依赖 pnpm，而当前运行镜像没有提供 pnpm，继承的 npm 单独存在并未形成可用插件安装路径；固定投资研究 profile 仍由构建阶段完整部署。CI 中原先依赖 `sh/find/test` 的镜像内部检查改为只使用 Node 标准库的 `investment-container-check.mjs`，覆盖复制树中的失效符号链接和持久卷锁状态；可解析的生产依赖链接继续允许。运行用户继续为数值 UID/GID `10001:10001`，`HOME` 与 `DSH_HOME` 均为持久卷目录；Compose 的只读根文件系统、cap drop、tmpfs、秘密挂载和持久卷边界不变。新基线的实际 Node 版本、Python native 依赖、Compose 和全量扫描仍须下一次 Linux CI 证明；当前不能宣称安全门禁通过。

`8fbf7ad096` 的 [Linux CI 35618915969](https://github.com/PABIPRG/pa-investment-research/actions/runs/35618915969/job/106396714530) 已实际拉取固定 Distroless 摘要并通过镜像构建、Node 24 与数值用户边界、复制树链接检查、Compose 启动/健康、优雅停止、卷锁清理和归档导出。完整门禁仍以 `security-findings-block-publication` 阻断；秘密命中为 26，敏感路径为 0，漏洞为 CRITICAL 0、HIGH 1、UNKNOWN 0，唯一阻塞漏洞为 `CVE-2026-14456`。镜像 ID 为 `sha256:ecd3efaaddc43fdc3dfc7bb10ec3471669eaf85bd1d1ddf75a6dd708b9fb3cf7`，归档 SHA256 为 `49601f2a4e5d23cb58c585e8b1a15186191e7c5040a1df46802092c06966ffe3`，CI 合并测试源码为 `ccf8943dd6fcf8960debd39cffd8bbca19ff2ae7`；artifact 上传和 GHCR 发布均被跳过。

哈希反查确认 26 个秘密规则命中均位于固定公开依赖：Node 模型数据完整性清单与 TypeScript 声明共 15 个，Python 类型存根、Windows 专用标准库、公开数据源常量和 protobuf 生成代码共 11 个；没有业务代码、配置、环境文件或运行状态命中。构建阶段继续对不参与运行的文件执行先全量哈希验证、后裁剪，并把模型清单收敛到运行时唯一读取的 `generatedAt` 字段；运行语义不可删除的第三方源码继续保留，门禁不增加例外。`CVE-2026-14456` 来自 Distroless 中 OpenSSL 3.5 的 QUIC 服务端资源耗尽问题，Debian Trixie 已在 `3.5.7-1~deb13u2` 修复；运行基线因此更新到 2026-09-15 已被 Dependabot 公开解析的固定摘要 `bb6b03d81066…`，仍须下一轮完整 Linux 扫描证明实际修复和剩余命中数。

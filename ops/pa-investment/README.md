# aly 受控部署运维手册（PAB-29）

本目录扩展 PAB-20 的容器交付，目标是既有 Linux 服务器 **aly**，不是在 Mac 部署。GitHub 托管 runner 构建和测试镜像；公开 GHCR 保存镜像；管理员批准后，通过既有 Tailscale OIDC/SSH 调用服务器固定入口。Mac 不需要 Docker，服务器不需要 Git、Node、pnpm 或构建工具。

这份代码进入仓库不代表生产链路已启用。首次启用必须完成下列检查；不能以单元测试代替 Linux 容器测试、服务器检查、业务验收和恢复演练。设计与追溯见 [PAB-29 规格](../../docs/superpowers/specs/2026-09-21-pab29-controlled-deployment.md)。

## 固定目标与权限边界

| 项目 | 既有目标 / 新入口 |
|---|---|
| SSH | `pa-deployer@aliyun-vps.felis-pollux.ts.net`；人工维护仍通过 `ssh aly` 的 admin 账号 |
| Compose | `/home/admin/pa-investment-deploy/compose.yaml`；项目 `pa-investment-research`，服务 `investment` |
| 配置与 secret | 同目录 `.env` 和 `web-admin-password.hash`；不覆盖现有 Compose/反代配置 |
| 唯一持久卷 | `pa-investment-research_dsh-data` → `/var/lib/dsh`；Docker 默认本地卷根目录 |
| 网络与健康入口 | 复用 `1panel-network`；`https://pair-demo.xiexin.dev/healthz` |
| 镜像 | `ghcr.io/pabiprg/pa-investment-research@sha256:<64位digest>`，只支持 Linux amd64 |
| root 部署入口 | `/usr/local/sbin/pa-investment-deploy`，无参数，stdin 仅一行镜像 digest |
| 安装脚本 | `/usr/local/libexec/pa-investment/deploy.py`，root 所有且不可由部署账号修改 |
| 锁与失败标记 | `/var/lib/pa-investment-deploy/deploy.lock`、`active.json` |
| 备份与记录 | `/home/admin/pa-investment-backups/controlled-deployments/<UTC时间-随机ID>/`，root 私有 |

`pa-deployer` 不得加入 `docker`、`sudo`、`wheel` 等管理组，不得拥有其他通用 sudo 规则，也不得写入 Compose、环境文件、部署脚本或其父目录。admin 是现有受信管理员。入口清空调用者环境，Python 使用隔离模式；sudoers 不允许传参数、设置环境变量、直接调用 Docker 或 root shell。它允许更新这个应用，不是任意主机管理入口。具有镜像包写权限或修改主干工作流权限的主体仍属于供应链信任边界，必须按仓库评审规则管理。

## 首次启用：分阶段执行

### 1. 仓库评审与 Linux CI

先按仓库规则提交跨仓 PR，运行 `Investment container image`。PR 只构建、测试和导出归档，不获取生产 OIDC，也不发布 GHCR。通过评审后合并到公仓 master；公仓 master 的 push 或手动构建才会触发 publish job。

publish job 载入 **同次 smoke 测试通过的归档**，核对归档 SHA-256、镜像 config ID 和源码 revision 后直接推送，不重新构建。标签包含完整源码 SHA、run ID 和 attempt；发布清单保存 registry digest，生产仅使用该 digest。没有 `latest`，没有每次合并自动部署。

### 2. 公开 GHCR 与 Production 设置

用户已同意公开镜像。首次发布后，在 GitHub 组织 Packages 中将 `pa-investment-research` 包设置为 Public，并确认该公仓 Actions 具有包写入权限。**公仓不等于包自动公开**；未能匿名读取镜像时部署前置检查会拒绝，不把拉取凭据装到服务器。不要把运行时 `.env`、密码哈希、备份或真实用户数据加入镜像或 Actions 产物。

在公仓 `Settings → Environments → Production` 核对：

- Required reviewers 包含实际审批人（当前可由 jiahim 审批）；关闭管理员绕过保护。若唯一审批人同时手动触发工作流，不启用 Prevent self-review，否则须由另一名有权限的审批人批准。
- Deployment branches and tags 选择自定义规则，**仅一条 branch 类型的 `master`**，不是 tag，也不使用通配符。
- Environment secrets：`TS_OAUTH_CLIENT_ID`、`TS_AUDIENCE`，分别填入**已有** Tailscale 联邦身份的 client ID 和 audience。不是 OAuth client secret，不需要新建长期 Tailscale auth key。
- 暂时不要设置 `INVESTMENT_DEPLOY_GUARDS_READY=true`；服务器安装与权限复核后才启用这个 environment variable。

复用已经配置的 OIDC，不重复创建。当前 immutable Subject 为：

```text
repo:PABIPRG@315199386/pa-investment-research@1337955404:environment:Production
```

环境名大小写必须保持 `Production`；标签继续为 `tag:ci-deployer` → `tag:prod-server`，SSH 用户 `pa-deployer`。不要改成 `action:check` 的人工 admin 登录路径。2026-09-21 的只读检查显示 Production 尚无 reviewers/分支规则且允许管理员绕过；以上是待启用配置，不是声称已经完成的配置。

### 3. 服务器一次性安装（管理员明确批准后）

安装前只读核对实际 Compose、数据卷、网络及 owner/mode 与上表一致。需要 `/usr/bin/python3` 3.8+、Docker Engine/Compose v2、GNU tar（ACL/xattr 支持）、curl、GNU du、sudo/visudo。Python 只用标准库，不安装 pip 包。若服务器缺依赖，由管理员批准后按该发行版安装；不要在 Mac 安装 Docker。

检查 `pa-deployer` 的组、完整 sudo 列表和目录写权限。将**已审阅版本**的 `deploy.py`、`pa-investment-deploy`、`pa-investment-deploy.sudoers`、`install.sh` 复制到管理员控制的同一目录；服务器不必安装 Git。进入该目录，由 admin 显式执行：

```sh
sudo sh ./install.sh
sudo -l -U pa-deployer
id pa-deployer
```

安装仅创建 root-owned 入口、私有备份目录和最小 sudoers，不停止或更新容器。启用前核对完整 sudo 列表只允许本入口；若已有更宽规则，先由管理员处理，不能用本模板掩盖。现有 `.env` 应为 admin/root 私有文件；密码哈希保持 `10001:10001`、`0400`。所有部署路径及父目录不得是符号链接或 group/world-writable。现有 Compose 必须保留只读根文件系统、cap_drop ALL、唯一数据卷和 1Panel 网络。

`/etc/pa-investment-deploy/docker` 保持空的 root 私有配置目录，不复制人工账号的 registry 凭据。检查磁盘预算：脚本要求可用空间大于卷表观大小的两倍加 1 GiB，并在停机前拉取候选镜像；这不是长期容量保证。

还应审查一次完整备份的预估时长、当前卷数据量和恢复路径，确认短暂停机窗口。备份在同一主机只用于升级恢复，**不替代异机灾备**；按 PAB-18 将备份安全复制到独立故障域并做恢复演练。自动保留清理暂未实现，管理员监控磁盘，不运行无差别 prune 或删除历史卷。

### 4. 先连通验证，再批准部署

服务器安装和权限检查通过后，设置 Production 的 `INVESTMENT_DEPLOY_GUARDS_READY=true`。

在公仓 Actions 选择 `Investment production deployment`，分支 master，输入成功发布的 `Investment container image` **run ID**，先选 `mode=connectivity`。候选 job 验证构建属于公仓 master、已成功、源码在主干历史、发布清单属于同一次 attempt、公开 registry 中 config ID 与测试镜像一致，以及 Production 的保护规则。然后等待人工审批。

批准 connectivity 只做 Tailscale OIDC、SSH 身份和受限 sudo 检查，不调用部署入口，不停服，不备份。记录成功 run 链接；若 admin 的 `ssh aly` 提示人工登录确认，这是人工维护身份的要求，不等于 CI OIDC 未配置。

connectivity 成功且停机窗口获准后，再用**同一个候选 run ID** 手动运行 `mode=deploy` 并审批。审批人应核对候选 SHA/digest、变更风险和备份条件。若旧构建的发布清单已过期或被删除，应重新构建，不手填未经验证的 digest 绕过检查。

## 部署过程与完成标准

入口获取独占锁，若已有 `active.json` 则拒绝。随后落盘阶段：

```text
preparing → stopping → backing-up → switching → starting → verifying → complete
       任一失败/中断 → recovery-required（保留标记，阻止后续自动部署）
```

先验证旧容器健康、唯一卷写入者、Compose/镜像一致、卷位置/权限、候选架构及源码标签；停机前拉取镜像。旧容器必须在 30 秒宽限期内正常退出且卷无运行容器写入，才离线归档**整个**卷（含隐藏文件、SQLite/WAL、会话、附件和后端状态），保留 owner、ACL 和 xattr；复制 Compose、`.env` 和密码哈希。验证归档可读并记录所有文件 SHA-256 后，才原子更新 `.env` 中唯一一条 `DSH_IMAGE`，保持其他内容与权限。

然后仅重建 investment，不启动依赖、不构建、不重新拉取。新容器必须匹配候选 config ID 和 digest，满足单实例、聚合健康检查和外部 HTTPS `/healthz`，才能清除活动标记。聚合检查覆盖三个后端就绪，但不证明真实业务操作正确。

完成自动阶段后，通过现有 HTTPS 入口检查登录、历史数据可见及三个后端的代表性操作，将结果、run 链接、SHA/digest、备份路径、维护者和时间记入 PAB-29。恢复演练关联 PAB-18。没有这些真实证据，不把 PAB-29 或版本上线验收标为 Done。

当前仅支持 Docker 默认目录下的本地卷，不支持远程 volume driver、嵌套挂载或其他主机进程写同一卷；`--one-file-system` 不跨文件系统。自动部署期间不要通过 1Panel 或另一个管理员并发改 Compose、改配置或重启服务。1Panel 保留查看、日志、反代和明确协调后的人工恢复职责，不是第二套并行部署控制器。

## 失败与人工恢复

失败不会自动回退镜像或恢复数据，也不会自动删除租约锁。`active.json` 和记录目录保留失败阶段、旧镜像/ID、新镜像/ID、源码 revision、配置快照及校验清单（备份成功后才存在）。诊断只把精简状态输出到记录文件；可能含业务数据的容器日志仅存服务器私有目录，不上传 Actions。

管理员先确认部署进程已结束、没有运行中的工作流和其他操作者，再检查：

```sh
sudo cat /var/lib/pa-investment-deploy/active.json
sudo docker compose --project-directory /home/admin/pa-investment-deploy \
  --env-file /home/admin/pa-investment-deploy/.env \
  -f /home/admin/pa-investment-deploy/compose.yaml -p pa-investment-research ps -a
```

- `preparing` 失败：通常尚未停机；仍需核对当前健康和实际配置，修正权限、空间或拉取问题后再解除标记。
- `stopping` / `backing-up` 失败：可能已停服，备份可能不完整，不把它当作恢复点。确认未切换镜像和配置后，由管理员决定恢复旧服务。
- `switching` / `starting` / `verifying` 失败或进程断连：核对真实容器、当前 `.env` 和记录，不仅凭阶段名推断新版本是否写过数据。若无法证明没有写入或迁移，采用匹配旧镜像的整卷恢复，而非仅改回镜像。

整卷恢复前停止所有写入者，保留失败数据副本供诊断；验证 `backup-sha256.json` 中**全部文件**的 SHA-256，并先在隔离目录/新卷解压测试，核对文件权限、SQLite 完整性和历史数据。之后按[单实例数据目录与迁移](../../docs/maintainers/单实例数据目录与迁移.md)恢复已确认的目标卷，配对旧镜像、旧 Compose、旧 `.env` 与旧密码哈希。不要向运行中的卷覆盖解压；不要以 `down -v` 或删锁解决启动失败。实际生产恢复是单独获准的破坏性操作，本手册不提供可直接误执行的通配删除命令。

人工恢复或原版本重新验证成功后，将 `active.json` **移动到其记录目录下唯一命名的人工处置记录**，注明原因、操作者、时间和验证结果，而非直接丢弃。仅解除标记不能代替恢复；不要删除 `deploy.lock` 文件来绕过运行中的进程锁。

需要撤销自动入口时，先协调无运行部署，禁用 Production ready variable，并由管理员停用对应 sudoers 文件；保留 root 脚本、备份和审计记录。不要删除卷或配置。

## 身份撤销与轮换

本链路不保存长期 Tailscale auth key、OAuth client secret 或服务器 GHCR token。需要轮换已有联邦身份时，先暂停部署并将 ready variable 设为 false；由管理员在 Tailscale 替换/撤销对应身份，保持受限 Subject、audience、标签和 SSH 用户边界，更新 Production 的 client ID/audience。核对 Tailnet 中已接入的旧 CI 节点并撤销其访问，不只删除 GitHub secrets。按首次启用顺序复核后重新打开 ready variable，以 connectivity 模式验证；不要为轮换临时授予 admin 或通用 Docker 权限。GitHub `GITHUB_TOKEN` 由每次 job 获取，不在服务器持久化；包写入权限从 GitHub 仓库/包访问规则撤销。

## 聚焦验证

```sh
python3 -B -m unittest discover -s ops/pa-investment -p 'test_*.py'
sh -n ops/pa-investment/install.sh
sh -n ops/pa-investment/pa-investment-deploy
actionlint -shellcheck= -pyflakes= .github/workflows/investment-container.yml .github/workflows/investment-deploy.yml .github/workflows/investment-ci.yml
git diff --check
```

测试使用临时目录与模拟 Docker，不访问生产、不构建镜像。Linux CI 额外运行真实 GNU tar 归档/恢复测试；Mac 跳过该用例。真实服务器上的文件权限、sudoers、Docker、OIDC、停机时长与业务数据恢复仍需环境验证。

接口依据：[GitHub Environment 保护](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)、[部署分支规则 API](https://docs.github.com/en/rest/deployments/branch-policies)、[Docker registry manifest 检查](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)、[GHCR 可见性](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 镜像公开前安全门禁（PAB-29）

`investment-container.yml` 在 Compose smoke 后导出受测归档，使用
`image_security.py` 扫描，再上传镜像 artifact；GHCR publish 依赖同一 job
成功并在登录 registry 前复核安全摘要。构建不再通过 `cache-to` 提前上传镜像层。
安全摘要仅包含计数、固定版本、数据库时间和镜像/归档/策略哈希，不上传秘密正文、
原始报告或解包目录。脚本需要 Python 3.11+，CI 扫描器为 Linux amd64。

- 官方 Gitleaks 8.30.1 和 Trivy 0.74.0 的下载 URL 与 SHA256 固定在
  `image-security-policy.json`，下载校验失败不执行二进制。
- 运行镜像将 Node 基镜像随附的 npm 11.19.0 更新至 11.19.1，保留 npm/npx 能力。
  官方完整归档由 Dockerfile 固定 SHA256，经临时只读挂载离线安装，不运行安装脚本；
  不单独强换其内部依赖，也不把安装缓存或下载归档留在运行层中。
- 秘密检查包括所有历史层的所有常规文件、重复路径的旧内容、完整 config/history、
  路径/链接目标/归档扩展 metadata；不应用 whiteout，不创建或跟随链接，不运行镜像代码。
  内层文件通过字节签名识别压缩格式，避免将名字以 `.gz` 结尾的普通 dpkg 文本当压缩包；
  这些普通文本仍完整送入扫描器。嵌套归档深度 2、解码深度 5，不能据此保证识别所有编码秘密。
- Trivy 分析同一归档的最终文件系统，必须识别 Debian、Node 与 Python 包清单。
  所有 HIGH、CRITICAL、UNKNOWN 告警阻断，包括未修复告警；不会以“第三方”或“未确认利用”放行。
  不把漏洞扫描宣称为对已删除历史包的 CVE 扫描；已删除层的秘密仍受上述全层检查。
- 全部秘密命中、敏感路径、扫描错误、超时、不完整扫描、缺失报告、身份不一致和超过
  72 小时的漏洞数据库均阻断。安全摘要超过 24 小时不能用于发布，应重新构建/验证。
  Trivy 0.74.0 成功退出时，官方固定文本“使用其他厂商的严重性评级”是来源通知，
  不表示扫描不完整；仅排除这一条完整通知，报告中的漏洞仍按原阈值阻断，其他警告仍失败。
- 秘密检查命中时，Actions 日志先输出 `secret-gate-diagnostics` JSON：分别统计秘密规则
  与敏感路径命中，并明确 `passed: false`、漏洞扫描 `pending`；随后继续执行独立的 Trivy
  检查，一次收集两类阻断。完整结果为 `image-security-result`，任何秘密、敏感路径或
  阻塞级漏洞都使摘要 `passed: false`、任务失败，禁止上传/发布。工具异常仍立即失败。
  `generic-api-key`、`private-key` 保留固定规则名称，其他规则显示 `other` 和规则名 SHA256。
  两类命中各最多展示 100 条定位样本及省略数量，总计数不截断。定位只含从零开始的层号/
  归档条目序号、固定来源类别、规范化镜像路径和完整文件的 SHA256 与扫描文件行号；嵌套归档只定位
  外层文件，未知位置仅输出路径哈希。路径、匹配正文、秘密值及其指纹均不输出。
  相同路径跨历史层保留各自序号，路径哈希可用于与受限本地审计比对；命中仍全部阻断。
  漏洞诊断仅公开规范的 CVE/GHSA 编号与计数（最多 100 个编号）；非规范标识转为哈希，
  不输出扫描器原始描述、路径或镜像元数据正文。
- 门禁的临时工作目录为 0700；解包限制为 250,000 条目、单文件 2 GiB、累计声明大小
  8 GiB（含外层归档与层内容），不满足限制时失败，不静默跳过文件。
- 当前 `exceptions` 必须为空。误报、不适用或无修复版本的例外需要另行评审：记录具体
  CVE/规则、包名和版本、目标文件/层与哈希、官方证据、风险、到期日期、审核人和明确授权；
  未授权前继续阻断，不接受整目录或全部未修复漏洞例外。

Python sidecar 在写入 `runtime.json` 及进入镜像层前，仅删除官方
`py-vapid==1.9.4` 的 `py_vapid/tests/test_vapid.py` 与 `.test_vapid.py.swp`。
两文件 SHA256 逐个匹配后才删除整个已核验 tests 目录；运行模块和 dist-info 保留。
新版、内容变化、额外文件或符号链接都需重新核验，不能盲删。原 wheel RECORD 保留发行源记录，
实际发行文件清单由重新生成的 `runtime.json` 负责。

Linux 容器另在打包阶段按精确文件哈希剔除 Zod 4.4.3 的 mini/classic 字符串测试、
本仓库 session-telemetry 脱敏测试、Kubernetes 36.0.3 的异步 kube config 测试和
NumPy 2.2.6 的随机数生成器测试、pywebpush 2.5.0 与 websocket-client 1.9.0 的测试。
清单见 `frontend/scripts/investment-container-test-payloads.ts`。
仅删除这七个不参与运行的文件，保留其余运行模块、许可证与包元数据；Python 清理在
`runtime.json` 生成前执行，全部发生在运行镜像 `COPY` 前。文件缺失/漂移或路径含符号链接
时停止清理，不扩展到整目录，也没有向扫描器添加忽略项。

聚焦验证：

```sh
python3 -B -m unittest discover -s ops/pa-investment -p 'test_*.py'
pnpm --dir frontend exec vitest run scripts/investment-container.spec.ts scripts/investment-container-test-payloads.spec.ts scripts/build-investment-python-sidecar.spec.ts scripts/investment-backend-package-policy.spec.ts packages/client/ui-investment-research/tests/holdings-import.client.spec.ts
```

完整设计、官方依赖来源和验证债务见
[镜像安全加固设计](../../docs/superpowers/specs/2026-09-21-pab29-image-security.md)。
本机通过的解析/门禁测试不等于 Linux 新镜像安全通过；发布前必须取得新候选的扫描、
运行依赖加载、Compose smoke 和表格导入真实产品验收证据。

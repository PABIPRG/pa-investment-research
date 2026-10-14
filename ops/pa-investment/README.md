# aly 受控部署运维手册（PAB-29）

本目录扩展 PAB-20 的容器交付，目标是既有 Linux 服务器 **aly**，不是在 Mac 部署。GitHub 托管 runner 构建和测试镜像；私有 GHCR 保存镜像；管理员批准后，通过既有 Tailscale OIDC/SSH 调用服务器固定入口。Mac 不需要 Docker，服务器不需要 Git、Node、pnpm 或构建工具。

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
| root 部署入口 | `/usr/local/sbin/pa-investment-deploy`，无参数；stdin 为镜像 digest、GitHub actor、短期 token 三行 |
| 安装脚本 | `/usr/local/libexec/pa-investment/deploy.py`，root 所有且不可由部署账号修改 |
| 锁与失败标记 | `/var/lib/pa-investment-deploy/deploy.lock`、`active.json` |
| 备份与记录 | `/home/admin/pa-investment-backups/controlled-deployments/<UTC时间-随机ID>/`，root 私有 |

`pa-deployer` 不得加入 `docker`、`sudo`、`wheel` 等管理组，不得拥有其他通用 sudo 规则，也不得写入 Compose、环境文件、部署脚本或其父目录。admin 是现有受信管理员。入口清空调用者环境，Python 使用隔离模式；sudoers 不允许传参数、设置环境变量、直接调用 Docker 或 root shell。它允许更新这个应用，不是任意主机管理入口。具有镜像包写权限或修改主干工作流权限的主体仍属于供应链信任边界，必须按仓库评审规则管理。

一次性安装固定更新器后，`pa-deployer` 额外获得无参数调用 `/usr/local/sbin/pa-investment-update-deployer` 的权限。该入口只接受源码提交 SHA 与预期 SHA-256，由服务器独立读取固定公仓主干中的 `ops/pa-investment/deploy.py`；不能上传任意脚本、指定 URL/路径、更新自身或修改 sudoers。主干部署脚本的评审属于 **root 代码发布的信任边界**。更新器和授权规则本身仍由管理员维护。

## 首次启用：分阶段执行

### 1. 仓库评审与 Linux CI

先按仓库规则提交跨仓 PR，运行 `镜像构建与发布`。PR 只构建、测试和导出归档，不获取生产 OIDC，也不发布 GHCR。通过评审后合并到公仓 master；公仓 master 的 push 或手动构建才会触发 publish job。

publish job 载入 **同次 smoke 测试通过的归档**，核对归档 SHA-256、镜像 config ID 和源码 revision 后直接推送，不重新构建。标签包含完整源码 SHA、run ID 和 attempt；发布清单保存 registry digest，生产仅使用该 digest。没有 `latest`，没有每次合并自动部署。

### 2. 私有 GHCR 与 Production 设置

组织策略不允许公开 `pa-investment-research` 包。包保持 Private，并在 Package settings 的 Manage Actions access 中允许 `PABIPRG/pa-investment-research` 读取。部署 workflow 只申请 `packages: read`，使用每个 job 的短期 `GITHUB_TOKEN`：候选 job 登录后核对 registry config ID；deploy job 经受限 SSH stdin 将 token 交给 root 入口。服务器只在 `/run/pa-investment-deploy` 下创建 root 私有临时 Docker 配置，精确 digest 拉取完成后、停服前即删除，不保存个人或机器账号 PAT。不要把运行时 `.env`、密码哈希、token、备份或真实用户数据加入镜像、Actions 产物、状态文件或日志。

在公仓 `Settings → Environments → Production` 核对：

- Required reviewers 包含实际审批人（当前可由 jiahim 审批）；关闭管理员绕过保护。若唯一审批人同时手动触发工作流，不启用 Prevent self-review，否则须由另一名有权限的审批人批准。
- Deployment branches and tags 选择自定义规则，**仅一条 branch 类型的 `master`**，不是 tag，也不使用通配符。
- Environment secrets：`TS_OAUTH_CLIENT_ID`、`TS_AUDIENCE`，分别填入**已有** Tailscale 联邦身份的 client ID 和 audience。不是 OAuth client secret，不需要新建长期 Tailscale auth key。
- 暂时不要设置 `INVESTMENT_DEPLOY_GUARDS_READY=true`；服务器安装与权限复核后才启用这个 environment variable。

复用已经配置的 OIDC，不重复创建。当前 immutable Subject 为：

```text
repo:PABIPRG@315199386/pa-investment-research@1337955404:environment:Production
```

环境名大小写必须保持 `Production`；标签继续为 `tag:ci-deployer` → `tag:prod-server`，SSH 用户 `pa-deployer`。不要改成 `action:check` 的人工 admin 登录路径。2026-09-22 的只读检查显示 reviewer 为 `jiahim`、部署分支仅 `master`、管理员绕过已关闭，两个 Tailscale secret 名称已登记；`INVESTMENT_DEPLOY_GUARDS_READY` 仍为 `false`，服务器入口更新并复核前保持关闭。

### 3. 服务器一次性安装（管理员明确批准后）

安装前只读核对实际 Compose、数据卷、网络及 owner/mode 与上表一致。需要 `/usr/bin/python3` 3.8+、Docker Engine/Compose v2、GNU tar（ACL/xattr 支持）、curl、GNU du、sudo/visudo。Python 只用标准库，不安装 pip 包。若服务器缺依赖，由管理员批准后按该发行版安装；不要在 Mac 安装 Docker。

检查 `pa-deployer` 的组、完整 sudo 列表和目录写权限。将**已审阅版本**的 `deploy.py`、`pa-investment-deploy`、`pa-investment-deploy.sudoers`、`install.sh` 复制到管理员控制的同一目录；服务器不必安装 Git。进入该目录，由 admin 显式执行：

```sh
sudo sh ./install.sh
sudo -l -U pa-deployer
id pa-deployer
```

安装仅创建 root-owned 入口、私有备份目录和最小 sudoers，不停止或更新容器。启用前核对完整 sudo 列表只允许本入口；若已有更宽规则，先由管理员处理，不能用本模板掩盖。现有 `.env` 应为 admin/root 私有文件；密码哈希保持 `10001:10001`、`0400`。所有部署路径及父目录不得是符号链接或 group/world-writable。现有 Compose 必须保留只读根文件系统、cap_drop ALL、唯一数据卷和 1Panel 网络。

服务器既有 Compose 的 `healthcheck.test` 必须为 `[CMD, /nodejs/bin/node, /opt/container/investment-healthcheck.mjs]`，且不得禁用健康检查。升级到当前镜像前应核对此项；仅更新镜像不会迁移既有 Compose。部署器会在拉取和停服前拒绝旧的 `node` 或 shell 形式探针，最终聚合检查也使用相同绝对路径。已运行的容器需要通过获准的重建才能应用 Compose 健康检查修改。

不在 `/etc`、admin HOME 或部署目录保存 registry 凭据。短期 token 只用于停服前的 `docker login --password-stdin` 和精确 digest 拉取，临时 `DOCKER_CONFIG` 随后删除。检查磁盘预算：脚本要求可用空间大于卷表观大小的两倍加 1 GiB，并在停机前拉取候选镜像；这不是长期容量保证。

还应审查一次完整备份的预估时长、当前卷数据量和恢复路径，确认短暂停机窗口。备份在同一主机只用于升级恢复，**不替代异机灾备**；按 PAB-18 将备份安全复制到独立故障域并做恢复演练。镜像与受管离线包的保留策略见下文 PAB-36；业务卷、整卷备份与部署记录不参与自动删除，仍需独立容量预算，不运行无差别 prune。

### 4. 一次性安装部署器自动更新入口

日常操作保持两个 Action：先构建镜像，再运行升级。服务器只需一次安装固定更新器；后续 `deploy.py` 改动由升级 Action 自动同步。`aly` 的既有部署入口使用 `/usr/bin/python3.11`，默认 `/usr/bin/python3` 仍为 3.6，因此**不要为本次迁移重跑通用 install.sh**。

在这项修复合并并获服务器安装授权后，将同一个完整已合并提交中的以下文件放到 admin 控制的审阅目录：`deploy.py`、`update_deployer.py`、`install_deployer_updater.py`、`pa-investment-update-deployer`、`pa-investment-update-deployer.sudoers`。服务器无需安装 Git，也无需保存 GitHub token。

在 **aly 的该目录**执行（`reviewed_revision` 填入上述完整提交 SHA）：

```sh
reviewed_revision='<完整的已合并提交 SHA>'
sudo /usr/bin/python3.11 -I -B ./install_deployer_updater.py "$reviewed_revision"
sudo -l -U pa-deployer
sudo sha256sum /usr/local/libexec/pa-investment/deploy.py
```

安装器在同一部署锁内检查 `active.json` 和未完成更新，先验证 GitHub 上的部署器来源，备份旧脚本、版本记录及将要安装的文件，再安装固定入口，最后启用独立 sudoers 并运行 `visudo`。现有 Python 3.11 部署 wrapper、原 sudoers、Compose 和环境文件保持原样；不会停止容器或调用应用部署。普通安装失败会尝试恢复旧文件；输出的 `backup` 路径下保留 `files.json`、原文件和结果记录。中断后先检查该记录再重跑同一安装命令。

更新器要求服务器能够通过 HTTPS 访问 `api.github.com`，用系统 CA 验证证书，拒绝重定向，不读取调用者代理或 Python 环境变量。公开读取受 GitHub API 限流影响；网络或限流失败会明确终止本次升级，应用部署尚未开始，恢复后重跑升级 Action。**本地测试不证明 aly 的实际出站连通性**，一次性安装时才验证这一条件。

安装后完整 sudo 列表应只包含原应用部署入口与新增更新入口，均无参数；通用 Docker、root shell、额外参数与直接文件写入仍被拒绝。保持 Production 保护和现有 OIDC 配置。

### 5. 日常构建与升级

若 GHCR 拉取在 aly 上反复出现 `unexpected EOF` 或超时，可先在公仓 master 的 Actions 手动运行 `云服务器网络测速`，经 Production 审批后测量 GitHub runner 到 aly 的连接类型及 32 MiB 随机数据传输速度。该诊断只用现有 OIDC 身份连接 `pa-deployer`，数据经标准输入交给远端 `wc -c`，不会写入服务器文件、调用 Docker 或部署入口。它与正式部署共用并发锁；工作流摘要先记录 Ping 路由和小样本结果，传输超时也会记录远端最后报告的已读取字节数，摘要不输出 Tailnet 地址。Ping 路由只是传输前的观测，不保证传输全程使用同一路径。诊断成功仅说明这条传输路径可用，不能代替镜像完整性校验或授权部署。

服务器安装和权限检查通过后，设置 Production 的 `INVESTMENT_DEPLOY_GUARDS_READY=true`。

在公仓 Actions 选择 `云服务升级`，分支 master，输入成功发布的 `镜像构建与发布` **run ID**，使用默认的 `mode=deploy`。候选 job 先运行部署与更新器的聚焦测试，使用短期 `GITHUB_TOKEN` 验证镜像来源、同次构建 attempt、不可变身份和 Production 保护规则。摘要分别展示镜像版本与本次工作流固定的部署器版本，然后等待人工审批。

批准 deploy 后先核对连接和受限入口，再自动调用固定更新器。更新器验证源码位于主干历史且不早于上次实际安装的部署器，核对 Git blob、SHA-256 和 Python 语法，在部署锁内备份并原子安装；版本相同时不重复写入。随后 Action 重新核对服务器脚本 SHA-256，全部通过后才发送 registry token 并进入原应用部署流程。更新器源码提交取自本次部署工作流，独立于镜像源码；因此选择历史镜像不会强制降级部署器。更新失败时应用部署步骤被跳过。

`mode=connectivity` 保留为可选诊断：只做 OIDC、SSH、原受限 sudo 与已安装脚本摘要检查，不更新脚本、不部署、不停服，也不是 deploy 的必需前置运行。旧脚本与本次源码不同会报告摘要差异；正常 deploy 会先自动同步。审批人仍须核对停机窗口、候选 SHA/digest、部署器版本及备份条件。旧构建清单过期或被删除时重新构建；旧部署工作流请求安装比服务器更老的部署器时，从当前 master 发起新的升级运行，保持所需镜像 run ID。

部署器更新记录位于 `/var/lib/pa-investment-deploy/deployer-updates/<记录ID>/`，包含 `deploy.py.before`、`request.json`、`result.json`。`deployer-release.json` 是最后实际安装的来源记录；`deployer-update-pending.json` 是未完成脚本更新的恢复日志，**不同于应用升级的 active.json**。普通更新失败会尝试恢复旧脚本和版本记录；进程被强制终止时，下一次固定更新器在锁内先恢复，再重新验证请求。恢复前核对备份摘要和现有脚本身份；来源不明的改动会闭锁交管理员处理。不要手动删除日志或将不匹配脚本加入白名单。应用部署发现该日志时拒绝启动。

若需停用自动更新，协调无运行升级后由管理员停用独立 `/etc/sudoers.d/pa-investment-update-deployer` 规则并运行 `visudo -c`；保留 updater 文件、部署器版本记录与备份以供审计。此后新版升级 Action 会在入口检查处停止。恢复安装前的文件需按安装备份 `files.json` 精确恢复，并复核 owner、mode、摘要和 sudo 配置；这属于另行获准的管理员操作，不涉及应用数据回退。

## 部署过程与完成标准

入口获取独占锁，若已有 `active.json` 则拒绝。随后落盘阶段：

```text
preparing → stopping → backing-up → switching → starting → verifying → complete
       拉取失败且旧服务复核通过 → prepare-failed-safe（保留记录，清除活动标记）
       其他失败/中断或复核失败 → recovery-required（保留标记，阻止后续自动部署）
```

先验证旧容器健康、唯一卷写入者、Compose/镜像一致、卷位置/权限、候选架构及源码标签；停机前按精确 digest 最多拉取两次，每次上限 900 秒，两次之间等待 15 秒。Actions 中的 `pull-start` 标明尝试次数和超时上限；拉取期间每 60 秒输出 `pull-heartbeat`，记录已等待时间、Docker 命令累计输出字节数 `cli_output_bytes` 和距上次输出的秒数 `cli_idle_seconds`。这些数字只说明 Docker 命令是否还在输出，**不是镜像已下载字节数，也不能单独证明网络传输在前进**。`pull-result` 记录成功、超时或退出码、耗时与可识别的固定错误类别（例如 `unexpected_eof`、`network_timeout`；无法识别时为 `unknown`）。root 私有的 `image-pull.json` 在尝试开始时写入 `running`，结束时补齐 UTC 起止时间和结果，方便区分拉取中断与正常失败。Docker 原始输出仅在进程内短暂读取以归类，日志及记录文件不保存原始输出、镜像层 URL 或凭据。旧容器必须在 30 秒宽限期内正常退出且卷无运行容器写入，才离线归档**整个**卷（含隐藏文件、SQLite/WAL、会话、附件和后端状态），保留 owner、ACL 和 xattr；复制 Compose、`.env` 和密码哈希。验证归档可读并记录所有文件 SHA-256 后，才原子更新 `.env` 中唯一一条 `DSH_IMAGE`，保持其他内容与权限。

然后仅重建 investment，不启动依赖、不构建、不重新拉取。新容器必须匹配候选 config ID 和 digest，满足单实例、聚合健康检查和外部 HTTPS `/healthz`，才能清除活动标记。聚合检查覆盖三个后端就绪，但不证明真实业务操作正确。

完成自动阶段后，通过现有 HTTPS 入口检查登录、历史数据可见及三个后端的代表性操作，将结果、run 链接、SHA/digest、备份路径、维护者和时间记入 PAB-29。恢复演练关联 PAB-18。没有这些真实证据，不把 PAB-29 或版本上线验收标为 Done。

当前仅支持 Docker 默认目录下的本地卷，不支持远程 volume driver、嵌套挂载或其他主机进程写同一卷；`--one-file-system` 不跨文件系统。自动部署期间不要通过 1Panel 或另一个管理员并发改 Compose、改配置或重启服务。1Panel 保留查看、日志、反代和明确协调后的人工恢复职责，不是第二套并行部署控制器。

## 失败与人工恢复

失败不会自动回退镜像或恢复数据，也不会自动删除租约锁。`active.json`（若需人工恢复）和记录目录保留失败阶段、旧镜像/ID、新镜像/ID、源码 revision、配置快照及校验清单（备份成功后才存在）。仅当两次镜像拉取失败，且重新核实旧容器 ID/镜像/健康、唯一卷写入者、备份空间、Compose、`.env` 与外部 `/healthz` 均未异常，才保存 `prepare-failure-disposition.json` 并清除 `active.json`；工作流仍以失败结束。核验或诊断失败时继续闭锁。诊断只把精简状态输出到记录文件；可能含业务数据的容器日志仅存服务器私有目录，不上传 Actions。

管理员先确认部署进程已结束、没有运行中的工作流和其他操作者，再检查：

```sh
sudo cat /var/lib/pa-investment-deploy/active.json
sudo docker compose --project-directory /home/admin/pa-investment-deploy \
  --env-file /home/admin/pa-investment-deploy/.env \
  -f /home/admin/pa-investment-deploy/compose.yaml -p pa-investment-research ps -a
```

- `prepare-failed-safe`：记录中已包含旧服务复核证据，活动标记已清除；修正拉取问题后才能再次发起受审批部署，不能把本次工作流视为上线成功。
- `preparing` 失败且仍有 `active.json`：通常尚未停机；仍需核对当前健康和实际配置，修正权限、空间或拉取问题后再解除标记。
- `stopping` / `backing-up` 失败：可能已停服，备份可能不完整，不把它当作恢复点。确认未切换镜像和配置后，由管理员决定恢复旧服务。
- `switching` / `starting` / `verifying` 失败或进程断连：核对真实容器、当前 `.env` 和记录，不仅凭阶段名推断新版本是否写过数据。若无法证明没有写入或迁移，采用匹配旧镜像的整卷恢复，而非仅改回镜像。

整卷恢复前停止所有写入者，保留失败数据副本供诊断；验证 `backup-sha256.json` 中**全部文件**的 SHA-256，并先在隔离目录/新卷解压测试，核对文件权限、SQLite 完整性和历史数据。之后按[单实例数据目录与迁移](../../docs/maintainers/单实例数据目录与迁移.md)恢复已确认的目标卷，配对旧镜像、旧 Compose、旧 `.env` 与旧密码哈希。不要向运行中的卷覆盖解压；不要以 `down -v` 或删锁解决启动失败。实际生产恢复是单独获准的破坏性操作，本手册不提供可直接误执行的通配删除命令。

人工恢复或原版本重新验证成功后，将 `active.json` **移动到其记录目录下唯一命名的人工处置记录**，注明原因、操作者、时间和验证结果，而非直接丢弃。仅解除标记不能代替恢复；不要删除 `deploy.lock` 文件来绕过运行中的进程锁。

需要撤销自动入口时，先协调无运行部署，禁用 Production ready variable，并由管理员停用对应 sudoers 文件；保留 root 脚本、备份和审计记录。不要删除卷或配置。

## 身份撤销与轮换

本链路不保存长期 Tailscale auth key、OAuth client secret 或服务器 GHCR token。需要轮换已有联邦身份时，先暂停部署并将 ready variable 设为 false；由管理员在 Tailscale 替换/撤销对应身份，保持受限 Subject、audience、标签和 SSH 用户边界，更新 Production 的 client ID/audience。核对 Tailnet 中已接入的旧 CI 节点并撤销其访问，不只删除 GitHub secrets。按首次启用顺序复核后重新打开 ready variable，以 connectivity 模式验证；不要为轮换临时授予 admin 或通用 Docker 权限。GitHub `GITHUB_TOKEN` 由每个 job 获取，拉取后即从服务器临时目录删除，并在 job 结束后失效；撤销包读取权限应通过 Package settings 的 Actions access 完成。

## 聚焦验证

```sh
python3 -B -m unittest discover -s ops/pa-investment -p 'test_*.py'
sh -n ops/pa-investment/install.sh
sh -n ops/pa-investment/pa-investment-deploy
sh -n ops/pa-investment/pa-investment-update-deployer
visudo -cf ops/pa-investment/pa-investment-update-deployer.sudoers
actionlint -shellcheck= -pyflakes= .github/workflows/investment-container.yml .github/workflows/investment-deploy.yml .github/workflows/investment-ci.yml
git diff --check
```

测试使用临时目录与模拟 Docker，不访问生产、不构建镜像。Linux CI 额外运行真实 GNU tar 归档/恢复测试；Mac 跳过该用例。真实服务器上的文件权限、sudoers、Docker、OIDC、停机时长与业务数据恢复仍需环境验证。

接口依据：[GitHub Environment 保护](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)、[部署分支规则 API](https://docs.github.com/en/rest/deployments/branch-policies)、[提交祖先比较](https://docs.github.com/en/rest/commits/commits#compare-two-commits)、[固定提交的文件读取](https://docs.github.com/en/rest/repos/contents#get-repository-content)、[Docker registry manifest 检查](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)、[GHCR 认证](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 镜像发布前安全门禁（PAB-29）

`investment-container.yml` 在 Compose smoke 后导出受测归档，使用
`image_security.py` 扫描，再上传镜像 artifact；GHCR publish 依赖同一 job
成功并在登录 registry 前复核安全摘要。构建不再通过 `cache-to` 提前上传镜像层。
安全摘要仅包含计数、固定版本、数据库时间和镜像/归档/策略哈希，不上传秘密正文、
原始报告或解包目录。脚本需要 Python 3.11+，CI 扫描器为 Linux amd64。

- 官方 Gitleaks 8.30.1 和 Trivy 0.74.0 的下载 URL 与 SHA256 固定在
  `image-security-policy.json`，下载校验失败不执行二进制。
- 构建阶段使用官方 `node:24.21.0-trixie-slim` Linux amd64 manifest digest，完成 frozen
  安装、前端构建、production deploy 和 Linux Python sidecar；运行阶段使用固定 digest 的官方
  Node 24 Debian 13 Distroless，只复制最终产物。运行层没有 shell、apt、npm 或 Corepack。
- Distroless 内部检查通过 `/nodejs/bin/node` 与 `investment-container-check.mjs` 完成，不依赖
  `sh/find/test`。运行用户为数值 UID/GID `10001:10001`，方便 Compose tmpfs、秘密文件和持久卷
  保持原权限边界；固定摘要的来源核验不能代替 CI 实际构建、ABI 验证和扫描。
- 容器 adapter 在合并配置后强制关闭 memory；图模块只在 memory 启用时导入 Chroma。
  Linux sidecar 锁不安装 ChromaDB 及其专用传递依赖，macOS/Windows 桌面锁仍保留
  ChromaDB 和原有 memory 能力。该依赖边界由容器契约与引擎深度测试约束。
- 秘密检查包括所有历史层的所有常规文件、重复路径的旧内容、完整 config/history、
  路径/链接目标/归档扩展 metadata；不应用 whiteout，不创建或跟随链接，不运行镜像代码。
  内层文件通过字节签名识别压缩格式，避免将名字以 `.gz` 结尾的普通 dpkg 文本当压缩包；
  这些普通文本仍完整送入扫描器。嵌套归档深度 2、解码深度 5，不能据此保证识别所有编码秘密。
- Trivy 分析同一归档的最终文件系统，必须识别 Debian、Node 与 Python 包清单。
  默认所有 HIGH、CRITICAL、UNKNOWN 告警阻断，包括未修复告警；仅允许下文列出的精确平台例外。
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
- `exceptions` 只接受逐项评审的秘密规则精确例外：规则、来源类别、路径 SHA256、完整文件
  SHA256、行号和授权数量必须同时匹配；未使用、重复、过期或内容漂移的例外均失败关闭。
  策略同时记录包名和版本、原因、审核人及到期日期，不接受整目录或整条规则例外。
  当前 8 条授权命中仅对应 Akshare 1.18.88、Tushare 1.4.29 与 protobuf 7.35.1 的固定公开
  运行常量或生成代码表达式；2026-10-08 经重新核验并获用户批准，有效期续至
  2026-10-22 23:59 UTC。依赖变化或到期后必须重新评审，详见
  [本次七条例外复核](../../docs/agent-notes/2026-10-08-image-security-expiry-review.md)。
- `vulnerabilityExceptions` 当前为空。PR #156 曾为固定 OpenSSL 修复包添加六条临时声明，
  2026-09-30 的 Trivy 数据库更新已识别修复版本，声明不再命中，导致合并后的运行
  `36685910520` 按 `unused-vulnerability-exception` 失败关闭，因此撤销全部六条声明。
  固定修复包、归档及真实库哈希、最终镜像加载和 TLS 检查继续保留。
  `UNKNOWN`、`HIGH`、`CRITICAL` 的全部命中继续阻断；此前三个 OpenSSL 编号及
  `CVE-2026-97399` 再次出现也不豁免。秘密规则的八条精确声明不变。
  通用精确声明功能仍有独立回归；新增声明必须重新评审，未使用、漂移、重复或过期仍失败关闭。

运行镜像在固定 Debian 13 Distroless 基础上覆盖官方 Debian `libssl3t64` 与
`openssl-provider-legacy` 的 `3.6.5-1` 修复包，处理 2026-09-29 发布的 OpenSSL 告警。
构建辅助脚本固定 HTTPS 来源与 SHA256，解包前校验完整归档及包名、版本、amd64 架构、
OpenSSL 来源；同时复制真实二进制、原始 control 与 md5sums，不单独改写扫描器版本记录。
最终镜像边界检查使用随镜像携带的 Python 加载两项共享库、核对版本并创建 TLS 上下文；
随后仍执行完整秘密及漏洞扫描。保持 OpenSSL 3 ABI、Node 24、非 root 与只读运行约束。
该覆盖可在 trixie/Distroless 固定版本包含修复后移除；回退到旧库仍会被漏洞门禁阻断。

Python sidecar 在写入 `runtime.json` 及进入镜像层前，仅删除官方
`py-vapid==1.9.4` 的 `py_vapid/tests/test_vapid.py` 与 `.test_vapid.py.swp`。
两文件 SHA256 逐个匹配后才删除整个已核验 tests 目录；运行模块和 dist-info 保留。
新版、内容变化、额外文件或符号链接都需重新核验，不能盲删。原 wheel RECORD 保留发行源记录，
实际发行文件清单由重新生成的 `runtime.json` 负责。

Linux 容器另在打包阶段按精确文件哈希剔除 Zod 4.4.3 的 mini/classic 字符串测试、
本仓库 session-telemetry 脱敏测试，以及目标锁中存在时的 Kubernetes 36.0.3
异步 kube config 测试和
NumPy 2.2.6 的随机数生成器测试、pywebpush 2.5.0 与 websocket-client 1.9.0 的测试。
清单见 `frontend/scripts/investment-container-test-payloads.ts`。
当前 Linux 锁已随 Chroma 依赖闭包移除 Kubernetes，因此不会产生其测试文件；后续目标锁若重新安装
表中包，仍必须先匹配精确文件哈希。仅删除实际存在且已核验的不参与运行文件，保留其余运行模块、
许可证与包元数据；Python 清理在
`runtime.json` 生成前执行，全部发生在运行镜像 `COPY` 前。文件缺失/漂移或路径含符号链接
时停止清理，不扩展到整目录，也没有向扫描器添加忽略项。

聚焦验证：

```sh
python3 -B -m unittest discover -s ops/pa-investment -p 'test_*.py'
pnpm --dir frontend exec vitest run scripts/investment-container.spec.ts scripts/investment-container-test-payloads.spec.ts scripts/build-investment-python-sidecar.spec.ts scripts/investment-backend-package-policy.spec.ts packages/client/ui-investment-research/tests/holdings-import.client.spec.ts
```

完整设计、官方依赖来源和验证债务见
[镜像安全加固设计](../../docs/superpowers/specs/2026-09-21-pab29-image-security.md)。
门禁能力单测使用独立策略样本和固定测试时钟，并覆盖到期前、到期点、到期后及发布时的
再次校验；生产扫描与发布仍读取真实时间及仓库策略。单测通过不表示当前策略例外仍在有效期内。
本机通过的解析/门禁测试不等于 Linux 新镜像安全通过；发布前必须取得新候选的扫描、
运行依赖加载、Compose smoke 和表格导入真实产品验收证据。

## PAB-36：镜像、离线包与日志保留

本节是待审阅的启用方案，**不是服务器已经执行的结果**。关联 [PAB-36](https://linear.app/pabiprg/issue/PAB-36/deploy-retention-001-按成功部署记录管理镜像与部署包保留)。2026-10-14 的磁盘与镜像清理结果仅为用户提供的历史背景，不能作为本版本验收或当前磁盘状态。

### 成功记录与保护范围

`deploy.py` 在镜像身份、单实例、Docker 健康状态、聚合探针和 HTTPS 健康均通过后写入 `phase=complete` 与 `completed_at`，清除 `active.json` 并持久化，然后在**同一把部署锁**内执行清理。清理结果写入这次部署目录的 `cleanup.json`，Actions 输出独立 `retention` 结果；清理失败、Docker 冲突或中断不会将成功部署改成 `recovery-required`，也不会自动回滚业务数据。下一次成功部署会重试；管理员也可使用下面的维护入口单独重试。

保留集合取并集：

- 当前运行 image ID，以及按成功记录排序的最近两个**不同的历史成功 image ID**。重复部署同一镜像不占历史名额；回退到旧版本仍保留另外两个最近成功版本。
- 所有运行或已停止容器使用的 image ID，以及最近一次当前版本成功部署记录中的 `old_image_id`。
- `retention-policy.json` 的显式回滚 pin。
- `/home/admin/pa-investment-deploy` 及策略声明的额外 `config_roots` 中的配置引用。递归读取 `.env`、`.env.*`、`*.env` 的 `DSH_IMAGE`，并通过 Docker Compose 渲染 `compose*.yaml/yml` 与 `docker-compose*.yaml/yml` 的服务镜像。嵌套的 `observatory-config.*/.env` 因而受保护。
- 最近七天导入的离线包对应镜像；重复导入相同归档只更新导入时间，不增加副本。

旧 `complete` 记录使用记录目录中的事务时间排序，**不使用镜像创建时间或文件 mtime 推断成功**。不足两个可信历史成功版本时整轮停止删除，先积累真实成功记录；不能将以前仅按时间选出的镜像伪造为成功记录。配置引用无法解析、文件/目录含符号链接、状态损坏、保护镜像不在本地或引用在执行期间变化时，停止该轮删除。

只有带本项目 OCI source label，且所有 tag/digest 均属于 `ghcr.io/pabiprg/pa-investment-research` 的镜像才进入候选；无标签镜像也须具有该 source label。含其他仓库别名的镜像不删除。使用精确 `docker image rm --no-prune`，不使用 `--force`、全局 prune、卷删除或父镜像递归清理。每次删除前重新读取容器、配置、策略和保护集合，并检查 tag 尚指向预期 ID。

备份快照目录不作为“当前配置根”递归扫描，否则每份历史备份会永久保护所有旧镜像。需要长期离线恢复的备份必须由管理员在策略里 pin 配对镜像。备份本身、数据卷、用户会话、SQLite、日志文件、Kuma、Cloudflared、系统 journal 均不会被此功能删除或修改。

### 首次启用步骤（尚未执行）

以下均须单独获服务器操作授权后，由管理员在 **aly** 执行；当前本地开发不要求用户操作。

| 执行者 | 位置 | 动作 | 状态 | 用户是否需要操作 |
|---|---|---|---|---|
| 管理员 | aly 的受控部署目录 | 盘点配置引用与完整镜像 ID，审核 pin | 待启用 | 本轮不用；获准迁移时执行 |
| 管理员 | aly 的已审阅代码目录 | 建立 root 私有策略和归档对象目录，运行 dry-run | 待启用 | 同上 |
| 管理员 | aly 的 Compose | 合并日志块并在批准的部署中重建 investment | 待启用 | 同上 |
| 管理员 | aly | 审核清理候选后改为 apply；后续成功部署自动清理 | 待启用 | 同上 |

1. 先走正常代码评审与发布流程。固定更新器仍只更新 `deploy.py`，不需要改变 wrapper、sudoers 或 `pa-deployer` 权限。管理员维护入口 `maintenance.py` 与同版本 `deploy.py` 放在一个 root/admin 控制、其他用户不可写的已审阅目录，使用现有 Python 3.11；不重跑通用 `install.sh`。
2. 在同一目录复制 `retention-policy.example.json` 为待审阅策略。默认 `mode=dry-run`，没有策略文件也只预览。`protected_images` 仅接受完整 `sha256:<64 hex>` config ID 或固定 GHCR digest，不能填短 ID、浮动 tag 或占位符。把背景中 `44d0f61db6b6`、`3970f140e00e` 等待确认历史镜像先解析为完整 ID 并 pin；核对当前 `e43bf827f2aa` 与配置引用 `78bc81110171` 的实际完整身份。**这些短 ID 只是历史线索，不能直接复制为当前事实或策略值。**
3. 默认配置根之外仍在使用的 Compose/环境目录加入 `config_roots`；文件名不符合上述发现规则的配置必须显式 pin 所引用的镜像。协调无部署、更新或 1Panel 操作后，使用共享锁安装**已审阅**策略；首次创建归档对象目录只作用于新建的 `objects`，不递归改属主或删除既有 artifacts 内容：

```sh
sudo flock -n /var/lib/pa-investment-deploy/deploy.lock \
  install -o root -g root -m 0600 ./retention-policy.reviewed.json \
  /var/lib/pa-investment-deploy/retention-policy.json
sudo install -d -o root -g root -m 0700 /home/admin/pa-investment-artifacts/objects
sudo /usr/bin/python3.11 -I -B ./maintenance.py retention
```

`retention` 本身重新获取部署锁；如有 `active.json` 或更新恢复日志会拒绝。它会执行当前实例聚合及 HTTPS 健康检查，因此即使 dry-run 也是需要授权的服务器操作。输出 `record` 路径下的 `cleanup.json` 列出保护 ID、候选镜像/归档摘要与结果；不输出 `.env` 或凭证。如果报历史不足，先确认旧成功记录或等待新真实成功部署积累，不按镜像时间补记录、不降低历史名额。

4. 审阅集合后，将同一份策略的 `mode` 改为 `apply`，保留所有 pin/config_roots，再按相同锁安装。下一次成功部署执行清理，也可再次执行 `maintenance.py retention`。不需要为清理重启服务；实际删除不可逆，先确认保留镜像与配对备份可恢复。`result=partial/failed` 表示清理未完成；部署 `status.json` 仍可为 `complete`。不要以“部署成功”忽略清理告警。

共享锁只约束参与本协议的程序。人工 Docker、1Panel、上传/配置修改也必须与该锁协调，不能在清理时并发改 tag、配置、归档或容器；脚本的复核不能把绕过锁的操作者变成原子事务。

### 部署包目录与迁移

GHCR 日常部署不在服务器额外保留 tar。离线/PR 包统一为：

```text
/home/admin/pa-investment-artifacts/objects/<归档SHA256>/
  archive.tar.gz
  metadata.json        # schema、归档 SHA、实际 config ID、导入时间
```

后续上传使用独立临时目录，先上传为 `.part`，完成后原子改名为 `investment-container.tar.gz`，在同一部署锁协议下导入；不要长期在 `incoming`、部署目录、HOME 和 PR 临时目录各留一份。导入器不提取 tar：它校验指定 SHA-256、单镜像 Docker save manifest、config/layer 成员和本项目 Linux amd64 source label，拒绝路径穿越、符号链接和设备成员。先落盘并校验受管对象，再按显式参数移除源文件；同摘要只保留一份。

在 aly 的已审阅脚本目录中，对**逐个确认的完整路径**执行：

```sh
sudo /usr/bin/python3.11 -I -B ./maintenance.py import-archive \
  /home/admin/incoming/已确认目录/investment-container.tar.gz \
  --sha256 '<来自可信构建附件的64位SHA256>' --remove-source
```

SHA 应来自可信构建附件校验清单，不能仅对来源不明包现算一个摘要便视为可信。旧包缺少来源证据时先保留并调查。可先省略 `--remove-source` 检查导入结果，确认后以相同参数加该选项重跑。只删除这个指定 tar；校验文件、配置、其他文件和父目录全部保留，已空的 PR 目录由管理员另行确认。**不执行任何 `rm -rf incoming/PR*` 一类目录清理。** 业务备份根和 Docker 卷目录禁止作为源。

保留当前、两个成功历史版本、显式 pin、容器/配置引用及七天内新导入对象；其余受管对象只在健康成功后的 apply 中删除。未部署包七天过期并不代表部署成功。对象内存在未知文件或摘要漂移时停止清理。普通导入失败清除本次私有暂存目录并保留源；进程被强杀可能留下 `.import-*`，自动清理不会猜测其归属，管理员在共享锁内核对后处理。归档删除若中断，可能留下不完整对象；检查 `cleanup.json` 和剩余两项固定文件，恢复原归档或确认后移除该精确对象，再重试。不能递归删除未知内容以解除阻塞。

### 日志轮转与回退

仓库 Compose 为 investment 配置如下服务级日志选项；aly 既有 Compose **只合并此块**，保留现网网络、端口、secret、数据卷及其他配置：

```yaml
logging:
  driver: json-file
  options:
    max-size: "20m"
    max-file: "3"
```

修改文件不会改变已创建容器，需在获准部署时重建 investment 才生效；单纯 `restart` 不足以应用。重建后核对 `docker inspect --format '{{json .HostConfig.LogConfig}}' <实际容器ID>` 与健康状态。不要直接截断 Docker 自管日志文件。依据：[Docker json-file 文档](https://docs.docker.com/engine/logging/drivers/json-file/)。此限制只控制该容器 stdout/stderr 日志，不等于整机总日志或应用卷内文件的限额。

停用清理：在共享锁内把策略改回 `dry-run`，保留 pin 与配置根即可，不必降级部署器。已删除镜像无法通过改策略还原，需要从 GHCR 或保留的离线包重新加载精确版本；数据已迁移时仍走原有整卷配对恢复流程。回退日志配置需要恢复审阅过的 Compose 日志块并另行批准重建。不可通过删成功记录、删 active.json、`down -v` 或删数据卷恢复磁盘空间。

### 镜像体积结论与验收边界

当前构建已经使用多阶段与 distroless、`pnpm deploy --prod`、独立 Python runtime；Linux 锁排除了 Chroma/ONNX 等依赖闭包，构建缓存不复制进运行镜像，已有基于校验值的非运行测试文件裁剪。约 1.15 GB 是背景中的旧测量，本轮没有 Linux Docker 层大小/包目录分解证据，**未进一步删除运行依赖，也不宣称镜像缩小或服务器释放空间**。下一次受准镜像构建应记录镜像 ID、`docker image inspect` 的 Size 和 `/opt/dsh`、`/opt/investment-python` 的体积分解后再决定是否裁剪；不能直接删除 numpy/pandas、证书、许可证、包元数据或 runtime.json 校验覆盖的文件。

真实验收结论：`Inconclusive`。本机无 Docker，且无本次服务器授权。

| 关注点 | 状态 | 所需实际证据 |
|---|---|---|
| Linux Docker 精确删除及共享层行为 | not-tested | 独立测试 Docker 上含多 tag、digest、停止容器的 dry-run/apply |
| 健康部署后自动清理与失败隔离 | not-tested | 成功部署、cleanup.json 与失败注入结果；业务仍健康 |
| 显式 pin 与配对数据恢复 | not-tested | 保留镜像可加载，原恢复流程成功且业务数据完整 |
| 日志轮转 | not-tested | 重建后的 LogConfig，受控日志写入与轮转观察 |

维护者负责在首次生产 apply 前关闭这些验证债务；本地标准库假驱动测试、真实临时 tar 文件测试与 Compose 解析是辅助证据，不代替上表。没有这些证据不标记 PAB-36 Done。

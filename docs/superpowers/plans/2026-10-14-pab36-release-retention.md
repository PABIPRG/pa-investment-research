# PAB-36 发布产物保留设计与实施计划

用户于 2026-10-14 确认设计，并指定目标版本 0.3.0。关联 PAB-20、PAB-29；完成本地实现后，用户授权提交、推送及创建 PR，由用户审阅并合并。不连接服务器、不触发部署。

## 事实源与复用

| 操作 | 现有入口 | 状态与副作用 | 缺口 | 决策 | 证据 |
|---|---|---|---|---|---|
| 判断成功版本 | deploy.py transact / verify | 备份目录 status.json，验证镜像、聚合探针及 HTTPS 后 complete | 无保留策略 | Extend | 现有完整事务与 37 项基线测试 |
| 排除并发 | deploy.lock、active.json | 独占锁、失败闭锁，更新器共用 | 清理须在同一锁内 | Reuse | deploy.py 与 update_deployer.py |
| 保护回滚 | old_image_id、配置快照、人工恢复 | 不自动恢复业务数据 | 无显式镜像保护集合 | Extend | ops 运维手册 |
| 管理离线包 | CI docker save 与 SHA-256 | runner 临时产物 | 服务器无统一目录与去重入口 | Create | investment-container.yml、通用容器教程 |
| 日志轮转 | compose.yaml investment | 容器创建配置 | 缺日志上限 | Extend | Compose 服务定义 |
| 镜像依赖 | 多阶段 distroless、pnpm deploy --prod、Linux Python 锁 | 已排除 Chroma 等大依赖并裁剪已审计测试文件 | 无新镜像体积分解证据 | Reuse | Dockerfile、打包脚本与锁 |

所有保留判断均为确定性逻辑，不使用模型推断成功、引用或文件归属。

## 设计与迁移

- 清理能力保持在单文件 deploy.py 内，兼容既有固定更新器只更新该文件的契约。
- 成功状态新增 completed_at；旧 complete 记录可按记录名中的事务时间排序，绝不用镜像创建时间推断成功。按不同 image ID 保留当前及最近两个历史成功版本。
- 在持有部署锁、成功状态持久化且活动标记移除之后执行清理。与部署异常处理分开，清理错误只写独立记录；下一次成功部署重试。
- root 私有 retention-policy.json 控制 dry-run/apply、额外配置根与显式回滚镜像。缺配置时只预览；历史成功不足两个时不删除，先积累可信记录。历史镜像和配置引用必须在启用前盘点，不按时间补造成功记录。
- 所有容器（含已停止）、活动标记、当前/嵌套配置引用、显式 pin 均受保护。配置无法解析、记录损坏或保护镜像无法解析则整轮停止。候选须有本项目 source label，不能带其他仓库引用；只调用精确 image rm --no-prune，不使用 force 或全局 prune。每次删除前重新校验引用和容器。
- 业务备份不参与目录清理。历史备份快照不自动保留所有镜像；需要离线恢复的备份由管理员显式 pin 配对镜像。
- 离线包统一至 /home/admin/pa-investment-artifacts/objects/<归档SHA256>/，在共享锁内校验归档 SHA、Docker save manifest 与 config ID 后发布。相同内容仅保留一份；旧 incoming/PR 目录只移除管理员逐个指定且成功归档的 tar，不递归删除父目录。
- 受管部署包复用镜像保护集合；未部署的新归档默认保护七天，显式回滚/配置/运行版本无期限保护。清理只处理带合法元数据的受管对象；半成品、未知文件和业务数据不会被递归清除。
- Compose 加入 json-file 20m × 3；服务器既有 Compose 只合并该配置块，不覆盖网络、secret、端口或卷；需获授权重建才生效。

## 实施与验证顺序

1. 为成功版本选择、保护集合、清理隔离及并发写失败测试。
2. 扩展部署器与独立管理员归档入口，补全去重/路径/失败恢复测试。
3. 配置日志轮转并更新通用教程和受控部署手册，记录升级与停用方法。
4. 运行部署器、归档、更新器兼容聚焦测试及差异检查；本机无 Docker，Linux 真镜像/真实回滚验收标未验证。

## 风险、恢复与验证债务

清理是不可逆的本地镜像删除，故旧站点默认 dry-run；apply 必须先核对保护清单。共享锁只能约束遵守协议的操作者，禁止同时经 1Panel 或手工 Docker 改配置/容器。策略恢复 dry-run 可立即停止后续删除，不能复原已删除镜像；恢复需从 GHCR 或受保护离线包加载精确版本，并按 PAB-18 配对恢复数据。

本地 worktree：/Users/xiexin/.codex/worktrees/release-retention/pa-investment-research；分支 codex/release-retention；初始基准 f563fda42401455c5eb48d8338f56b28d9bfa9f1。准备 PR 时快进到最新 public/master a467a325e0f8a60822f0a1eeebd60cb968629c4a；新增桌面端改动与本任务文件无重叠，已验证的部署代码保持一致。由当前 Agent 串行写入，不占用共享端口。私仓 master 落后，保持不变；仅推送本任务特性分支，PR 指向 public/master。

Linux Docker 集成与生产迁移债务：维护者负责在首次启用 apply 前关闭；取得真实部署成功、清理预览/执行、回滚镜像可用、日志配置及代表性业务证据。未关闭前不得宣称生产验收或释放空间已完成。

## 本地执行结果（2026-10-14）

已实现部署后保留、管理员归档入口、默认 dry-run 策略样例、Compose 日志轮转与运维教程。相关工作流的本地代码修改加入新回归测试、实际 Docker LogConfig 断言和实际 docker save 归档身份检查；没有触发工作流。没有更改 Dockerfile、生产依赖锁、业务数据或备份规则。

| 验证命令或检查 | 结果 |
|---|---|
| python3 -B -m unittest discover -s ops/pa-investment -p 'test_deploy.py' | 37 项：36 passed、1 skipped（Linux GNU tar 恢复演练） |
| 同入口 test_retention.py | 20 passed，包含失败先行证据 |
| 同入口 test_maintenance.py | 9 passed，使用真实临时 tar 文件 |
| 同入口 test_update_deployer.py | 23 passed |
| 同入口 test_ci.py | 8 passed |
| Compose YAML 实际解析 | json-file 20m × 3、原持久卷与聚合探针断言通过 |
| 两份修改后的工作流 | YAML 解析、内嵌 shell 的 bash -n 通过；没有执行步骤 |
| 管理入口 -I -B --help | passed，隔离 Python 模式能加载审阅目录的同版本 deploy.py |
| Python 3.8 语法解析、部署器 <256 KiB 更新协议 | passed；不等于生产 Python 实机验收 |
| git diff --check | passed |

人工自检重点：保留集合按 ID 去重，旧成功排序仅使用已成功事务记录；信号/清理错误与部署提交点分离；root 对象允许 admin 祖先但拒绝 admin 所有的对象叶节点；配置/容器变化中止执行；逐 tag 删除后确认 image ID 消失；业务备份根不允许迁移。清理不会调用 force/prune，不通过修改 sudoers 扩大权限。

共 97 项聚焦测试：96 passed、1 skipped。真实 Docker 删除、服务重建后日志轮转、生产恢复均为 not-tested；总体生产验收 Inconclusive。按用户授权准备 PR，并在 Linear PAB-36 关联提交、PR 与评审状态；目标里程碑 0.3.0。PR 创建不代表已合并、已上线或验收通过；服务器操作仍须单独授权。

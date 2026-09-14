# 云端管理员模型配置修复

关联 PAB-17 / WEB-AUTH-001；版本里程碑 0.2.0-alpha.2。角色 worktree-writer，独立目录 `/Users/xiexin/.codex/worktrees/595a/pa-investment-research`，基准为已核对远端的 `a02e1c9edcc2c3a7228dc041835650ca9286384c`，目标分支 `codex/cloud-web-model-admin`（提交前创建）。独立服务端口 3282；状态目录使用本任务 `/tmp` 子目录。未授权提交、推送、PR 或部署。

## 根因与能力审计

HTTP 登录和 CSRF 校验之后，connection 仍将 settings.describe/mutate、credentials 和 llm.discoverModels 限制到有效 loopback；远程模型页面依赖这些通用接口，因此无法加载配置。代码路径已确认，生产 Network 403 来源于交接证据，未连接生产复现。

| 用户动作 | 现有入口及状态所有者 | 缺口 | 决策 | 证据 |
| --- | --- | --- | --- | --- |
| 加载提供方 | llm.providers、settings.describe | 通用配置读取被限制且暴露范围过大 | 扩展 | ModelsSettingsStore、api-proxy |
| 保存提供方和模型 | settings.mutate，settings 文件服务持久化 | 缺模型范围授权 | 扩展 | ProviderEditor、CustomProviderCard |
| 保存密钥 | credentials.set/unset | 任意环境变量名不可开放 | 扩展 | CredentialProvider、api-proxy |
| 发现模型 | llm.discoverModels、pi-ai discovery | 普通 fetch 无 SSRF 防护，自动重定向 | 扩展 | discovery.ts |
| 错误重试 | ModelsSection | 已有错误和重试，首次加载无明确反馈 | 扩展 | ModelsSection.tsx |

所有权限、字段、凭证归属、持久化与网络地址判断均由确定性服务执行，无模型推断。

## 设计与实施顺序

1. 先写聚焦拒绝测试，证明缺少模型专用能力；复用 settings 与 credentials 所有者，不新增存储。
2. 新增 modelAdmin 命名空间。仅模型配置及所属凭证可读写，拒绝其他 namespace、危险路径、任意 credential-ref 和未允许字段。返回投影而非通用配置，密钥仅写入。
3. HTTP 入口仅向通过既有登录、CSRF、Host 和代理校验的管理员开放，未启用认证时保持 loopback 限制。通用设置和本机能力规则保持不变。
4. 模型发现使用独立的受限网络请求：公网 HTTPS、连接时解析并验证地址、禁止重定向、限制时间和响应体；私有端点兼容方案等待用户回答。不能把保存时的 DNS 校验等同于所有后续模型推理的网络隔离。
5. 模型页面与引导复用同一个 API 适配层；Electron 和本地路径沿用原能力。补充加载、权限错误与重试。
6. 聚焦安全回归、类型检查及必要构建；真实受信 HTTPS 代理登录后添加提供方、密钥、模型，再重启核对持久化。

## 体验契约与状态

目标用户是已登录的单用户管理员。主任务为添加可用模型，成功以服务端持久化并可重新读取为准。沿用现有页面、组件与语义 token，验证 1440/1024 及窄屏、明暗主题与键盘。

加载和刷新适用（反馈且保留既有数据）；空数据适用（添加入口）；筛选无结果沿用现有行为；部分成功适用（配置成功而密钥失败可重试）；过期适用（revision 冲突要求重载）；错误、无权限、禁用、成功、删除确认均适用。未引入新撤销机制，沿用编辑取消与删除确认。

## 验证与风险

未登录、缺 CSRF、伪造 Host/代理、通用配置访问、命名空间越权、凭证泄露及 SSRF 必须有拒绝证据。真实产品验收、重启持久化、Electron 兼容在完成前分别记录，未执行项标记未验证。此记录不是上线或 Done 证据。

## 本次验证记录

- Host、Client、Web 构建通过；最后 Host 类型检查通过。日志：`/tmp/cloud-model-host-build-final.log`、`/tmp/cloud-model-client-build-v3.log`、`/tmp/cloud-model-web-build-final.log`、`/tmp/cloud-model-host-typecheck-final.log`。
- 模型配置投影、写入归属、持久化、安全网络与元数据保留的聚焦测试通过；认证/CSRF/Host/可信代理回归 18 项通过。DNS 混合公私地址、固定连接地址、重定向、取消、响应大小均有拒绝测试。日志：`/tmp/cloud-model-focused-final.log`、`/tmp/cloud-model-metadata-test.log`、`/tmp/cloud-model-auth-tests.log`。
- Electron 连接与配置组合、API 客户端和传输兼容检查共 80 项通过：`/tmp/cloud-model-compat.log`。Electron 原生窗口尚未手动验证，不能将单元检查称为 Electron UAT。
- 新增真实 HTTPS 代理浏览器用例通过：受信任的非 loopback authority、测试管理员登录、首次权限错误后重试、创建提供方、写入密钥、保存模型、Host 重启后恢复。状态及截图在 `/tmp/cloud-model-uat-tpAdAq`，日志 `/tmp/cloud-model-uat.log`。测试使用独立目录和测试密钥；settings 文件不含密钥值。未调用真实收费模型。
- 人工查看了 1440、1024、768、390px 和深色、重启后截图。1440/1024/768 及深色列表可用；390px 的既有设置布局拥挤且被右侧表面干扰，不作为窄屏通过证据。本次未修改这些布局所有者。完整键盘遍历未验证。
- 全量 GUI：4339 项通过、16 项失败、4 项跳过。失败位于未修改的测试路径，包括 welcome notice、Agent preset、投研页面、目录选择器等；尚未以干净基线复跑证明其全部预存。日志 `/tmp/cloud-model-gui.log`。主题静态检查在未修改的投研样式中失败：`/tmp/cloud-model-theme.log`。不得报告全量门禁通过。
- 现有本地 Web 模型用例：4 项通过、6 项失败，日志 `/tmp/cloud-model-local-web.log`。首次失败是删除弹窗选择器期待全角问号 `删除 minimax-cn？`，实际渲染为半角问号；弹窗没有被关闭，后续步骤连带超时。未修改该既有用例或删除文案。新增云端用例单独通过，不替代这份回归失败。

## 交接限制与验证债务

本修复提供桌面云端管理员模型配置能力的代码及隔离环境证据，尚不代表版本可发布。PAB-17 保持现有项目状态，没有创建或修改外部 issue。版本负责人需在合并/发布前判定 GUI 与主题失败、390px 布局和 Electron 原生窗口验证是否阻塞 0.2.0-alpha.2；关闭条件为相应回归证据通过或项目系统中有明确的范围豁免。未执行生产部署、生产回归、Git 提交或 PR。

公网 HTTPS 是远程发现与新填端点的当前范围；推理适配器仍沿用现有出站行为，不提供全进程 SSRF 隔离。私网兼容尚未获得需求答复，未擅自放宽地址策略。

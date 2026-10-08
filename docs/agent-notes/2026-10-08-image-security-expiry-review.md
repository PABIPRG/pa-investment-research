# PAB-29 / PAB-30：镜像安全例外到期复核

## 结论与已批准方案

2026-10-08 为修复 PR #159 构建阻断，在本机重新下载并核验固定版本的官方 PyPI wheel，未安装或执行包代码，未访问用户服务器或行情接口。七个完整文件及其推导镜像路径的 SHA256、行号与仓库现有策略完全一致。使用官方 Gitleaks 8.30.1 macOS arm64、与 CI 相同的默认规则和解码/归档深度，对这七个文件离线扫描：八次 `generic-api-key` 命中全部符合原精确例外，剩余零次；未在文档或公开日志中记录匹配正文和常量值。

用户在阅读具体续期请求后，于 2026-10-08 明确回复“允许”。已在本地将这七条原范围秘密例外续期至 **2026-10-22 23:59 UTC（北京时间 10 月 23 日 07:59）**，并更新本次审核记录。规则、包版本、来源类别、完整路径/文件摘要、行号、数量、原因均保持原值，漏洞例外保持空。授权仅应用于此次准确范围和期限，不构成后续自动续期许可。

批准前已确认原生产策略在当前真实时钟下继续拒绝，候选 JSON 的结构校验没有被当作审核授权。批准后仅修改仓库策略的七组 `expiresAt` / `reviewedBy`，生产校验器保持不变；没有删除仍参与运行的第三方代码、关闭过期校验或添加宽泛忽略。

## 固定发行来源

下载通过 PyPI HTTPS 版本元数据解析官方 files.pythonhosted.org wheel，先核对整个 wheel 的发行 SHA256，再只读 ZIP 中的目标文件。源文件核验为纯 Python wheel；最终 Linux 安装结果仍由 CI 实际扫描复核。

| 包及元数据 | wheel | 归档 SHA256 |
|---|---|---|
| [tushare==1.4.29](https://pypi.org/pypi/tushare/1.4.29/json) | `tushare-1.4.29-py3-none-any.whl` | `82554af953ea5ac3d8771d42330493181031c7e68dccce03a491c7356e9ba4b2` |
| [akshare==1.18.88](https://pypi.org/pypi/akshare/1.18.88/json) | `akshare-1.18.88-py3-none-any.whl` | `ba0b06ea2d341122e2ef8ed5e4982ff5925f01111e63d7940c8a01aa684578c0` |
| [protobuf==7.35.1](https://pypi.org/pypi/protobuf/7.35.1/json) | `protobuf-7.35.1-py3-none-any.whl` | `4bc97768d8fe4ad6743c8a19403e314511ed9f6d13205b687e52421c023ac1b9` |

## 七条精确复核记录

来源类别均为 `python-dependency`，规则均为 `generic-api-key`。以下摘要对应完整文件，不是秘密值指纹。路径按构建目标 `opt/investment-python/site-packages/` 推导，实际镜像仍必须匹配该路径；不新增路径或数量豁免。

| 包 | 路径 SHA256 | 完整文件 SHA256 | 行号 | 数量 | 运行用途或生成来源 |
|---|---|---|---:|---:|---|
| `tushare==1.4.29` | `c78e1e79688259bbbca82b1c4f3ec4c10bbcc0b1c96aab3bd45d612d04a8886d` | `8c8edcfee145cd875bb2a269119170f763bbad6cba95fe8fb8b4451adcb8d77d` | 35 | 1 | Tushare 期货请求中的固定 Postman 请求头 |
| `tushare==1.4.29` | `4b06cd325cfadf66029ac919a592350d8c68b01aa91ed18f04b543bf1d3d73db` | `a859417d26049d7833e0c69619b2522463671e0cc9036ddce3dbfce74a1ea653` | 22 | 1 | Tushare protobuf 描述符生成表达式 |
| `akshare==1.18.88` | `9a56363cc5ab35a45ac78614b4485eedbdae68a2f0f97e871ffbae035d7e82b4` | `91a0a2f2071b44bcbb8409290d53c93516ed826ee635789fe733ccfcb631ccb0` | 37 | 2 | 中国货币网会话初始化参数；解码扫描产生两次命中 |
| `akshare==1.18.88` | `a7510f8fe8967b202cb4fb4b070ee2e3c670643055253d48c56fe8aabcfebb96` | `6eab34f3a758bca1a032e6e8ae2b066b637dbd8c52147d13df48a1b3255760ef` | 100 | 1 | 东方财富期货行情请求参数 |
| `akshare==1.18.88` | `d96b70ac42ed2dc1307edebe18463dc7246357d5202f9ae83acd26efe66d8c31` | `f559b9b4393e8bc6b4c9bcd6c1ad77b1405b58fa791ec918cc195f72cfab17b8` | 119 | 1 | 东方财富期权行情请求参数 |
| `akshare==1.18.88` | `f66bb52b3687fe6666452001e45c01aa805a829cc316895625dfb0b548507f33` | `bad55450e94f5c3a54c1ce9823d6d784c20f40a0ec4019a02d50c701a90ef06f` | 8 | 1 | 雪球行情默认请求 Cookie 的运行常量 |
| `protobuf==7.35.1` | `925ea1ba31cbf8683e42a5b0e4ef9365ef66fb8d3f1bd038c0efebdb3b3a5fe2` | `b4c932fabcbe0d134e11fadd729de38392f3846b3655881a473d43f32c6021fa` | 34 | 1 | protobuf 描述符生成表达式 |

上述生成表达式不是项目凭据；其余固定常量来自相同官方发行内容，参与第三方公开行情请求。公开发行并不等于供应商已保证这些常量长期有效或不存在风险，本轮没有探测其有效性。AkShare 四文件还与原本地安装的版本元数据及 RECORD 摘要相符，构建裁剪清单不删除它们；因此没有直接移除原例外的依据。

## 验证与后续边界

- Gitleaks macOS 归档 SHA256：`b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`，与官方 8.30.1 checksums 一致；只在临时目录运行，没有更改 CI 固定的 Linux 扫描器。
- 本地八次命中的规则、完整文件/路径摘要、行号和数量均由现有 `apply_secret_exceptions` 核对；未使用例外也会拒绝。此操作仅复核候选匹配，不调用或绕过正式发布流程。
- 修复后的运维入口 `python3 -B -m unittest discover -s ops/pa-investment -p 'test_*.py' -q`：106 项，105 通过，1 项因本机平台跳过；此证据来自续期批准前，单测内容此后未变，生产校验器始终未改动。独立只读审查未发现实质问题。
- 单测现使用独立策略和固定测试时钟；覆盖三类例外到期前 1 微秒、到期点、到期后及扫描/发布再次验证。CLI 用临时策略明确验证路径拒绝，避免被生产例外到期提前阻断而假通过。
- 批准后验证：实际仓库策略在真实时钟下通过；与原 JSON 逐字段比较，只有七组有效期/审核记录变化；新截止点前 1 微秒接受、到期点及后 1 微秒拒绝。镜像安全模块 38 项通过，生产校验器无差异。独立只读复审确认七条规则、八次授权命中及空漏洞例外均未扩展。
- 尚未验证：新 Linux 镜像、全镜像秘密/漏洞扫描、Compose、GitHub 新 CI；不将七文件零剩余命中称为完整镜像通过。未提交、推送、重跑 CI、部署或更新 Linear Done。
- 本次已获批准并在本地应用上述七条例外的有效期与审核信息；首次发布该候选前必须取得完整 CI 扫描通过证据。新增、缺失、漂移、额外数量及任一 UNKNOWN/HIGH/CRITICAL 漏洞仍阻断。回退可恢复原策略；原策略现已过期，回退会继续阻断发布。

本地可复核材料位于 `/private/tmp/observatory-1830-security-review/`：`review.json`、`scan-summary.json`、申请时的 `policy-pending-approval.json`、批准后的 `approved-policy-check.json` 及来源核验脚本。正式策略以仓库 JSON 为准。原始扫描报告已删除；保留摘要不包含命中正文。运维测试日志为 `/private/tmp/observatory-1830-security-tests.log`。

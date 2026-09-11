# Agent Note：部署能力显式化，浏览器备份传输有明确边界

状态：已实现

[English](2026-09-11-deployment-capabilities-and-web-file-transfer.md) | 中文

## 问题

本机 Web、Electron、CLI 与云端 Web 共用 UI 和 Host 方法，却缺少权威的部署形态声明。浏览器平台推断可能选中本地券商适配器；经过认证的云端客户端仍可能发现或提交服务端路径。投研备份只支持 Host 本地文件，因此云端浏览器既不能导入用户选择的文件，也不能下载已有归档。

## 决策

`@deepseek-ai/dsh-host-deployment-capabilities` 为整个进程提供一份不可变快照。基础组合声明 CLI；Web 启动通过 `DSH_DEPLOYMENT_SURFACE` 显式声明 `local-web` 或 `cloud-web`；Electron 将其覆盖为 `electron`。`host.describe` 把该快照交给 Client。

消费方依据快照采用 fail-closed（失败时关闭能力）策略。云端 Web 不挂载目录选择器；Host、Session 与 Workspace 投影不包含 Host 路径；带路径的创建方法与原生打开方法会被拒绝；持仓只允许手工录入或批量导入。本地形态保留既有的平台数据源名单。

投研备份上传继续使用既有的分块 Remote 流程和导入预览。已存备份下载使用独立、有界的 Remote 会话，因此每个分块都受认证传输保护，同时避免无上限请求体。Host 在第一次文件 await 前原子预留两个槽位之一，复查已打开文件的大小，再以固定长度读取并验证备份目录中的直接 `.pabackup` 归档。两个压缩快照的常驻上限为 128 MiB；并发校验连同有界解压可短暂达到 384 MiB 逻辑载荷上限，不含分配器开销。它要求精确 offset，并在完成、取消、错误、活动计时器过期或 Runtime 释放时删除会话。浏览器把取消信号传入每个 Remote，检查声明区间、组装 Blob、触发下载并撤销对象 URL。

## 结果

- UI 可见性只是易用性处理；即使请求经过伪造，Host 检查仍执行同一套云端限制。
- 云端用户看到托管备份存储，可以下载、上传、预览、取消、重试、导入或清空，而不会获知服务端目录。
- 云端 Web 绝不执行券商发现或同步；UI 引导用户采用手工录入或批量导入。
- 部署矩阵记录在 [`docs/deployment-capabilities.md`](../../../../docs/deployment-capabilities.md)。
- Web 认证保持不变。容器隔离与健康／就绪仍是独立部署事项。

## 验证

包级测试覆盖四种能力快照、显式启动解析、云端不挂载目录选择器、Host 路径拒绝与脱敏、云端持仓拒绝、有界备份下载与清理、客户端分块检查／取消，以及托管存储／仅手工 UI 状态。交付前还会构建 Web bundle，并在隔离的云端 Web 端口完成真实验收。

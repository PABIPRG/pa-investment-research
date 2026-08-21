# 投研 Python runtime

[English](investment-research.md) | 中文

该子系统是投研函数插件与其 Python HTTP endpoint 之间的 Host 生命周期能力。[`@deepseek-ai/dsh-investment-python-runtime`](../../packages/investment-research/python-runtime/README.md) 提供 `ctx.investmentPythonRuntime`；股票分析与盘中盯盘注册 backend 定义并持有 lease，而现有 [`ctx.subprocess`](subprocess.md) provider 拥有进程树原语。Runtime 不包含 HTTP/SSE 业务客户端或面向模型的工具。

源码：[`packages/investment-research/python-runtime/src/types.ts`](../../packages/investment-research/python-runtime/src/types.ts)

## Backend 身份与归属模式

```ts type-equiv
/** Stable investment Python backend identifiers. */
type InvestmentBackendId = 'trading-core' | 'market-watch'
```

```ts type-equiv
/** Backend ownership modes selected by plugin configuration. */
type InvestmentBackendMode = 'managed' | 'external'
```

id 同时是注册表 key 与预期服务身份。`managed` 只在身份感知健康探测明确报告 connection refused 后才允许本地 spawn；已经健康的服务归类为 `attached`。`external` 只验证 HTTP(S) 服务。lease 上的 ownership 记录该 Runtime 实例可以停止什么：只有 `owned`。

## Backend 定义

```ts type-equiv
/** Complete definition required to verify or start one Python backend. */
interface PythonBackendDefinition {
  /** Stable registry and diagnostic identifier. */
  readonly id: InvestmentBackendId
  /** Service identity required from the health response. */
  readonly service: InvestmentBackendId
  /** Whether dsh may own a child or only verify an external service. */
  readonly mode: InvestmentBackendMode
  /** HTTP base URL used by health checks and business clients. */
  readonly baseUrl: string
  /** Explicit absolute backend directory, when repository discovery is unavailable. */
  readonly projectDir?: string
  /** Backend directory components relative to a repository root. */
  readonly repositoryPath: readonly string[]
  /** Uvicorn application module. */
  readonly module: 'adapter.app:app' | 'market_watch.app:app'
  /** Health endpoint relative to the backend origin. */
  readonly healthPath: '/health'
  /** Additional response fields required for a healthy service. */
  readonly healthOk: Readonly<Record<string, string | boolean>>
  /** Platform-specific initialization command shown when the venv is absent. */
  readonly initCommand: Readonly<{ posix: './init.sh'; windows: 'init.bat' }>
  /** Explicit non-secret entries forwarded only to an owned child. */
  readonly managedEnv?: Readonly<Record<string, string | undefined>>
}
```

定义是一组完整注册事实。多个 owner 可以在同一 id 下注册逐字节相同的事实；任一字段不同都会成为启动冲突，而不会引入胜者选择规则。managed URL 必须是 loopback HTTP。路径发现从已安装的 Runtime 包开始，向上查找 `repositoryPath`；它绝不会从调用命令时的工作目录推断 backend。显式 `projectDir` 必须是存在的绝对路径。

## Lease

```ts type-equiv
/** One verified backend reference owned by its caller until release. */
interface PythonBackendLease {
  /** Backend definition id. */
  readonly id: InvestmentBackendId
  /** Verified base URL for the business client. */
  readonly baseUrl: string
  /** Process ownership established while acquiring this lease. */
  readonly ownership: 'owned' | 'attached' | 'external'
  /** Release this reference; repeated calls have no additional effect. */
  release(): Promise<void>
}
```

并发 `acquire(id)` 调用共享一次按 id single-flight 的启动。只有健康响应匹配已注册服务身份与必需字段，获取才会完成。调用方在完成后注册工具，并拥有且只拥有一次 release；重复 release 不产生额外效果。最后一次 release 会终止并等待 owned 进程树，attached 与 external 服务继续存活。Runtime dispose 会在结束前等待进行中的获取与 owned teardown。

## Runtime service

```ts public-api
/** Runtime service that verifies registered investment Python backends and leases their URLs. */
declare class InvestmentPythonRuntime extends Service {
  static inject;
  static Config: z<Config>;
  /**
   * Create and install the investment Python Runtime service.
   * @param ctx - Cordis context that owns this service.
   * @param config - deployment tunables used by managed lifecycle support.
   */
  constructor(ctx: Context, config: Config = {});
  /**
   * Register one backend definition.
   * @param definition - complete backend identity and launch definition.
   * @returns a disposer that removes this definition.
   */
  register(definition: PythonBackendDefinition): () => void;
  /**
   * Verify one registered backend and acquire a caller-owned lease.
   * @param id - registered backend id.
   * @param signal - optional health-check cancellation.
   * @returns a verified URL lease.
   */
  async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease>;
  /**
   * Read the mutable lifecycle relations consumed by the invariant companion.
   * @returns active backend entries and backend ids with in-flight acquisition.
   */
  invariantSnapshot(): ReturnType<InvestmentBackendManager['invariantSnapshot']>;
}
```

Runtime 把子进程输出与仅 owner 可读写的状态文件记录在 `$DSH_HOME/investment-research/<id>/` 下。状态不具权威性：stale 或 malformed 记录只用于诊断，绝不会触发 PID 采用、发送信号或端口接管。虚拟环境缺失时会给出 `./init.sh` 或 `init.bat` 指引并失败；安装不是启动副作用。

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxinvestmentpythonruntime--investmentpythonruntime"></a>

### `ctx.investmentPythonRuntime` — `InvestmentPythonRuntime`

Runtime service that verifies registered investment Python backends and leases their URLs.

```ts cordis-catalog
/**
 * Register one backend definition.
 * @param definition - complete backend identity and launch definition.
 * @returns a disposer that removes this definition.
 */
register(definition: PythonBackendDefinition): () => void

/**
 * Verify one registered backend and acquire a caller-owned lease.
 * @param id - registered backend id.
 * @param signal - optional health-check cancellation.
 * @returns a verified URL lease.
 */
async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease>

/**
 * Read the mutable lifecycle relations consumed by the invariant companion.
 * @returns active backend entries and backend ids with in-flight acquisition.
 */
invariantSnapshot(): ReturnType<InvestmentBackendManager['invariantSnapshot']>
```

Source: [`packages/investment-research/python-runtime/src/index.ts:42`](../../packages/investment-research/python-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->

import { Schema } from "koishi"
import type { Context } from "koishi"
import { Cause, Effect, FiberHandle, Option, Redacted } from "effect"
import { ModelSchemaName, type Config } from "../config/schema"
import { listModels } from "../models/catalog"
import { ModelHttp } from "../models/http/client"
import type { Provider } from "../models/provider"
import { Providers } from "../models/provider"

interface Candidate {
  readonly provider: Provider
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string | undefined
}

// 只有填了密钥的供应商才请求模型列表；显式读取响应式配置，不能枚举代理。
const candidates = (models: Config["models"]): Candidate[] =>
  Providers.flatMap((provider) => {
    const settings = models[provider]
    const apiKey = settings?.apiKey?.trim()
    if (!apiKey) return []
    return [{ provider, apiKey: Redacted.make(apiKey), baseUrl: settings?.baseUrl }]
  })

const catalogSchema = (ids: readonly string[]) =>
  Schema.union([...new Set(ids)].map((id) => Schema.const(id).description(id)))

// 固定本次配置快照；网络返回前及失败时仍保留当前值可选。
export const registerModelSchema = Effect.fn("Yokai.registerModelSchema")(
  function* (ctx: Context, models: Config["models"]) {
    const selected = models.default
    const sources = candidates(models)
    yield* Effect.sync(() => ctx.schema.set(ModelSchemaName, catalogSchema([selected])))
    const http = yield* ModelHttp
    const groups = yield* Effect.forEach(
      sources,
      (candidate) =>
        listModels(http, candidate.provider, candidate).pipe(
          Effect.tap((ids) => Effect.logDebug(`已获取 ${candidate.provider} 模型列表：${ids.length} 个`)),
          Effect.map((ids) => ids.map((id) => `${candidate.provider}/${id}`)),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            const failure = Cause.findErrorOption(cause)
            const reason = Option.isSome(failure)
              ? `${failure.value.kind}${failure.value.status === undefined ? "" : ` HTTP ${failure.value.status}`}`
              : "内部错误"
            return Effect.logWarning(`获取 ${candidate.provider} 模型列表失败：${reason}`).pipe(
              Effect.as([] as string[]),
            )
          }),
        ),
      { concurrency: "unbounded" },
    )
    yield* Effect.sync(() => ctx.schema.set(ModelSchemaName, catalogSchema([selected, ...groups.flat()])))
  },
)

// Koishi 的“重载”可能只更新响应式配置；更新时重取列表，并中断过时请求。
export const watchModelSchema = Effect.fn("Yokai.watchModelSchema")(
  function* (ctx: Context, models: Config["models"]) {
    const run = yield* FiberHandle.makeRuntime<ModelHttp>()
    yield* Effect.acquireRelease(
      Effect.sync(() => ctx.accept(["models"], (updated: Config) => {
        run(registerModelSchema(ctx, updated.models))
      })),
      (dispose) => Effect.sync(() => { dispose() }),
    )
    yield* Effect.sync(() => { run(registerModelSchema(ctx, models)) })
  },
)

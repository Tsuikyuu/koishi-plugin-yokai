import { Schema } from "koishi"
import type { Context } from "koishi"
import { Cause, Effect, FiberHandle, Option, Redacted, Ref } from "effect"
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

// 供应商在 /models 中显式声明的图片输入能力；按 provider/model 索引，随插件实例释放。
export type ImageSupport = Ref.Ref<ReadonlyMap<string, boolean>>
export const makeImageSupport = Effect.fn("Yokai.makeImageSupport")(function* () {
  return yield* Ref.make<ReadonlyMap<string, boolean>>(new Map())
})

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

interface CatalogEntry {
  readonly key: string
  readonly imageInput?: boolean
}

// 固定本次配置快照；网络返回前及失败时仍保留当前值可选。
export const registerModelSchema = Effect.fn("Yokai.registerModelSchema")(
  function* (ctx: Context, models: Config["models"], support?: ImageSupport) {
    const selected = models.default
    const sources = candidates(models)
    yield* Effect.sync(() => ctx.schema.set(ModelSchemaName, catalogSchema([selected])))
    const http = yield* ModelHttp
    const groups = yield* Effect.forEach(
      sources,
      (candidate) =>
        listModels(http, candidate.provider, candidate).pipe(
          Effect.tap((models) => Effect.logDebug(`已获取 ${candidate.provider} 模型列表：${models.length} 个`)),
          Effect.map((models) =>
            models.map(
              (model): CatalogEntry => ({
                key: `${candidate.provider}/${model.id}`,
                ...(model.imageInput === undefined ? {} : { imageInput: model.imageInput }),
              }),
            ),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            const failure = Cause.findErrorOption(cause)
            const reason = Option.isSome(failure)
              ? `${failure.value.kind}${failure.value.status === undefined ? "" : ` HTTP ${failure.value.status}`}`
              : "内部错误"
            return Effect.logWarning(`获取 ${candidate.provider} 模型列表失败：${reason}`).pipe(
              Effect.as([] as CatalogEntry[]),
            )
          }),
        ),
      { concurrency: "unbounded" },
    )
    const entries = groups.flat()
    if (support !== undefined) {
      const declared = entries.flatMap((entry) =>
        entry.imageInput === undefined ? [] : ([[entry.key, entry.imageInput]] as const),
      )
      yield* Ref.update(support, (current) => {
        const next = new Map(current)
        for (const [key, imageInput] of declared) next.set(key, imageInput)
        return next
      })
    }
    yield* Effect.sync(() => ctx.schema.set(ModelSchemaName, catalogSchema([selected, ...entries.map((e) => e.key)])))
  },
)

// Koishi 的“重载”可能只更新响应式配置；更新时重取列表，并中断过时请求。
export const watchModelSchema = Effect.fn("Yokai.watchModelSchema")(
  function* (ctx: Context, models: Config["models"], support?: ImageSupport) {
    const run = yield* FiberHandle.makeRuntime<ModelHttp>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        ctx.accept(["models"], (updated: Config) => {
          run(registerModelSchema(ctx, updated.models, support))
        }),
      ),
      (dispose) =>
        Effect.sync(() => {
          dispose()
        }),
    )
    yield* Effect.sync(() => {
      run(registerModelSchema(ctx, models, support))
    })
  },
)

import { Schema } from "koishi"
import type { Context } from "koishi"
import { Cause, Effect, Redacted } from "effect"
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

// 先注册当前值，网络返回后再补全列表；失败时仍保留当前值可选。
export const registerModelSchema = (ctx: Context, models: Config["models"]) => {
  ctx.schema.set(ModelSchemaName, catalogSchema([models.default]))
  return Effect.gen(function* () {
    const http = yield* ModelHttp
    const groups = yield* Effect.forEach(
      candidates(models),
      (candidate) =>
        listModels(http, candidate.provider, candidate).pipe(
          Effect.map((ids) => ids.map((id) => `${candidate.provider}/${id}`)),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed([] as string[]),
          ),
        ),
      { concurrency: "unbounded" },
    )
    ctx.schema.set(ModelSchemaName, catalogSchema([models.default, ...groups.flat()]))
  })
}

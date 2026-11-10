import { Effect, Schema } from "effect"
import type { Redacted } from "effect"
import { ModelHttp, type ModelHttpService } from "./http/client"
import { ModelError } from "./model"
import { DefaultBaseUrl, type Provider } from "./provider"

// 供应商使用 OpenAI 兼容的模型接口：GET {baseUrl}/models。
const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
})

export interface ModelSource {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string | undefined
}

export const listModels = Effect.fn("Yokai.listModels")(function* (
  http: ModelHttpService,
  provider: Provider,
  source: ModelSource,
) {
  const baseUrl = (source.baseUrl ?? DefaultBaseUrl[provider]).replace(/\/+$/, "")
  const raw = yield* http.getJson({ url: `${baseUrl}/models`, apiKey: source.apiKey })
  const body = yield* Schema.decodeUnknownEffect(ModelList)(raw).pipe(
    Effect.mapError(() => new ModelError({ kind: "InvalidResponse" })),
  )
  return body.data.map((model) => model.id)
})

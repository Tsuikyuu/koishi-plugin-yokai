import { Effect, Schema } from "effect"
import type { Redacted } from "effect"
import type { ModelHttpService } from "./http/client"
import { ModelError } from "./model"
import { DefaultBaseUrl, type Provider } from "./provider"

// 模型条目只保留注册下拉与能力判定需要的字段。
export interface ModelInfo {
  readonly id: string
  // 供应商显式声明可接受的输入模态；未声明时 undefined，由调用方使用供应商默认能力。
  readonly imageInput?: boolean
}

// OpenAI / DeepSeek 使用兼容的模型接口：GET {baseUrl}/models。
const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      input_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
})
const GeminiModelList = Schema.Struct({
  models: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isPattern(/^models\/[^\s/]+$/)),
        supportedGenerationMethods: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
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
  if (provider === "gemini") {
    let models: ModelInfo[] = []
    let pageToken: string | undefined
    do {
      const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""
      const raw = yield* http.getJson({
        url: `${baseUrl}/models${query}`,
        apiKey: source.apiKey,
        auth: "x-goog-api-key",
      })
      const body = yield* Schema.decodeUnknownEffect(GeminiModelList)(raw).pipe(
        Effect.mapError(() => new ModelError({ kind: "InvalidResponse" })),
      )
      models = [
        ...models,
        ...(body.models ?? [])
          .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
          .map((model) => ({ id: model.name.slice("models/".length) })),
      ]
      pageToken = body.nextPageToken
    } while (pageToken)
    return models
  }
  const raw = yield* http.getJson({ url: `${baseUrl}/models`, apiKey: source.apiKey })
  const body = yield* Schema.decodeUnknownEffect(ModelList)(raw).pipe(
    Effect.mapError(() => new ModelError({ kind: "InvalidResponse" })),
  )
  return body.data.map((model): ModelInfo => ({
    id: model.id,
    ...(model.input_modalities === undefined ? {} : { imageInput: model.input_modalities.includes("image") }),
  }))
})

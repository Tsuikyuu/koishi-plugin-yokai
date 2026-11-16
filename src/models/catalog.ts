import { Effect, Schema } from "effect"
import type { Redacted } from "effect"
import type { ModelHttpService } from "./http/client"
import { ModelError } from "./model"
import { DefaultBaseUrl, type Provider } from "./provider"

// OpenAI / DeepSeek 使用兼容的模型接口：GET {baseUrl}/models。
const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
})
const GeminiModelList = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^models\/[^\s/]+$/)),
    supportedGenerationMethods: Schema.optionalKey(Schema.Array(Schema.String)),
  }))),
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
    let ids: string[] = []
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
      ids = [...ids, ...(body.models ?? [])
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => model.name.slice("models/".length))]
      pageToken = body.nextPageToken
    } while (pageToken)
    return ids
  }
  const raw = yield* http.getJson({ url: `${baseUrl}/models`, apiKey: source.apiKey })
  const body = yield* Schema.decodeUnknownEffect(ModelList)(raw).pipe(
    Effect.mapError(() => new ModelError({ kind: "InvalidResponse" })),
  )
  return body.data.map((model) => model.id)
})

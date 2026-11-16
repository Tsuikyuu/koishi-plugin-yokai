import { Context, type Effect, type Redacted } from "effect"
import type { ModelError } from "../model"

export interface ModelHttpRequest {
  readonly url: string
  readonly apiKey: Redacted.Redacted<string>
  readonly auth?: "bearer" | "x-goog-api-key"
}

export interface ModelHttpPostRequest extends ModelHttpRequest {
  readonly body: unknown
}

export interface ModelHttpService {
  readonly getJson: (request: ModelHttpRequest) => Effect.Effect<unknown, ModelError>
  readonly postJson: (request: ModelHttpPostRequest) => Effect.Effect<unknown, ModelError>
}

export class ModelHttp extends Context.Service<ModelHttp, ModelHttpService>()("yokai/models/ModelHttp") {}

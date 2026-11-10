import { Context, Schema, type Effect } from "effect"
import type { ModelInput, ModelOutput, ModelError } from "../model"

export type ModelTraceOutcome =
  | { readonly status: "success"; readonly output: ModelOutput }
  | { readonly status: "failed"; readonly error: { readonly kind: ModelError["kind"]; readonly status?: number } }
  | { readonly status: "interrupted" | "defect" }

export class ModelTraceError extends Schema.TaggedError<ModelTraceError>()("ModelTraceError", {
  operation: Schema.Literals(["begin", "finish"]),
}) {}

export class ModelTraceStore extends Context.Service<
  ModelTraceStore,
  {
    // 开始记录成功后才能调用模型；返回用于配对输入与结果的记录 ID。
    readonly begin: (model: string, input: ModelInput) => Effect.Effect<string, ModelTraceError>
    readonly finish: (id: string, outcome: ModelTraceOutcome) => Effect.Effect<void, ModelTraceError>
  }
>()("yokai/models/ModelTraceStore") {}

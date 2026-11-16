import { Context, type Effect } from "effect"
import type { ModelError, ModelInput, ModelOutput } from "./model"

// 由当前模型目录声明；未声明时按供应商默认能力处理。
export interface ModelCapabilities {
  readonly imageInput: boolean
}

export class ModelGateway extends Context.Service<
  ModelGateway,
  {
    readonly capabilities: ModelCapabilities
    // 非流式；仅接受已声明工具的调用。失败不返回部分正文，不自动重试。
    readonly generate: (input: ModelInput) => Effect.Effect<ModelOutput, ModelError>
  }
>()("yokai/models/ModelGateway") {}

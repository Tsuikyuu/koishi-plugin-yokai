import type { DeepSeekConfig } from "./config"
import { ModelGatewayChatCompletions } from "../chat-completions/gateway"
import { DefaultBaseUrl } from "../provider"

export const ModelGatewayDeepSeek = (config: DeepSeekConfig) =>
  ModelGatewayChatCompletions({
    ...config,
    baseUrl: config.baseUrl ?? DefaultBaseUrl.deepseek,
  })

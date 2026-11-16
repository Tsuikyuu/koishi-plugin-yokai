import type { DeepSeekConfig } from "./config"
import { ModelGatewayChatCompletions } from "../chat-completions/gateway"
import { DefaultBaseUrl } from "../provider"
import type { ModelCapabilities } from "../gateway"

export const ModelGatewayDeepSeek = (config: DeepSeekConfig, capabilities?: ModelCapabilities) =>
  ModelGatewayChatCompletions(
    { ...config, baseUrl: config.baseUrl ?? DefaultBaseUrl.deepseek },
    capabilities,
  )

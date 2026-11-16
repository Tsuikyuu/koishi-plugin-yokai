import type { OpenAIConfig } from "./config"
import { ModelGatewayResponses } from "../responses/gateway"
import { DefaultBaseUrl } from "../provider"
import type { ModelCapabilities } from "../gateway"

export const ModelGatewayOpenAI = (config: OpenAIConfig, capabilities?: ModelCapabilities) =>
  ModelGatewayResponses(
    { ...config, baseUrl: config.baseUrl ?? DefaultBaseUrl.openai },
    capabilities,
  )

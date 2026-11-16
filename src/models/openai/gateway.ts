import type { OpenAIConfig } from "./config"
import { ModelGatewayResponses } from "../responses/gateway"
import { DefaultBaseUrl } from "../provider"

export const ModelGatewayOpenAI = (config: OpenAIConfig) =>
  ModelGatewayResponses({ ...config, baseUrl: config.baseUrl ?? DefaultBaseUrl.openai })

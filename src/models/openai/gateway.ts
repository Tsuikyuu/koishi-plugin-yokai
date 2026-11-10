import type { OpenAIConfig } from "./config"
import { ModelGatewayChatCompletions } from "../chat-completions/gateway"
import { ModelGatewayResponses } from "../responses/gateway"
import { DefaultBaseUrl } from "../provider"

export const ModelGatewayOpenAI = (config: OpenAIConfig) => {
  const options = { ...config, baseUrl: config.baseUrl ?? DefaultBaseUrl.openai }
  return config.api === "responses" ? ModelGatewayResponses(options) : ModelGatewayChatCompletions(options)
}

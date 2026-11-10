import type { DeepSeekProviderConfig, OpenAIProviderConfig } from "./validation"

export interface Config {
  readonly version: 1
  readonly timezone: string
  readonly models: {
    readonly default: string
    readonly deepseek?: DeepSeekProviderConfig
    readonly openai?: OpenAIProviderConfig
  }
  readonly characters: {
    readonly directory: string
    readonly presets: Record<string, string>
  }
  readonly roleplay: { readonly character: string }
}

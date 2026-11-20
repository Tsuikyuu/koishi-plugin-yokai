import type { DeepSeekProviderConfig, GeminiProviderConfig, OpenAIProviderConfig } from "./validation"

export interface Config {
  readonly version: 1
  readonly debug?: boolean
  readonly timezone: string
  readonly models: {
    readonly default: string
    readonly deepseek?: DeepSeekProviderConfig
    readonly openai?: OpenAIProviderConfig
    readonly gemini?: GeminiProviderConfig
  }
  readonly characters: {
    readonly directory: string
    readonly presets: Record<string, string>
  }
  readonly roleplay: {
    readonly character: string
    readonly routineEnabled?: boolean
    readonly triggerOnAt?: boolean
    readonly triggerOnQuote?: boolean
    readonly triggerOnName?: boolean
    readonly triggerOnNamePrefix?: boolean
    readonly debounceMs?: number
    readonly maxDebounceMs?: number
    readonly proactiveEnabled?: boolean
    readonly proactiveCooldownSeconds?: number
  }
}

import type { Redacted } from "effect"

// 已由配置边界校验；baseUrl 是 API 根地址，不含 /chat/completions 或 /responses。
export interface ChatCompletionsConfig {
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly timeoutMs: number
  readonly baseUrl?: string
  readonly temperature?: number
  readonly topP?: number
}

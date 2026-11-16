import type { Redacted } from "effect"

export const ReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof ReasoningEfforts)[number]

export interface OpenAIConfig {
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly timeoutMs: number
  readonly baseUrl?: string
  readonly reasoningEffort?: ReasoningEffort
}

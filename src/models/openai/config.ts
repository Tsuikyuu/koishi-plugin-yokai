import type { Redacted } from "effect"

export const ReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof ReasoningEfforts)[number]
export const ReasoningModes = ["standard", "pro"] as const
export type ReasoningMode = (typeof ReasoningModes)[number]
export const ReasoningContexts = ["auto", "current_turn", "all_turns"] as const
export type ReasoningContext = (typeof ReasoningContexts)[number]
export const VerbosityLevels = ["low", "medium", "high"] as const
export type Verbosity = (typeof VerbosityLevels)[number]

export interface OpenAIConfig {
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly timeoutMs: number
  readonly baseUrl?: string
  readonly maxOutputTokens?: number
  readonly reasoningEffort?: ReasoningEffort
  readonly reasoningMode?: ReasoningMode
  readonly reasoningContext?: ReasoningContext
  readonly verbosity?: Verbosity
}

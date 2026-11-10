import type { ChatCompletionsConfig } from "../chat-completions/config"

export const ReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof ReasoningEfforts)[number]

export interface OpenAIConfig extends ChatCompletionsConfig {
  readonly api?: "chat-completions" | "responses"
  readonly reasoningEffort?: ReasoningEffort
}

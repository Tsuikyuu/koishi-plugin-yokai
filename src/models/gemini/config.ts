import type { Redacted } from "effect"

export const ThinkingLevels = ["minimal", "low", "medium", "high", "xhigh"] as const
export type ThinkingLevel = (typeof ThinkingLevels)[number]

export const SafetyCategories = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_JAILBREAK",
] as const
export const SafetyThresholds = [
  "OFF",
  "BLOCK_NONE",
  "BLOCK_ONLY_HIGH",
  "BLOCK_MEDIUM_AND_ABOVE",
  "BLOCK_LOW_AND_ABOVE",
] as const
export interface SafetySetting {
  readonly category: (typeof SafetyCategories)[number]
  readonly threshold: (typeof SafetyThresholds)[number]
}

// baseUrl 包含 API 版本（默认 /v1beta），不含 /models 或 :generateContent。
export interface GeminiConfig {
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly timeoutMs: number
  readonly baseUrl?: string
  readonly thinkingLevel?: ThinkingLevel
  readonly maxOutputTokens?: number
  readonly stopSequences?: ReadonlyArray<string>
  readonly seed?: number
  readonly presencePenalty?: number
  readonly frequencyPenalty?: number
  readonly safetySettings?: ReadonlyArray<SafetySetting>
}

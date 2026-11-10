import type { Redacted } from "effect"
import type { DeepSeekProviderConfig, OpenAIProviderConfig } from "./validation"

export type ResolvedModelConfig = (
  | (Omit<DeepSeekProviderConfig, "apiKey"> & { readonly provider: "deepseek" })
  | (Omit<OpenAIProviderConfig, "apiKey"> & { readonly provider: "openai" })
) & {
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly timeoutMs: number
}

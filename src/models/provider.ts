export type Provider = "deepseek" | "openai" | "gemini"

export const Providers: readonly Provider[] = ["deepseek", "openai", "gemini"]

export const DefaultBaseUrl: Readonly<Record<Provider, string>> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
}

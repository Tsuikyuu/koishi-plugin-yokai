export type Provider = "deepseek" | "openai"

export const Providers: readonly Provider[] = ["deepseek", "openai"]

export const DefaultBaseUrl: Readonly<Record<Provider, string>> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
}

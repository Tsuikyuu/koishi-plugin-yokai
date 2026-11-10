import { Schema } from "effect"
import { CharacterId } from "../characters/character"
import { ReasoningEfforts } from "../models/openai/config"

const NonEmpty = Schema.String.check(Schema.isNonEmpty())
const TimeZone = NonEmpty.check(
  Schema.makeFilter((timeZone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone })
      return true
    } catch {
      return false
    }
  }),
)
const HttpUrl = NonEmpty.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value)
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }),
)

const SamplingTemperature = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2))
const SamplingTopP = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
const ReasoningEffort = Schema.Literals(ReasoningEfforts)

const providerFields = {
  baseUrl: Schema.optionalKey(HttpUrl),
  apiKey: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
}
export const DeepSeekProviderConfig = Schema.Struct({
  ...providerFields,
  temperature: Schema.optionalKey(SamplingTemperature),
  topP: Schema.optionalKey(SamplingTopP),
})
export type DeepSeekProviderConfig = typeof DeepSeekProviderConfig.Type
export const OpenAIProviderConfig = Schema.Struct({
  ...providerFields,
  api: Schema.optionalKey(Schema.Literals(["chat-completions", "responses"])),
  reasoningEffort: Schema.optionalKey(ReasoningEffort),
})
export type OpenAIProviderConfig = typeof OpenAIProviderConfig.Type

export const AppConfig = Schema.Struct({
  version: Schema.Literal(1),
  timezone: Schema.optionalKey(TimeZone),
  models: Schema.Struct({
    default: NonEmpty.check(Schema.isPattern(/^(deepseek|openai)\/[^\s/]+(?:\/[^\s/]+)*$/)),
    deepseek: Schema.optionalKey(DeepSeekProviderConfig),
    openai: Schema.optionalKey(OpenAIProviderConfig),
  }),
  characters: Schema.Struct({
    directory: NonEmpty,
    presets: Schema.Record(CharacterId, NonEmpty),
  }),
  roleplay: Schema.Struct({ character: CharacterId }),
})
export type AppConfig = typeof AppConfig.Type

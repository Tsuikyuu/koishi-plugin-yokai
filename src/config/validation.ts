import { Schema } from "effect"
import { CharacterId } from "../characters/character"
import { ReasoningContexts, ReasoningEfforts, ReasoningModes, VerbosityLevels } from "../models/openai/config"
import { ReasoningEfforts as DeepSeekReasoningEfforts } from "../models/deepseek/config"
import { SafetyCategories, SafetyThresholds, ThinkingLevels } from "../models/gemini/config"

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
const SamplingTopP = Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const ReasoningEffort = Schema.Literals(ReasoningEfforts)

const providerFields = {
  baseUrl: Schema.optionalKey(HttpUrl),
  apiKey: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
}
export const DeepSeekProviderConfig = Schema.Struct({
  ...providerFields,
  reasoningEffort: Schema.optionalKey(Schema.Literals(DeepSeekReasoningEfforts)),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 393216 }))),
  stopSequences: Schema.optionalKey(Schema.Array(NonEmpty).check(Schema.isMaxLength(16))),
  temperature: Schema.optionalKey(SamplingTemperature),
  topP: Schema.optionalKey(SamplingTopP),
})
export type DeepSeekProviderConfig = typeof DeepSeekProviderConfig.Type
export const OpenAIProviderConfig = Schema.Struct({
  ...providerFields,
  api: Schema.optionalKey(Schema.Literal("responses")),
  reasoningEffort: Schema.optionalKey(ReasoningEffort),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(16))),
  verbosity: Schema.optionalKey(Schema.Literals(VerbosityLevels)),
  reasoningMode: Schema.optionalKey(Schema.Literals(ReasoningModes)),
  reasoningContext: Schema.optionalKey(Schema.Literals(ReasoningContexts)),
})
export type OpenAIProviderConfig = typeof OpenAIProviderConfig.Type
export const GeminiProviderConfig = Schema.Struct({
  ...providerFields,
  thinkingLevel: Schema.optionalKey(Schema.Literals(ThinkingLevels)),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 }))),
  stopSequences: Schema.optionalKey(Schema.Array(NonEmpty).check(Schema.isMaxLength(5))),
  seed: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 }))),
  presencePenalty: Schema.optionalKey(Schema.Number),
  frequencyPenalty: Schema.optionalKey(Schema.Number),
  safetySettings: Schema.optionalKey(
    Schema.Array(Schema.Struct({
      category: Schema.Literals(SafetyCategories),
      threshold: Schema.Literals(SafetyThresholds),
    })).check(Schema.makeFilter((settings) => new Set(settings.map((setting) => setting.category)).size === settings.length)),
  ),
})
export type GeminiProviderConfig = typeof GeminiProviderConfig.Type

const PositiveNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))
const NonNegativeNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const ProbabilityCeiling = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))

export const ProactiveProbeConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  cooldownSeconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxBackoffShift: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 }))),
  halfLifeSeconds: Schema.optionalKey(PositiveNumber),
  activeWindowSeconds: Schema.optionalKey(PositiveNumber),
  idleResetSeconds: Schema.optionalKey(NonNegativeNumber),
  midpointHeat: Schema.optionalKey(PositiveNumber),
  steepness: Schema.optionalKey(PositiveNumber),
  maxProbability: Schema.optionalKey(ProbabilityCeiling),
  soloDelta: Schema.optionalKey(NonNegativeNumber),
  duoDelta: Schema.optionalKey(NonNegativeNumber),
  crowdDelta: Schema.optionalKey(NonNegativeNumber),
  soloImageBonus: Schema.optionalKey(NonNegativeNumber),
  groupImageBonus: Schema.optionalKey(NonNegativeNumber),
  echoBonus: Schema.optionalKey(NonNegativeNumber),
})
export type ProactiveProbeConfig = typeof ProactiveProbeConfig.Type

export const AppConfig = Schema.Struct({
  version: Schema.Literal(1),
  debug: Schema.optionalKey(Schema.Boolean),
  timezone: Schema.optionalKey(TimeZone),
  models: Schema.Struct({
    default: NonEmpty.check(Schema.isPattern(/^(deepseek|openai|gemini)\/[^\s/]+(?:\/[^\s/]+)*$/)),
    deepseek: Schema.optionalKey(DeepSeekProviderConfig),
    openai: Schema.optionalKey(OpenAIProviderConfig),
    gemini: Schema.optionalKey(GeminiProviderConfig),
  }),
  characters: Schema.Struct({
    directory: NonEmpty,
    presets: Schema.Record(CharacterId, NonEmpty),
  }),
  roleplay: Schema.Struct({
    character: CharacterId,
    routineEnabled: Schema.optionalKey(Schema.Boolean),
    triggerOnAt: Schema.optionalKey(Schema.Boolean),
    triggerOnQuote: Schema.optionalKey(Schema.Boolean),
    triggerOnName: Schema.optionalKey(Schema.Boolean),
    triggerOnNamePrefix: Schema.optionalKey(Schema.Boolean),
    debounceMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    maxDebounceMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    proactive: Schema.optionalKey(ProactiveProbeConfig),
  }),
})
export type AppConfig = typeof AppConfig.Type

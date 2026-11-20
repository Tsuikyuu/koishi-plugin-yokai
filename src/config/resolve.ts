import { isAbsolute, relative, resolve, sep } from "node:path"
import { Effect, Redacted, Schema } from "effect"
import { CharacterId } from "../characters/character"
import { ensureDefaultPresetFile } from "../characters/default-preset"
import { resolvePresetPath } from "../characters/file-catalog"
import { DefaultAmbientProbeConfig } from "../dialogue/ambient/probe"
import { AppConfig } from "./validation"
import { ConfigurationError } from "./error"
import type { Config } from "./config"
import type { ResolvedModelConfig } from "./resolved-model"
import type { Provider } from "../models/provider"

const fail = (field: string, reason: string) => new ConfigurationError({ path: "yokai", field, reason })

export const resolveModel = Effect.fn("Yokai.resolveModel")(function* (
  raw: Config["models"],
): Effect.fn.Return<ResolvedModelConfig, ConfigurationError> {
  const models = yield* Schema.decodeUnknownEffect(AppConfig.fields.models, { onExcessProperty: "error" })(raw).pipe(
    Effect.mapError(() => fail("models", "模型配置不符合契约")),
  )
  const selected = models.default?.trim()
  if (!selected) return yield* Effect.fail(fail("models.default", "尚未选择模型"))
  const provider = selected.slice(0, selected.indexOf("/")) as Provider
  const settings = models[provider]
  if (!settings) return yield* Effect.fail(fail(`models.${provider}`, "缺少所选模型的供应商配置"))
  const { apiKey } = settings
  if (!apiKey?.trim()) return yield* Effect.fail(fail(`models.${provider}.apiKey`, "所选模型的 API 密钥为空"))
  const resolved = {
    model: selected.slice(provider.length + 1),
    timeoutMs: settings.timeoutMs ?? 60000,
    apiKey: Redacted.make(apiKey),
  }
  switch (provider) {
    case "deepseek": return { ...models.deepseek, ...resolved, provider }
    case "openai": return { ...models.openai, ...resolved, provider }
    case "gemini": return { ...models.gemini, ...resolved, provider }
  }
})

export const resolveConfig = Effect.fn("Yokai.resolveConfig")(function* (raw: Config, baseDir: string) {
  // Koishi 的响应式配置仅代理属性读取，必须显式取值而不能枚举代理。
  const snapshot = {
    version: raw.version,
    ...(raw.debug === undefined ? {} : { debug: raw.debug }),
    timezone: raw.timezone,
    models: raw.models,
    characters: raw.characters,
    roleplay: raw.roleplay,
  }
  const config = yield* Schema.decodeUnknownEffect(AppConfig, { onExcessProperty: "error" })(snapshot).pipe(
    Effect.mapError(() => fail("$", "配置不符合 Yokai 配置契约")),
  )
  const dataDirectory = resolve(baseDir, "data/yokai")
  const directory = resolve(dataDirectory, config.characters.directory)
  const part = relative(dataDirectory, directory)
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    return yield* Effect.fail(fail("characters.directory", "角色目录必须位于 Koishi 的 data/yokai 内"))
  }
  const entries = Object.entries(config.characters.presets).map(
    ([id, file]) => [Schema.decodeSync(CharacterId)(id), file] as const,
  )
  if (!entries.some(([id]) => id === config.roleplay.character)) {
    return yield* Effect.fail(fail("roleplay.character", "未找到默认角色预设"))
  }
  yield* ensureDefaultPresetFile(dataDirectory, directory, entries)
  yield* Effect.forEach(entries, ([id, file]) => resolvePresetPath(directory, file, id))
  const debounceMs = config.roleplay.debounceMs ?? 2000
  const maxDebounceMs = config.roleplay.maxDebounceMs ?? Math.max(8000, debounceMs)
  if (maxDebounceMs < debounceMs) {
    return yield* Effect.fail(fail("roleplay.maxDebounceMs", "最长防抖等待时间不能小于防抖时间"))
  }
  return {
    debug: config.debug ?? false,
    dataDirectory,
    directory,
    presets: new Map(entries),
    characterId: config.roleplay.character,
    routineEnabled: config.roleplay.routineEnabled ?? true,
    triggers: {
      at: config.roleplay.triggerOnAt ?? true,
      quote: config.roleplay.triggerOnQuote ?? true,
      nameContains: config.roleplay.triggerOnName ?? true,
      namePrefix: config.roleplay.triggerOnNamePrefix ?? true,
    },
    debounce: {
      debounceMs,
      maxDebounceMs,
    },
    ambient: {
      enabled: config.roleplay.proactive?.enabled ?? DefaultAmbientProbeConfig.enabled,
      cooldownSeconds: config.roleplay.proactive?.cooldownSeconds ?? DefaultAmbientProbeConfig.cooldownSeconds,
      maxBackoffShift: config.roleplay.proactive?.maxBackoffShift ?? DefaultAmbientProbeConfig.maxBackoffShift,
      halfLifeSeconds: config.roleplay.proactive?.halfLifeSeconds ?? DefaultAmbientProbeConfig.halfLifeSeconds,
      activeWindowSeconds:
        config.roleplay.proactive?.activeWindowSeconds ?? DefaultAmbientProbeConfig.activeWindowSeconds,
      idleResetSeconds: config.roleplay.proactive?.idleResetSeconds ?? DefaultAmbientProbeConfig.idleResetSeconds,
      midpointHeat: config.roleplay.proactive?.midpointHeat ?? DefaultAmbientProbeConfig.midpointHeat,
      steepness: config.roleplay.proactive?.steepness ?? DefaultAmbientProbeConfig.steepness,
      maxProbability: config.roleplay.proactive?.maxProbability ?? DefaultAmbientProbeConfig.maxProbability,
      soloDelta: config.roleplay.proactive?.soloDelta ?? DefaultAmbientProbeConfig.soloDelta,
      duoDelta: config.roleplay.proactive?.duoDelta ?? DefaultAmbientProbeConfig.duoDelta,
      crowdDelta: config.roleplay.proactive?.crowdDelta ?? DefaultAmbientProbeConfig.crowdDelta,
      soloImageBonus: config.roleplay.proactive?.soloImageBonus ?? DefaultAmbientProbeConfig.soloImageBonus,
      groupImageBonus: config.roleplay.proactive?.groupImageBonus ?? DefaultAmbientProbeConfig.groupImageBonus,
      echoBonus: config.roleplay.proactive?.echoBonus ?? DefaultAmbientProbeConfig.echoBonus,
    },
    timezone: config.timezone ?? "Asia/Shanghai",
  }
})

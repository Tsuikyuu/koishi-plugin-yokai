import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Redacted } from "effect"
import { CharacterCatalog } from "../src/characters/catalog"
import { CharacterCatalogLocal } from "../src/characters/file-catalog"
import { Config } from "../src/config/schema"
import { resolveConfig, resolveModel } from "../src/config/resolve"
import { DefaultAmbientProbeConfig } from "../src/dialogue/ambient/probe"

const config: Config = {
  version: 1,
  timezone: "Asia/Shanghai",
  models: { default: "deepseek/deepseek-chat", deepseek: { apiKey: "fixture-secret" } },
  characters: { directory: "characters", presets: { default: "default.yml" } },
  roleplay: { character: "default" },
}

test("Koishi config auto-provisions built-in XiaoZhuiQiu default preset without overwriting user edits, and resolves files only beneath data/yokai", async () => {
  const root = await mkdtemp(join(tmpdir(), "yokai-config-"))
  try {
    const raw = Config({
      models: config.models,
    })
    assert.equal(raw.debug, false)
    assert.deepEqual(raw.characters.presets, { default: "default.yml" })
    assert.equal(Config.list?.[1]?.dict?.characters?.dict?.presets?.meta.role, "table")
    assert.equal(raw.roleplay.character, "default")
    assert.equal("database" in raw, false)
    assert.equal("presets" in raw, false)
    const reactive = new Proxy(raw, { ownKeys: () => [], has: () => false, getOwnPropertyDescriptor: () => undefined })
    const resolved = await Effect.runPromise(resolveConfig(reactive, root))
    assert.equal(resolved.debug, false)
    assert.equal(resolved.directory, join(root, "data/yokai/characters"))
    assert.equal(resolved.characterId, "default")

    // 空目录首次解析时自动落盘内置「小追求」预设，且可通过目录服务完整校验加载
    const builtInPreset = await Effect.runPromise(
      Effect.flatMap(CharacterCatalog, (catalog) => catalog.get(resolved.characterId)).pipe(
        Effect.provide(CharacterCatalogLocal(resolved.directory, resolved.presets)),
      ),
    )
    assert.equal(builtInPreset.character.id, "default")
    assert.equal(builtInPreset.character.name, "小追求")

    // 用户编辑过 default.yml 后，再次解析配置不得覆盖已有内容
    const presetPath = join(root, "data/yokai/characters/default.yml")
    assert.match(await readFile(presetPath, "utf8"), /# 基本设定/)
    await writeFile(presetPath, "version: 1 # customized\n")
    await Effect.runPromise(resolveConfig(reactive, root))
    assert.equal(await readFile(presetPath, "utf8"), "version: 1 # customized\n")

    assert.deepEqual(resolved.triggers, {
      at: true,
      quote: true,
      nameContains: true,
      namePrefix: true,
    })
    assert.deepEqual(resolved.debounce, {
      debounceMs: 2000,
      maxDebounceMs: 8000,
    })
    assert.deepEqual(resolved.ambient, DefaultAmbientProbeConfig)
    const customProactive = {
      enabled: false,
      cooldownSeconds: 60,
      maxBackoffShift: 4,
      halfLifeSeconds: 30.5,
      activeWindowSeconds: 90.5,
      idleResetSeconds: 600.5,
      midpointHeat: 1.65,
      steepness: 4.3,
      maxProbability: 0.57,
      soloDelta: 0.02,
      duoDelta: 0.24,
      crowdDelta: 0.37,
      soloImageBonus: 0.18,
      groupImageBonus: 0.35,
      echoBonus: 0.57,
    }
    const customized = await Effect.runPromise(
      resolveConfig(
        Config({
          ...config,
          debug: true,
          roleplay: {
            character: "default",
            triggerOnAt: true,
            triggerOnQuote: false,
            triggerOnName: false,
            triggerOnNamePrefix: true,
            debounceMs: 1500,
            maxDebounceMs: 6000,
            proactive: customProactive,
          },
        }),
        root,
      ),
    )
    assert.equal(customized.debug, true)
    assert.deepEqual(customized.triggers, {
      at: true,
      quote: false,
      nameContains: false,
      namePrefix: true,
    })
    assert.deepEqual(customized.debounce, {
      debounceMs: 1500,
      maxDebounceMs: 6000,
    })
    assert.deepEqual(customized.ambient, customProactive)
    for (const invalidProactive of [
      { cooldownSeconds: -1 },
      { cooldownSeconds: 1.5 },
      { maxBackoffShift: -1 },
      { maxBackoffShift: 17 },
      { maxBackoffShift: 1.5 },
      { halfLifeSeconds: 0 },
      { halfLifeSeconds: -5 },
      { activeWindowSeconds: 0 },
      { idleResetSeconds: -1 },
      { midpointHeat: 0 },
      { steepness: 0 },
      { maxProbability: 0 },
      { maxProbability: 1.01 },
      { soloDelta: -0.01 },
      { duoDelta: -0.01 },
      { crowdDelta: -0.01 },
      { soloImageBonus: -0.01 },
      { groupImageBonus: -0.01 },
      { echoBonus: -0.01 },
    ]) {
      assert.throws(() => Config({ ...config, roleplay: { character: "default", proactive: invalidProactive } }))
      assert.equal(
        (
          await Effect.runPromiseExit(
            resolveConfig({ ...config, roleplay: { character: "default", proactive: invalidProactive } }, root),
          )
        )._tag,
        "Failure",
      )
    }
    assert.equal(
      (
        await Effect.runPromiseExit(
          resolveConfig({ ...config, roleplay: { character: "default", debounceMs: 5000, maxDebounceMs: 1000 } }, root),
        )
      )._tag,
      "Failure",
    )
    for (const invalid of [
      { ...config, timezone: "Invalid/Zone" },
      { ...config, roleplay: { character: "missing" } },
      { ...config, characters: { ...config.characters, directory: "../../escape" } },
      { ...config, characters: { ...config.characters, presets: { default: "../escape.yml" } } },
      { ...config, characters: { ...config.characters, presets: { custom: "missing.yml" } }, roleplay: { character: "custom" } },
    ]) {
      assert.equal((await Effect.runPromiseExit(resolveConfig(invalid, root)))._tag, "Failure")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("selected model credentials remain redacted and model updates validate independently", async () => {
  const resolved = await Effect.runPromise(resolveModel(config.models))
  assert.equal(resolved.model, "deepseek-chat")
  assert.equal(Redacted.value(resolved.apiKey), "fixture-secret")
  assert.equal(JSON.stringify(resolved).includes("fixture-secret"), false)
  const invalid = [
    { default: "other/model", deepseek: { apiKey: "fixture-secret" } },
    { default: "openai/model" },
    { default: "gemini/model" },
    { default: "gemini/model", gemini: { apiKey: " " } },
    { default: "gemini/model", gemini: { apiKey: "fixture-secret", temperature: 1 } },
    { default: "gemini/model", gemini: { apiKey: "fixture-secret", topP: 1 } },
    { default: "gemini/model", gemini: { apiKey: "fixture-secret", topK: 40 } },
    { default: "gemini/model", gemini: { apiKey: "fixture-secret", api: "responses" } },
    { default: "deepseek/model", deepseek: {} },
    { default: "deepseek/model", deepseek: { apiKey: " " } },
    { default: "openai/model", openai: { apiKey: "fixture-secret", temperature: 0.5 } },
    {
      default: "deepseek/model",
      deepseek: { apiKey: "fixture-secret", baseUrl: "https://name:secret@example.com" },
    },
  ]
  for (const models of invalid) {
    assert.equal((await Effect.runPromiseExit(resolveModel(models)))._tag, "Failure")
  }
})

test("DeepSeek validates sampling bounds and keeps its reasoning settings independent of OpenAI", async () => {
  for (const settings of [
    { temperature: 0, topP: Number.MIN_VALUE, reasoningEffort: "none" },
    { temperature: 2, topP: 1, reasoningEffort: "max" },
  ] as const) {
    const raw = Config({
      ...config,
      models: {
        default: "deepseek/deepseek-v4-pro",
        deepseek: { apiKey: "fixture-secret", ...settings },
        openai: { reasoningEffort: "medium" },
      },
    })
    const resolved = await Effect.runPromise(resolveModel(raw.models))
    assert.equal(resolved.provider, "deepseek")
    assert.equal(resolved.temperature, settings.temperature)
    assert.equal(resolved.topP, settings.topP)
    assert.equal(resolved.reasoningEffort, settings.reasoningEffort)
  }
  for (const settings of [
    { topP: 0 },
    { topP: -0.1 },
    { topP: 1.01 },
    { temperature: -0.1 },
    { temperature: 2.01 },
    { reasoningEffort: "medium" },
    { reasoningEffort: "xhigh" },
    { reasoningEffort: "" },
  ]) {
    const models = { default: "deepseek/deepseek-v4-pro", deepseek: { apiKey: "fixture-secret", ...settings } }
    assert.throws(() => Config({ ...config, models }))
    assert.equal((await Effect.runPromiseExit(resolveModel(models as Config["models"])))._tag, "Failure")
  }
})

test("DeepSeek validates output-token and stop-sequence limits through both configuration boundaries", async () => {
  for (const settings of [
    { maxOutputTokens: 1, stopSequences: [] },
    { maxOutputTokens: 393216, stopSequences: Array.from({ length: 16 }, (_, index) => `stop-${index}`) },
  ]) {
    const raw = Config({
      models: { default: "deepseek/deepseek-v4-pro", deepseek: { apiKey: "fixture-secret", ...settings } },
    })
    const resolved = await Effect.runPromise(resolveModel(raw.models))
    assert.equal(resolved.provider, "deepseek")
    assert.equal(resolved.maxOutputTokens, settings.maxOutputTokens)
    assert.deepEqual(resolved.stopSequences, settings.stopSequences)
  }
  for (const settings of [
    { maxOutputTokens: 0 },
    { maxOutputTokens: -1 },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: 393217 },
    { stopSequences: [""] },
    { stopSequences: Array.from({ length: 17 }, (_, index) => `stop-${index}`) },
  ]) {
    const models = { default: "deepseek/deepseek-v4-pro", deepseek: { apiKey: "fixture-secret", ...settings } }
    assert.throws(() => Config({ models }))
    assert.equal((await Effect.runPromiseExit(resolveModel(models)))._tag, "Failure")
  }
})

test("OpenAI resolves Responses controls without overriding omitted values", async () => {
  const cases: NonNullable<Config["models"]["openai"]>[] = [
    { maxOutputTokens: 16, verbosity: "low", reasoningMode: "pro", reasoningContext: "all_turns", reasoningEffort: "high" },
    { maxOutputTokens: 8192, verbosity: "high", reasoningMode: "standard", reasoningContext: "current_turn" },
    { reasoningContext: "auto", verbosity: "medium" },
    { api: "responses" },
    {},
  ]
  for (const settings of cases) {
    const raw = Config({
      models: { default: "openai/gpt-test", openai: { apiKey: "fixture-secret", ...settings } },
    })
    const resolved = await Effect.runPromise(resolveModel(raw.models))
    assert.equal(resolved.provider, "openai")
    assert.equal(resolved.api, "responses")
    assert.equal(resolved.maxOutputTokens, settings.maxOutputTokens)
    assert.equal(resolved.verbosity, settings.verbosity)
    assert.equal(resolved.reasoningMode, settings.reasoningMode)
    assert.equal(resolved.reasoningContext, settings.reasoningContext)
    assert.equal(resolved.reasoningEffort, settings.reasoningEffort)
    assert.ok(!JSON.stringify(resolved).includes("fixture-secret"))
  }
})

test("OpenAI rejects invalid Responses controls and the unsupported Chat Completions API", async () => {
  for (const settings of [
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1 },
    { maxOutputTokens: 15 },
    { maxOutputTokens: 16.5 },
    { verbosity: "verbose" },
    { reasoningMode: "fast" },
    { reasoningContext: "history" },
    { api: "chat-completions" },
  ]) {
    const models = { default: "openai/gpt-test", openai: { api: "responses", apiKey: "fixture-secret", ...settings } }
    assert.throws(() => Config({ models }))
    assert.equal((await Effect.runPromiseExit(resolveModel(models as Config["models"])))._tag, "Failure")
  }
})

test("Gemini configuration resolves independently through the Koishi schema", async () => {
  const raw = Config({
    ...config,
    models: {
      default: "gemini/gemini-test",
      gemini: {
        apiKey: "fixture-secret",
        thinkingLevel: "high",
        maxOutputTokens: 65536,
        stopSequences: ["<end>"],
        seed: 0,
        presencePenalty: 0,
        frequencyPenalty: 0.5,
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
      },
    },
  })
  const resolved = await Effect.runPromise(resolveModel(raw.models))
  assert.equal(resolved.provider, "gemini")
  assert.equal(resolved.model, "gemini-test")
  assert.equal(resolved.timeoutMs, 60000)
  assert.equal(resolved.baseUrl, "https://generativelanguage.googleapis.com/v1beta")
  assert.equal(resolved.thinkingLevel, "high")
  assert.equal(resolved.maxOutputTokens, 65536)
  assert.deepEqual(resolved.stopSequences, ["<end>"])
  assert.equal(resolved.seed, 0)
  assert.equal(resolved.presencePenalty, 0)
  assert.equal(resolved.frequencyPenalty, 0.5)
  assert.deepEqual(resolved.safetySettings, [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }])
  assert.equal(Redacted.value(resolved.apiKey), "fixture-secret")
  assert.equal(JSON.stringify(resolved).includes("fixture-secret"), false)
})

test("Gemini rejects invalid generation settings before sending a request", async () => {
  for (const settings of [
    { thinkingLevel: "none" },
    { thinkingBudget: 1000 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
    { seed: 0.5 },
    { seed: 2147483648 },
    { stopSequences: [""] },
    { stopSequences: ["a", "b", "c", "d", "e", "f"] },
    { safetySettings: [{ category: "unknown", threshold: "OFF" }] },
    { safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "unknown" }] },
    { safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    ] },
  ]) {
    const models = { default: "gemini/gemini-test", gemini: { apiKey: "fixture-secret", ...settings } }
    assert.equal((await Effect.runPromiseExit(resolveModel(models as Config["models"])))._tag, "Failure")
  }
})

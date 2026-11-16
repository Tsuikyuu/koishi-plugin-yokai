import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Redacted } from "effect"
import { Config } from "../src/config/schema"
import { resolveConfig, resolveModel } from "../src/config/resolve"

const config: Config = {
  version: 1,
  timezone: "Asia/Shanghai",
  models: { default: "deepseek/deepseek-chat", deepseek: { apiKey: "fixture-secret" } },
  characters: { directory: "characters", presets: { companion: "companion.yml" } },
  roleplay: { character: "companion" },
}

test("Koishi config keeps file references and resolves files only beneath data/yokai", async () => {
  const root = await mkdtemp(join(tmpdir(), "yokai-config-"))
  try {
    await mkdir(join(root, "data/yokai/characters"), { recursive: true })
    await writeFile(join(root, "data/yokai/characters/companion.yml"), "version: 1\n")
    const raw = Config(config)
    assert.deepEqual(raw.characters.presets, { companion: "companion.yml" })
    assert.equal("database" in raw, false)
    assert.equal("presets" in raw, false)
    const reactive = new Proxy(raw, { ownKeys: () => [], has: () => false, getOwnPropertyDescriptor: () => undefined })
    const resolved = await Effect.runPromise(resolveConfig(reactive, root))
    assert.equal(resolved.directory, join(root, "data/yokai/characters"))
    for (const invalid of [
      { ...config, timezone: "Invalid/Zone" },
      { ...config, roleplay: { character: "missing" } },
      { ...config, characters: { ...config.characters, directory: "../../escape" } },
      { ...config, characters: { ...config.characters, presets: { companion: "../escape.yml" } } },
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

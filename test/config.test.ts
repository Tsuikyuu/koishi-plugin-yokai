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

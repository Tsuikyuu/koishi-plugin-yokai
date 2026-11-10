import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Effect, Layer, Schema, SchemaIssue } from "effect"
import { CharacterCatalog } from "./catalog"
import { CharacterId } from "./character"
import { CharacterLoadError, CharacterNotFound } from "./errors"
import { CharacterPreset } from "./preset"
import { readYamlFile } from "./yaml"

const isInside = (root: string, path: string) => {
  const part = relative(root, path)
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

// 供启动流程验证所有注册路径；预设内容仅在首次选择时读取。
export const resolvePresetPath = (directory: string, filename: string, characterId: CharacterId) =>
  Effect.tryPromise({
    try: async () => {
      const root = resolve(directory)
      const path = resolve(root, filename)
      if (isAbsolute(filename) || !isInside(root, path)) throw new Error("path")
      const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)])
      if (!isInside(realRoot, realPath)) throw new Error("path")
      return realPath
    },
    catch: () =>
      new CharacterLoadError({
        characterId,
        path: directory,
        reason: "预设必须是角色目录内可访问的相对文件路径（包括符号链接解析后）",
      }),
  })

const loadPreset = (directory: string, filename: string, characterId: CharacterId) =>
  Effect.gen(function* () {
    const path = yield* resolvePresetPath(directory, filename, characterId)
    const data = yield* readYamlFile(path).pipe(
      Effect.mapError((error) => new CharacterLoadError({ characterId, path, reason: error.reason })),
    )
    const preset = yield* Schema.decodeUnknownEffect(CharacterPreset, { onExcessProperty: "error" })(data).pipe(
      Effect.mapError((error) => {
        const issue = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0]
        const field = issue?.path?.map((part) => String(typeof part === "object" ? part.key : part)).join(".") || "$"
        return new CharacterLoadError({ characterId, path, reason: `${field}: 预设字段不符合 CharacterPreset Schema` })
      }),
    )
    if (preset.character.id !== characterId) {
      return yield* Effect.fail(
        new CharacterLoadError({ characterId, path, reason: "character.id 与注册角色 ID 不一致" }),
      )
    }
    return preset
  })

export const CharacterCatalogLocal = (directory: string, presets: ReadonlyMap<CharacterId, string>) =>
  Layer.effect(
    CharacterCatalog,
    Effect.gen(function* () {
      const entries = yield* Effect.forEach([...presets], ([characterId, filename]) =>
        Effect.gen(function* () {
          const get = yield* Effect.cached(loadPreset(directory, filename, characterId))
          return [characterId, get] as const
        }),
      )
      const byId = new Map(entries)
      return CharacterCatalog.of({
        get: (id) => byId.get(id) ?? Effect.fail(new CharacterNotFound({ characterId: id })),
      })
    }),
  )

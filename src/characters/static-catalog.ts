import { Effect, Layer } from "effect"
import { CharacterCatalog } from "./catalog"
import { CharacterNotFound } from "./errors"
import { type CharacterPreset } from "./preset"

// 用于模板演示及测试；不伪装成本地文件适配器。
export const CharacterCatalogStatic = (presets: ReadonlyArray<CharacterPreset>) =>
  Layer.sync(CharacterCatalog, () => {
    const byId = new Map(presets.map((preset) => [preset.character.id, preset]))
    return CharacterCatalog.of({
      get: (characterId) => {
        const character = byId.get(characterId)
        return character === undefined ? Effect.fail(new CharacterNotFound({ characterId })) : Effect.succeed(character)
      },
    })
  })

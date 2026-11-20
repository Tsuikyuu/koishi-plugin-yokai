import { Schema } from "effect"
import { CharacterId } from "./character"

export class CharacterNotFound extends Schema.TaggedError<CharacterNotFound>()("CharacterNotFound", {
  characterId: CharacterId,
}) {
  override get message(): string {
    return `未找到角色预设 ${this.characterId}`
  }
}

export class CharacterLoadError extends Schema.TaggedError<CharacterLoadError>()("CharacterLoadError", {
  characterId: CharacterId,
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `加载角色预设 ${this.characterId} 失败（${this.path}）：${this.reason}`
  }
}

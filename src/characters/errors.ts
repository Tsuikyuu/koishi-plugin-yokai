import { Schema } from "effect"
import { CharacterId } from "./character"

export class CharacterNotFound extends Schema.TaggedError<CharacterNotFound>()("CharacterNotFound", {
  characterId: CharacterId,
}) {}

export class CharacterLoadError extends Schema.TaggedError<CharacterLoadError>()("CharacterLoadError", {
  characterId: CharacterId,
  path: Schema.String,
  reason: Schema.String,
}) {}

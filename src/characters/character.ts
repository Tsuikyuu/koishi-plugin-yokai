import { Schema } from "effect"

export const CharacterId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("CharacterId"))
export type CharacterId = typeof CharacterId.Type

export const Character = Schema.Struct({
  id: CharacterId,
  name: Schema.String.check(Schema.isNonEmpty()),
  aliases: Schema.Array(Schema.String),
  basicSetting: Schema.String,
  detailedSetting: Schema.String,
  scene: Schema.String,
  style: Schema.String,
  guidance: Schema.Array(Schema.String),
})
export type Character = typeof Character.Type

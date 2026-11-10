import { Schema } from "effect"

export const CharacterState = Schema.Struct({
  emotion: Schema.String,
  condition: Schema.String,
  activity: Schema.String,
  short_memory: Schema.String,
})
export type CharacterState = typeof CharacterState.Type

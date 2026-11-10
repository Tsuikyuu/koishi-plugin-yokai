import { Schema } from "effect"
import { Character } from "./character"
import { CharacterState } from "./state"

export const InitialState = CharacterState
export type InitialState = typeof InitialState.Type

export const CharacterPreset = Schema.Struct({
  version: Schema.Literal(1),
  character: Character,
  initialState: InitialState,
})
export type CharacterPreset = typeof CharacterPreset.Type

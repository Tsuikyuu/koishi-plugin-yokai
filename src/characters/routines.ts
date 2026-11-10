import { Context, type Effect } from "effect"
import type { CharacterId } from "./character"
import type { CharacterRoutine, CharacterRoutineError } from "./routine"

export class CharacterRoutines extends Context.Service<
  CharacterRoutines,
  {
    readonly get: (id: CharacterId) => Effect.Effect<CharacterRoutine, CharacterRoutineError>
    readonly update: (id: CharacterId, routine: CharacterRoutine) => Effect.Effect<void, CharacterRoutineError>
  }
>()("yokai/characters/CharacterRoutines") {}

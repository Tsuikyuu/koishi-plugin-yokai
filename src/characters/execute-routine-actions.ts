import { Effect } from "effect"
import { replaceRoutineRange } from "./routine"
import { CharacterRoutines } from "./routines"
import type { ExecuteRoutineAction } from "./routine-actions"

export const executeRoutineAction: ExecuteRoutineAction = (characterId, action) =>
  Effect.gen(function* () {
    const routines = yield* CharacterRoutines
    const routine = replaceRoutineRange(yield* routines.get(characterId), action)
    yield* routines.update(characterId, routine)
  })

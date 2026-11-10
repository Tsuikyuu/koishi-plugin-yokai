import type { Effect } from "effect"
import type { CharacterId } from "./character"
import type { CharacterRoutineError, RoutineAction } from "./routine"
import type { CharacterRoutines } from "./routines"

// 动作调度方按 XML 顺序调用；每次只修改一个连续时段，不触发额外模型生成。
export type ExecuteRoutineAction = (
  characterId: CharacterId,
  action: RoutineAction,
) => Effect.Effect<void, CharacterRoutineError, CharacterRoutines>

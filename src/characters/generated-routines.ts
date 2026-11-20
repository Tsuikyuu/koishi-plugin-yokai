import { Effect, Layer, Ref, Schema } from "effect"
import { CharacterRoutine, CharacterRoutineError } from "./routine"
import { type CharacterPreset } from "./preset"
import { ModelGateway } from "../models/gateway"
import { buildRoutineContext } from "./routine-prompt"
import { CharacterRoutines } from "./routines"

export const CharacterRoutinesLive = (presets: ReadonlyArray<CharacterPreset>, timezone: string) =>
  Layer.effect(
    CharacterRoutines,
    Effect.gen(function* () {
      const model = yield* ModelGateway
      const generated = yield* Effect.forEach(
        presets,
        Effect.fn("CharacterRoutines.generate")(function* (preset) {
          return yield* Effect.gen(function* () {
            yield* Effect.logDebug(`正在生成角色 ${preset.character.id}（${preset.character.name}）日常时间表`)
            const output = yield* model.generate(buildRoutineContext(preset, timezone))
            const reason = `角色「${preset.character.name}」的日程必须是连续覆盖 00:00–24:00 的分钟级 JSON 时间表`
            if (output.toolCalls !== undefined) return yield* Effect.fail(new CharacterRoutineError({ reason }))
            const routine = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CharacterRoutine), {
              onExcessProperty: "error",
            })(output.text).pipe(Effect.mapError(() => new CharacterRoutineError({ reason })))
            yield* Effect.logDebug(`角色 ${preset.character.id} 日常时间表生成完成（${routine.entries.length} 个时段）`)
            return { id: preset.character.id, routine }
          }).pipe(Effect.annotateLogs({ character: preset.character.id, trigger: "routine-init" }))
        }),
      )
      const routines = yield* Ref.make(generated)
      return CharacterRoutines.of({
        get: Effect.fn("CharacterRoutines.get")(function* (id) {
          const found = (yield* Ref.get(routines)).find((item) => item.id === id)
          if (found === undefined) {
            return yield* Effect.fail(new CharacterRoutineError({ reason: `角色「${id}」尚未生成日常时间表` }))
          }
          return found.routine
        }),
        update: Effect.fn("CharacterRoutines.update")(function* (id, routine) {
          const updated = yield* Ref.modify(routines, (items) => {
            if (!items.some((item) => item.id === id)) return [false, items] as const
            return [true, items.map((item) => (item.id === id ? { id, routine } : item))] as const
          })
          if (!updated) {
            return yield* Effect.fail(new CharacterRoutineError({ reason: `角色「${id}」尚未生成日常时间表` }))
          }
        }),
      })
    }),
  )

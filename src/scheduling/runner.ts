import { Cause, Effect, Exit, Option, Schedule } from "effect"
import type { ScheduleTask } from "./schedule"
import { Scheduler } from "./scheduler"

// dispatch 由入口显式传入；调度扫描不依赖笔记、频道或工具注册表。
export const runDueSchedules = <A, E extends { readonly _tag: string }, R>(
  dispatch: (task: ScheduleTask) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const tasks = yield* scheduler.due
    return yield* Effect.forEach(
      tasks,
      (task) =>
        dispatch(task).pipe(
          Effect.exit,
          Effect.map((exit) => ({ task, exit })),
        ),
      { concurrency: "unbounded" },
    )
  })

export const runScheduleLoop = <A, E extends { readonly _tag: string }, R>(
  dispatch: (task: ScheduleTask) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const results = yield* runDueSchedules(dispatch)
    for (const { task, exit } of results) {
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause)
        yield* Effect.logError("schedule 触发失败", {
          scheduleId: task.id,
          error: Option.isSome(error) ? error.value._tag : "Defect",
        })
      }
    }
  }).pipe(Effect.repeat(Schedule.spaced("1 second")))

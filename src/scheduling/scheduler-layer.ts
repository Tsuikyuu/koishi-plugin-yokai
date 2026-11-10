import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect"
import { InvalidSchedule, type ScheduleInput, type ScheduleOutcome, type ScheduleTask } from "./schedule"
import { nextScheduleTime } from "./time"
import { Scheduler } from "./scheduler"
import { ScheduleNotFound, ScheduleStore } from "./store"

const nextCron = (cron: string, timezone: string, now: Date) =>
  Effect.try({
    try: () => nextScheduleTime(cron, timezone, now),
    catch: () => new InvalidSchedule({ reason: "schedule 必须包含有效五段或六段 cron、时区和可达的下次时间" }),
  })

const nextForCreate = (input: ScheduleInput, now: Date) =>
  Effect.gen(function* () {
    if (input.kind === "at") {
      if (input.at === null || input.at.getTime() <= now.getTime()) {
        return yield* Effect.fail(new InvalidSchedule({ reason: "一次性唤醒时间必须晚于当前时间" }))
      }
      return input.at
    }
    const next = yield* nextCron(input.cron, input.timezone, now)
    if (next === null) return yield* Effect.fail(new InvalidSchedule({ reason: "cron 没有可达的下次触发时间" }))
    return next
  })

const nextForRun = (task: ScheduleTask, now: Date) =>
  task.kind === "at" ? Effect.succeed(null) : nextCron(task.cron, task.timezone, now)

export const SchedulerLive = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const store = yield* ScheduleStore
    return Scheduler.of({
      create: (input) =>
        Effect.gen(function* () {
          return yield* store.create(input, yield* nextForCreate(input, yield* DateTime.nowAsDate))
        }),
      update: (id, input, enabled = true) =>
        Effect.gen(function* () {
          const nextAt = enabled ? yield* nextForCreate(input, yield* DateTime.nowAsDate) : null
          return yield* store.update(id, input, nextAt, enabled ? "enabled" : "paused")
        }),
      delete: store.delete,
      query: store.query,
      cancel: store.cancel,
      get: (id) =>
        store
          .get(id)
          .pipe(
            Effect.flatMap((task) =>
              task === undefined ? Effect.fail(new ScheduleNotFound({ scheduleId: id })) : Effect.succeed(task),
            ),
          ),
      due: DateTime.nowAsDate.pipe(Effect.flatMap(store.listDue)),
      run: (task, execute, describeError) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const now = yield* DateTime.nowAsDate
            if (task.nextAt === null || task.nextAt > now) return undefined
            const run = yield* store.claim(task, yield* nextForRun(task, now), now)
            if (run === undefined) return undefined
            const exit = yield* Effect.exit(restore(Effect.suspend(() => execute(run))))
            let outcome: ScheduleOutcome
            if (Exit.isSuccess(exit)) outcome = { status: "success", result: exit.value }
            else if (Cause.hasInterrupts(exit.cause)) outcome = { status: "interrupted" }
            else {
              const error = Cause.findErrorOption(exit.cause)
              outcome = Option.isSome(error)
                ? { status: "failed", error: error.value._tag, details: describeError(error.value) }
                : { status: "failed", error: "Defect", details: {} }
            }
            yield* store.finish(run.id, outcome, yield* DateTime.nowAsDate)
            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
            return { runId: run.id, result: exit.value }
          }),
        ),
    })
  }),
)

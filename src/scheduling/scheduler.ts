import { Context, type Effect, type Schema } from "effect"
import type {
  InvalidSchedule,
  ScheduleId,
  ScheduleInput,
  ScheduleRun,
  ScheduleTask,
  ScheduleQuery,
  SchedulePage,
} from "./schedule"
import type { ScheduleNotFound, ScheduleStoreError } from "./store"

export type SchedulerError = InvalidSchedule | ScheduleStoreError | ScheduleNotFound

// 独立调度能力；不识别笔记、频道或业务 payload，不负责业务锁。
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly create: (input: ScheduleInput) => Effect.Effect<ScheduleTask, InvalidSchedule | ScheduleStoreError>
    readonly update: (
      id: ScheduleId,
      input: ScheduleInput,
      enabled?: boolean,
    ) => Effect.Effect<ScheduleTask, SchedulerError>
    readonly delete: (id: ScheduleId) => Effect.Effect<void, ScheduleStoreError | ScheduleNotFound>
    readonly query: (query: ScheduleQuery) => Effect.Effect<SchedulePage, ScheduleStoreError>
    readonly cancel: (id: ScheduleId) => Effect.Effect<void, ScheduleStoreError | ScheduleNotFound>
    readonly get: (id: ScheduleId) => Effect.Effect<ScheduleTask, ScheduleStoreError | ScheduleNotFound>
    readonly due: Effect.Effect<ReadonlyArray<ScheduleTask>, ScheduleStoreError>
    // 调用方先获取业务锁，再运行；结果落盘后返回原值或原错误。错误摘要由业务方提供。
    readonly run: <A extends Schema.JsonObject, E extends { readonly _tag: string }, R>(
      task: ScheduleTask,
      execute: (run: ScheduleRun) => Effect.Effect<A, E, R>,
      describeError: (error: E) => Schema.JsonObject,
    ) => Effect.Effect<
      { readonly runId: string; readonly result: A } | undefined,
      E | InvalidSchedule | ScheduleStoreError,
      R
    >
  }
>()("yokai/scheduling/Scheduler") {}

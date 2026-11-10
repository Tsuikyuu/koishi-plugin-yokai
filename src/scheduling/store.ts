import { Context, Data, type Effect } from "effect"
import type {
  ScheduleId,
  ScheduleInput,
  ScheduleOutcome,
  ScheduleRun,
  ScheduleState,
  ScheduleTask,
  ScheduleQuery,
  SchedulePage,
} from "./schedule"

export class ScheduleStoreError extends Data.TaggedError("ScheduleStoreError")<{
  readonly operation: "create" | "update" | "cancel" | "get" | "listDue" | "claim" | "finish" | "query" | "delete"
}> {}
export class ScheduleNotFound extends Data.TaggedError("ScheduleNotFound")<{
  readonly scheduleId: ScheduleId
}> {}

export class ScheduleStore extends Context.Service<
  ScheduleStore,
  {
    readonly create: (input: ScheduleInput, nextAt: Date) => Effect.Effect<ScheduleTask, ScheduleStoreError>
    readonly update: (
      id: ScheduleId,
      input: ScheduleInput,
      nextAt: Date | null,
      state: ScheduleState,
    ) => Effect.Effect<ScheduleTask, ScheduleStoreError | ScheduleNotFound>
    readonly delete: (id: ScheduleId) => Effect.Effect<void, ScheduleStoreError | ScheduleNotFound>
    readonly query: (query: ScheduleQuery) => Effect.Effect<SchedulePage, ScheduleStoreError>
    readonly cancel: (id: ScheduleId) => Effect.Effect<void, ScheduleStoreError | ScheduleNotFound>
    readonly get: (id: ScheduleId) => Effect.Effect<ScheduleTask | undefined, ScheduleStoreError>
    readonly listDue: (now: Date) => Effect.Effect<ReadonlyArray<ScheduleTask>, ScheduleStoreError>
    // 比较快照版本，原子推进 nextAt 并记录 running；更新或取消后的旧快照不能领取。
    readonly claim: (
      task: ScheduleTask,
      nextAt: Date | null,
      now: Date,
    ) => Effect.Effect<ScheduleRun | undefined, ScheduleStoreError>
    readonly finish: (id: string, outcome: ScheduleOutcome, now: Date) => Effect.Effect<void, ScheduleStoreError>
  }
>()("yokai/scheduling/ScheduleStore") {}

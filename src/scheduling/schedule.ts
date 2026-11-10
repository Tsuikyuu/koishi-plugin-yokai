import { Schema } from "effect"

export const ScheduleKind = Schema.Literals(["cron", "at"])
export type ScheduleKind = typeof ScheduleKind.Type

export const ScheduleState = Schema.Literals(["enabled", "paused", "completed"])
export type ScheduleState = typeof ScheduleState.Type

export const ScheduleId = Schema.NonEmptyString.pipe(Schema.brand("ScheduleId"))
export type ScheduleId = typeof ScheduleId.Type

// at 使用一次性的绝对时间；cron 使用分/时/日/月/周[/年] 表达式。at 任务不保存 cron。
export interface ScheduleSpec {
  readonly kind: ScheduleKind
  readonly cron: string
  readonly at: Date | null
  readonly timezone: string
}

export interface ScheduleInput extends ScheduleSpec {
  readonly payload: Schema.JsonObject
}

export interface ScheduleTask extends ScheduleInput {
  readonly id: ScheduleId
  readonly nextAt: Date | null
  readonly state: ScheduleState
  readonly revision: number
}

export interface ScheduleQuery {
  readonly payload: Readonly<Record<string, string>>
  readonly id?: ScheduleId
  readonly keyword?: string
  readonly offset: number
  readonly limit: number
}
export interface SchedulePage {
  readonly tasks: ReadonlyArray<ScheduleTask>
  readonly hasMore: boolean
}

export interface ScheduleRun {
  readonly id: string
  readonly scheduleId: ScheduleId
  readonly payload: Schema.JsonObject
  readonly kind: ScheduleKind
  readonly cron: string
  readonly scheduledAt: Date
}

export type ScheduleOutcome =
  | { readonly status: "success"; readonly result: Schema.JsonObject }
  | { readonly status: "failed"; readonly error: string; readonly details: Schema.JsonObject }
  | { readonly status: "interrupted" }

export class InvalidSchedule extends Schema.TaggedError<InvalidSchedule>()("InvalidSchedule", {
  reason: Schema.String,
}) {}

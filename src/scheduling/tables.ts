import type { Schema } from "effect"

export interface ScheduleRecord {
  id: string
  kind: "at" | "cron"
  cron: string
  at: Date | null
  timezone: string
  payload: Schema.JsonObject
  nextAt: Date | null
  state: "enabled" | "paused" | "completed"
  revision: number
}

export interface ScheduleRunRecord {
  id: string
  scheduleId: string | null
  payload: Schema.JsonObject
  scheduledAt: Date
  startedAt: Date
  finishedAt: Date | null
  status: "running" | "success" | "failed" | "interrupted"
  outcome: Schema.JsonObject | null
}

declare module "koishi" {
  interface Tables {
    yokai_schedule: ScheduleRecord
    yokai_schedule_run: ScheduleRunRecord
  }
}

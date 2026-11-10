import type { Context } from "koishi"
import type {} from "./tables"

export function registerScheduleModels(ctx: Context): void {
  ctx.model.extend(
    "yokai_schedule",
    {
      id: "string",
      kind: "string",
      cron: "string",
      at: { type: "timestamp", nullable: true },
      timezone: "string",
      payload: "json",
      nextAt: { type: "timestamp", nullable: true },
      state: "string",
      revision: "unsigned",
    },
    { primary: "id" },
  )
  ctx.model.extend(
    "yokai_schedule_run",
    {
      id: "string",
      scheduleId: { type: "string", nullable: true },
      payload: "json",
      scheduledAt: "timestamp",
      startedAt: "timestamp",
      finishedAt: { type: "timestamp", nullable: true },
      status: "string",
      outcome: { type: "json", nullable: true },
    },
    { primary: "id" },
  )
}

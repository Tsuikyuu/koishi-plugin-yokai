import { Schema } from "effect"
import { ScheduleId } from "../../scheduling/schedule"
import { type ModelTool } from "../../models/model"

const Query = Schema.Struct({
  operation: Schema.Literal("query"),
  id: Schema.optionalKey(ScheduleId),
  keyword: Schema.optionalKey(Schema.String),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
})

const CreateAt = Schema.Struct({
  operation: Schema.Literal("create"),
  at: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})

const CreateCron = Schema.Struct({
  operation: Schema.Literal("create"),
  cron: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})

const UpdateAt = Schema.Struct({
  operation: Schema.Literal("update"),
  id: ScheduleId,
  at: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})

const UpdateCron = Schema.Struct({
  operation: Schema.Literal("update"),
  id: ScheduleId,
  cron: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})

const Target = Schema.Struct({ operation: Schema.Literals(["pause", "resume", "delete"]), id: ScheduleId })

export const WakeUpToolArguments = Schema.Union([Query, CreateAt, CreateCron, UpdateAt, UpdateCron, Target])
export type WakeUpToolArguments = typeof WakeUpToolArguments.Type

export const wakeUpTool: ModelTool = {
  name: "wake-up",
  description:
    "管理当前频道的长期主动唤醒任务。create 使用 at（带时区的 ISO 8601 一次性时间）或 cron（五段或 EventBridge 六段：分 时 日 月 周 年）；update 完整替换时间与正文；pause/resume/delete 管理任务。query 必填 offset、limit，可选 ID 或关键词分页查找。写操作立即生效，不随后续生成失败回滚；先查询再修改，不编造 ID。",
  parameters: Schema.toJsonSchemaDocument(WakeUpToolArguments, { onExcessProperty: "error" }).schema,
}

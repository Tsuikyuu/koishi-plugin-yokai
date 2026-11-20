import { Schema } from "effect"

export const NextReplyTtlSeconds = 180
export const NextReplyTtlMs = NextReplyTtlSeconds * 1000

const BoundedSeconds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: NextReplyTtlSeconds }))

// 短期唤醒条件：仅在 NextReplyTtlSeconds 内有效；
// message_from_user 在下一条目标用户消息到达时生效；
// silence 在目标用户（或所有人）沉默指定秒数后生效。
export const NextReplyAction = Schema.Struct({
  type: Schema.Literal("next-reply"),
  condition: Schema.Literals(["message_from_user", "silence"]),
  userId: Schema.NonEmptyString,
  seconds: Schema.optionalKey(BoundedSeconds),
  maxWaitSeconds: Schema.optionalKey(BoundedSeconds),
  group: Schema.NonEmptyString,
}).check(
  Schema.makeFilter(({ condition, seconds, maxWaitSeconds, userId }) =>
    condition === "message_from_user"
      ? seconds === undefined && maxWaitSeconds === undefined
      : seconds !== undefined && (maxWaitSeconds === undefined || userId !== "all"),
  ),
)
export type NextReplyAction = typeof NextReplyAction.Type

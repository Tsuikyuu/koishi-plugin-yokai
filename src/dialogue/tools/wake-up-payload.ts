import { Schema } from "effect"

// 长期主动唤醒任务；调度核心只保存不透明 payload。
export const WakeUpReplyPayload = Schema.Struct({
  type: Schema.Literal("wake-up"),
  platform: Schema.NonEmptyString,
  channelId: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})
export type WakeUpReplyPayload = typeof WakeUpReplyPayload.Type

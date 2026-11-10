import { Schema } from "effect"

export const ParticipantId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("ParticipantId"))
export type ParticipantId = typeof ParticipantId.Type
export const MessageId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("MessageId"))
export type MessageId = typeof MessageId.Type

export const Participant = Schema.Struct({
  id: ParticipantId,
  name: Schema.String.check(Schema.isNonEmpty()),
})
export type Participant = typeof Participant.Type

// time 是 Unix 毫秒时间戳；展示时由上下文构造器格式化。
export const Message = Schema.Struct({
  id: MessageId,
  sender: ParticipantId,
  time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  text: Schema.String.check(Schema.isNonEmpty()),
  quote: Schema.optionalKey(MessageId),
})
export type Message = typeof Message.Type

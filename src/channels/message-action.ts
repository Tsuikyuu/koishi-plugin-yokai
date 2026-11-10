import { Schema } from "effect"
import { MessageId } from "./message"

// 消息发送动作；不是已经发送的消息。
export const MessageAction = Schema.Struct({
  type: Schema.Literal("message"),
  text: Schema.String.check(Schema.isNonEmpty()),
  quote: Schema.optionalKey(MessageId),
})
export type MessageAction = typeof MessageAction.Type

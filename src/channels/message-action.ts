import { Schema } from "effect"
import { MessageId, ParticipantId } from "./message"
import { StickerId } from "../characters/character"
import type { ImageMimeType } from "../media/image"

export const TextSegment = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.NonEmptyString,
})

// 平台原生 @；user 必须在当前上下文参与者内。
export const MentionSegment = Schema.Struct({
  type: Schema.Literal("at"),
  user: ParticipantId,
})
export type MentionSegment = typeof MentionSegment.Type

export const OutboundSegment = Schema.Union([TextSegment, MentionSegment])
export type OutboundSegment = typeof OutboundSegment.Type

// 消息发送动作；不是已经发送的消息。
export const MessageAction = Schema.Struct({
  type: Schema.Literal("message"),
  parts: Schema.NonEmptyArray(OutboundSegment),
  quote: Schema.optionalKey(MessageId),
})
export type MessageAction = typeof MessageAction.Type

// 已解析出字节的角色表情包投递；由对话层组合，不经过 XML 或历史表。
export interface StickerDelivery {
  readonly type: "sticker"
  readonly stickerId: StickerId
  readonly summary: string
  readonly sha256: string
  readonly mimeType: ImageMimeType
  readonly byteLength: number
  readonly bytes: Uint8Array
  readonly quote?: MessageId
}

export type ChannelOutboundAction = MessageAction | StickerDelivery

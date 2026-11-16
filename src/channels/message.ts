import { Schema } from "effect"
import { ImageMimeType } from "../media/image"
import { StickerId } from "../characters/character"

export const ParticipantId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("ParticipantId"))
export type ParticipantId = typeof ParticipantId.Type
export const MessageId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("MessageId"))
export type MessageId = typeof MessageId.Type

export const Participant = Schema.Struct({
  id: ParticipantId,
  name: Schema.String.check(Schema.isNonEmpty()),
})
export type Participant = typeof Participant.Type

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.NonEmptyString,
})

// target 为参与者 ID；全体成员用 "all"。name 仅用于历史展示。
export const MentionPart = Schema.Struct({
  type: Schema.Literal("at"),
  target: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.NonEmptyString),
})

const imageKind = Schema.Literals(["image", "sticker"])

// 已保存到媒体目录的图片：内容寻址去重，消息本身只保留元数据。
export const StoredImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  kind: imageKind,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  mimeType: ImageMimeType,
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  // 角色自己发出的表情包保留 ID 与简介，后续轮次无需重新看图。
  stickerId: Schema.optionalKey(StickerId),
  summary: Schema.optionalKey(Schema.NonEmptyString),
})
export type StoredImagePart = typeof StoredImagePart.Type

// 图片未附带：下载失败、超出上限或格式不受支持；发言事实仍然保留。
export const UnavailableImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  kind: imageKind,
  unavailable: Schema.Literal(true),
})
export type UnavailableImagePart = typeof UnavailableImagePart.Type

export const ImagePart = Schema.Union([StoredImagePart, UnavailableImagePart])
export type ImagePart = typeof ImagePart.Type

export const MessagePart = Schema.Union([TextPart, MentionPart, ImagePart])
export type MessagePart = typeof MessagePart.Type

// time 是 Unix 毫秒时间戳；展示时由上下文构造器格式化。
export const Message = Schema.Struct({
  id: MessageId,
  sender: ParticipantId,
  time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  parts: Schema.NonEmptyArray(MessagePart),
  quote: Schema.optionalKey(MessageId),
})
export type Message = typeof Message.Type

// 历史表 text 列保存可读摘要，供控制台查看；模型上下文使用 parts。
export const messageText = (message: Message): string =>
  message.parts
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "at") return `@${part.name ?? part.target}`
      return part.kind === "sticker" ? "[表情包]" : "[图片]"
    })
    .join("")

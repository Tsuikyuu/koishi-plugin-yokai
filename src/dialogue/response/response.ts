import { Schema } from "effect"
import { RoutineAction } from "../../characters/routine"
import { MessageAction } from "../../channels/message-action"
import { MessageId } from "../../channels/message"
import { StickerId } from "../../characters/sticker"
import { NoteAction } from "../../notebook/note"
import { NextReplyAction } from "../next-reply/action"

export const ChannelStatePatch = Schema.Struct({
  emotion: Schema.optionalKey(Schema.String),
  condition: Schema.optionalKey(Schema.String),
  activity: Schema.optionalKey(Schema.String),
  short_memory: Schema.optionalKey(Schema.String),
})
export type ChannelStatePatch = typeof ChannelStatePatch.Type

// 发送角色表情包；与 message 并列，允许只发表情包不说话。
export const StickerAction = Schema.Struct({
  type: Schema.Literal("sticker"),
  stickerId: StickerId,
  quote: Schema.optionalKey(MessageId),
})
export type StickerAction = typeof StickerAction.Type

// 将本轮附带画面的图片收藏进角色表情包。
export const StickerSaveAction = Schema.Struct({
  type: Schema.Literal("sticker-save"),
  ref: Schema.NonEmptyString,
  stickerId: StickerId,
  summary: Schema.NonEmptyString,
})
export type StickerSaveAction = typeof StickerSaveAction.Type

// 更新角色已有表情包的画面与适用语境描述。
export const StickerUpdateAction = Schema.Struct({
  type: Schema.Literal("sticker-update"),
  stickerId: StickerId,
  summary: Schema.NonEmptyString,
})
export type StickerUpdateAction = typeof StickerUpdateAction.Type

// 从角色表情包中删除指定贴图。
export const StickerDeleteAction = Schema.Struct({
  type: Schema.Literal("sticker-delete"),
  stickerId: StickerId,
})
export type StickerDeleteAction = typeof StickerDeleteAction.Type

// 频道响应动作顺序就是执行顺序；短期唤醒独立于执行动作，在回合末尾注册。
export const ChannelResponse = Schema.Struct({
  think: Schema.String,
  actions: Schema.Array(
    Schema.Union([
      MessageAction,
      StickerAction,
      StickerSaveAction,
      StickerUpdateAction,
      StickerDeleteAction,
      NoteAction,
      RoutineAction,
    ]),
  ),
  status: ChannelStatePatch,
  nextReplies: Schema.Array(NextReplyAction),
})
export type ChannelResponse = typeof ChannelResponse.Type

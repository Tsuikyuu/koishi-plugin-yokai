import { Schema } from "effect"
import { RoutineAction } from "../../characters/routine"
import { MessageAction } from "../../channels/message-action"
import { MessageId } from "../../channels/message"
import { StickerId } from "../../characters/character"
import { NoteAction } from "../../notebook/note"
import { NextReplyAction } from "../next-reply/action"

export const ChannelStatePatch = Schema.Struct({
  emotion: Schema.optionalKey(Schema.String),
  condition: Schema.optionalKey(Schema.String),
  activity: Schema.optionalKey(Schema.String),
  short_memory: Schema.optionalKey(Schema.String),
})
export type ChannelStatePatch = typeof ChannelStatePatch.Type

// 发送角色预设中的表情包；与 message 并列，允许只说图不说话。
export const StickerAction = Schema.Struct({
  type: Schema.Literal("sticker"),
  stickerId: StickerId,
  quote: Schema.optionalKey(MessageId),
})
export type StickerAction = typeof StickerAction.Type

// 频道响应不再使用 status.memories；动作顺序就是执行顺序。
export const ChannelResponse = Schema.Struct({
  think: Schema.String,
  actions: Schema.Array(Schema.Union([MessageAction, StickerAction, NoteAction, RoutineAction, NextReplyAction])),
  status: ChannelStatePatch,
})
export type ChannelResponse = typeof ChannelResponse.Type

import { Schema } from "effect"
import { RoutineAction } from "../../characters/routine"
import { MessageAction } from "../../channels/message-action"
import { NoteAction } from "../../notebook/note"
import { NextReplyAction } from "../next-reply/action"

export const ChannelStatePatch = Schema.Struct({
  emotion: Schema.optionalKey(Schema.String),
  condition: Schema.optionalKey(Schema.String),
  activity: Schema.optionalKey(Schema.String),
  short_memory: Schema.optionalKey(Schema.String),
})
export type ChannelStatePatch = typeof ChannelStatePatch.Type

// 频道响应不再使用 status.memories；动作顺序就是执行顺序。
export const ChannelResponse = Schema.Struct({
  think: Schema.String,
  actions: Schema.Array(Schema.Union([MessageAction, NoteAction, RoutineAction, NextReplyAction])),
  status: ChannelStatePatch,
})
export type ChannelResponse = typeof ChannelResponse.Type

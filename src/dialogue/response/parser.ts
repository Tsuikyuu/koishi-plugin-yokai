import { Schema, type Effect } from "effect"
import type { ChannelResponse } from "./response"

export class ResponseParseError extends Schema.TaggedError<ResponseParseError>()("ResponseParseError", {
  reason: Schema.String,
}) {}

// 只校验 XML 与结构，不证明引用有效，也不执行动作或应用状态变化。
export type ChannelResponseParser = (xml: string) => Effect.Effect<ChannelResponse, ResponseParseError>

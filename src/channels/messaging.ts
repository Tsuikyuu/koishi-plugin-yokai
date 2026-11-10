import { Context, Data, type Effect } from "effect"
import type { ChannelKey } from "./channel"
import type { Message, MessageId, Participant } from "./message"
import type { MessageAction } from "./message-action"

export interface ChannelHistory {
  readonly bot: Participant
  readonly participants: ReadonlyArray<Participant>
  // 消息触发：排除触发消息。定时触发：取触发时间之前的历史，不伪造消息。
  readonly messages: ReadonlyArray<Message>
}
export type ChannelHistoryQuery =
  | { readonly beforeMessageId: MessageId; readonly limit: number }
  | { readonly beforeTime: number; readonly limit: number }

export class ChannelPlatformError extends Data.TaggedError("ChannelPlatformError")<{
  readonly operation: "history" | "send"
}> {}

export class ChannelPlatform extends Context.Service<
  ChannelPlatform,
  {
    readonly history: (
      key: ChannelKey,
      query: ChannelHistoryQuery,
    ) => Effect.Effect<ChannelHistory, ChannelPlatformError>
    // 成功返回表示平台确认发送；失败或中断仍可能已发送，不承诺 exactly-once。
    readonly send: (key: ChannelKey, action: MessageAction) => Effect.Effect<void, ChannelPlatformError>
  }
>()("yokai/channels/ChannelPlatform") {}

import { Context, Data, type Effect } from "effect"
import type { ChannelKey } from "./channel"
import type { Message, MessageId, Participant } from "./message"
import type { ChannelOutboundAction } from "./message-action"

export interface ChannelHistory {
  readonly bot: Participant
  readonly participants: ReadonlyArray<Participant>
  // 消息触发：排除触发消息。定时触发：取触发时间之前的历史，不伪造消息。
  readonly messages: ReadonlyArray<Message>
  // 私聊不提供 @ 提及。
  readonly direct: boolean
  // 触发消息存在引用时，标识被引用消息是否由当前机器人发出。
  readonly quotedBot?: boolean
}
export type ChannelHistoryQuery =
  | {
      readonly beforeMessageId: MessageId
      readonly incomingIds?: ReadonlyArray<MessageId>
      readonly limit: number
    }
  | { readonly beforeTime: number; readonly limit: number }

export class ChannelPlatformError extends Data.TaggedError("ChannelPlatformError")<{
  readonly operation: "history" | "send"
  // 脱敏后的失败分类（错误类型、系统错误码、HTTP 状态与供应商说明），只进入后台日志。
  readonly detail?: string
}> {
  override get message(): string {
    const label = this.operation === "send" ? "平台发送失败" : "平台读取历史失败"
    return this.detail ? `${label}：${this.detail}` : label
  }
}

export class ChannelPlatform extends Context.Service<
  ChannelPlatform,
  {
    readonly history: (
      key: ChannelKey,
      query: ChannelHistoryQuery,
    ) => Effect.Effect<ChannelHistory, ChannelPlatformError>
    // 成功返回表示平台确认发送；失败或中断仍可能已发送，不承诺 exactly-once。
    readonly send: (key: ChannelKey, action: ChannelOutboundAction) => Effect.Effect<void, ChannelPlatformError>
  }
>()("yokai/channels/ChannelPlatform") {}

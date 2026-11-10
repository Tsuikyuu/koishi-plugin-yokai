import { Schema, type Effect, type Layer } from "effect"
import type { Session } from "koishi"
import type { ChannelKey } from "./channel"
import type { Message } from "./message"
import type { ChannelPlatform } from "./messaging"

export class KoishiHistoryError extends Schema.TaggedError<KoishiHistoryError>()("KoishiHistoryError", {
  operation: Schema.Literals(["record", "session"]),
}) {}

export interface KoishiHistory {
  // 调用方只传入经过 Koishi 中间件的会话；重复事件和无文本消息返回 undefined。
  readonly recordIncoming: (
    session: Session,
  ) => Effect.Effect<{ readonly key: ChannelKey; readonly incoming: Message } | undefined, KoishiHistoryError>
  // 使用 Koishi 频道受理人（assignee）的在线机器人还原会话；不可发送时返回 undefined。
  readonly sessionFor: (key: ChannelKey) => Effect.Effect<Session | undefined, KoishiHistoryError>
  readonly channelPlatform: (session: Session) => Layer.Layer<ChannelPlatform>
}

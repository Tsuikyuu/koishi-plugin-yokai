import { Schema, type Effect, type Layer } from "effect"
import type { Context, Session } from "koishi"
import type { ChannelKey } from "./channel"
import type { Message, ParticipantId } from "./message"
import type { ChannelPlatform } from "./messaging"

export class KoishiHistoryError extends Schema.TaggedError<KoishiHistoryError>()("KoishiHistoryError", {
  operation: Schema.Literals(["record", "session", "sync"]),
}) {}

export interface RecordedIncoming {
  readonly key: ChannelKey
  readonly incoming: Message
  readonly botId: ParticipantId
  readonly direct: boolean
  readonly quotedBot: boolean
}

export interface KoishiHistory {
  // 调用方只传入经过 Koishi 中间件的会话；重复事件和无文本消息返回 undefined。
  readonly recordIncoming: (session: Session) => Effect.Effect<RecordedIncoming | undefined, KoishiHistoryError>
  // 使用 Koishi 频道受理人（assignee）的在线机器人还原会话；不可发送时返回 undefined。
  readonly sessionFor: (key: ChannelKey) => Effect.Effect<Session | undefined, KoishiHistoryError>
  // 机器人上线后补齐其受理的已绑定角色频道的近期历史，不触发模型回复。
  readonly syncBot: (bot: Context["bots"][number]) => Effect.Effect<void, KoishiHistoryError>
  // 机器人离线或移除时清理其已同步标记，使重连后能再次补齐离线期间的消息。
  readonly invalidateBot: (bot: Context["bots"][number]) => Effect.Effect<void>
  readonly channelPlatform: (session: Session) => Layer.Layer<ChannelPlatform>
}

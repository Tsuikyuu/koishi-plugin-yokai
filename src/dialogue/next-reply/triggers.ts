import { Context, type Effect } from "effect"
import type { ChannelKey } from "../../channels/channel"
import type { Message } from "../../channels/message"
import type { NextReplyAction } from "./action"

export interface ProactiveTrigger {
  readonly channel: ChannelKey
  readonly reason: string
  readonly time: number
}

// 短期唤醒状态只保存在运行时内存；进程重启后丢失。
export class ChannelTriggers extends Context.Service<
  ChannelTriggers,
  {
    readonly observeAndMatch: (channel: ChannelKey, message: Message, now: number) => Effect.Effect<string | undefined>
    readonly register: (
      channel: ChannelKey,
      actions: ReadonlyArray<NextReplyAction>,
      now: number,
    ) => Effect.Effect<void>
    readonly clear: (channel: ChannelKey) => Effect.Effect<void>
    readonly due: (now: number) => Effect.Effect<ReadonlyArray<ProactiveTrigger>>
  }
>()("yokai/dialogue/ChannelTriggers") {}

import { Context, type Effect } from "effect"
import type { ChannelKey } from "../../channels/channel"
import type { Message } from "../../channels/message"
import type { ProactiveTrigger } from "../next-reply/triggers"

export interface AmbientProbeConfig {
  readonly enabled: boolean
  readonly cooldownSeconds: number
}

export type AmbientObservation =
  | { readonly status: "disabled" }
  | { readonly status: "cooling"; readonly remainingSeconds: number }
  | { readonly status: "accumulating"; readonly heat: number }
  | { readonly status: "triggered"; readonly trigger: ProactiveTrigger; readonly cooldownSeconds: number }

export interface AmbientProbeResult {
  readonly silentStreak: number
  readonly cooldownSeconds: number
}

// 群聊潜水态热度与退避状态只保存在运行时内存；进程重启后重新累积。
export class AmbientTriggers extends Context.Service<
  AmbientTriggers,
  {
    readonly observe: (
      channel: ChannelKey,
      message: Message,
      now: number,
    ) => Effect.Effect<AmbientObservation>
    readonly onExplicitTurn: (channel: ChannelKey, now: number) => Effect.Effect<void>
    readonly onProbeCompleted: (channel: ChannelKey, spoke: boolean, now: number) => Effect.Effect<AmbientProbeResult>
  }
>()("yokai/dialogue/AmbientTriggers") {}

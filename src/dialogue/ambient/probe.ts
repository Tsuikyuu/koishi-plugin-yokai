import { Context, type Effect } from "effect"
import type { ChannelKey } from "../../channels/channel"
import type { Message } from "../../channels/message"
import type { ProactiveTrigger } from "../next-reply/triggers"

export interface AmbientProbeConfig {
  readonly enabled: boolean
  readonly cooldownSeconds: number
  readonly maxBackoffShift: number
  readonly halfLifeSeconds: number
  readonly activeWindowSeconds: number
  readonly idleResetSeconds: number
  readonly midpointHeat: number
  readonly steepness: number
  readonly maxProbability: number
  readonly soloDelta: number
  readonly duoDelta: number
  readonly crowdDelta: number
  readonly soloImageBonus: number
  readonly groupImageBonus: number
  readonly echoBonus: number
}

export const DefaultAmbientProbeConfig: AmbientProbeConfig = {
  enabled: true,
  cooldownSeconds: 180,
  maxBackoffShift: 3,
  halfLifeSeconds: 45,
  activeWindowSeconds: 120,
  idleResetSeconds: 900,
  midpointHeat: 1.8,
  steepness: 4,
  maxProbability: 0.65,
  soloDelta: 0.05,
  duoDelta: 0.24,
  crowdDelta: 0.34,
  soloImageBonus: 0.18,
  groupImageBonus: 0.32,
  echoBonus: 0.45,
}

export type AmbientObservation =
  | { readonly status: "disabled" }
  | { readonly status: "cooling"; readonly remainingSeconds: number }
  | { readonly status: "accumulating"; readonly heat: number; readonly probability: number }
  | {
      readonly status: "triggered"
      readonly trigger: ProactiveTrigger
      readonly heat: number
      readonly probability: number
      readonly cooldownSeconds: number
    }

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

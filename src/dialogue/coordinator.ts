import type { Effect } from "effect"
import type { ChannelKey } from "../channels/channel"
import type { Message } from "../channels/message"
import type { CharacterId } from "../characters/character"
import type { ScheduleTask } from "../scheduling/schedule"
import type { ProactiveTrigger } from "./next-reply/triggers"

export interface IncomingSubmission<Ctx> {
  readonly key: ChannelKey
  readonly presetId: CharacterId
  readonly context: Ctx
  readonly message: Message
  readonly triggered: boolean
  readonly reason?: string
  readonly now: number
}

export interface ReadyMessageBatch<Ctx> {
  readonly key: ChannelKey
  readonly presetId: CharacterId
  readonly context: Ctx
  readonly messages: readonly [Message, ...Message[]]
  readonly reason?: string
}

export interface ChannelTurnRunner<Ctx, ScheduleError = never> {
  readonly runMessage: (
    batch: ReadyMessageBatch<Ctx>,
    tryEnterCommit: Effect.Effect<boolean>,
  ) => Effect.Effect<void>
  readonly runProactive: (
    trigger: ProactiveTrigger,
    tryEnterCommit: Effect.Effect<boolean>,
  ) => Effect.Effect<void>
  readonly runAmbient: (
    trigger: ProactiveTrigger,
    tryEnterCommit: Effect.Effect<boolean>,
  ) => Effect.Effect<void>
  readonly runScheduled: (task: ScheduleTask) => Effect.Effect<void, ScheduleError>
}

export interface ChannelCoordinator<Ctx, ScheduleError = never> {
  readonly submitMessage: (input: IncomingSubmission<Ctx>) => Effect.Effect<void>
  readonly submitProactive: (trigger: ProactiveTrigger) => Effect.Effect<void>
  readonly submitAmbient: (trigger: ProactiveTrigger) => Effect.Effect<void>
  readonly submitScheduled: (key: ChannelKey, task: ScheduleTask) => Effect.Effect<void, ScheduleError>
}

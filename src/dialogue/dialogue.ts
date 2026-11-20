import { Context, Data, type Effect } from "effect"
import type { ChannelKey } from "../channels/channel"
import type { CharacterId } from "../characters/character"
import type { CharacterLoadError, CharacterNotFound } from "../characters/errors"
import type { CharacterRoutineError } from "../characters/routine"
import type { StickerConflict, StickerNotFound, StickerStoreError } from "../characters/sticker-store"
import type { InvalidReply } from "./invalid-reply"
import type { InvalidSchedule, ScheduleTask } from "../scheduling/schedule"
import type { Message } from "../channels/message"
import type { ModelError } from "../models/model"
import type { ChannelNotFound, ChannelStoreError } from "../channels/store"
import type { NotebookStoreError, NoteNotFound } from "../notebook/store"
import type { ChannelPlatformError } from "../channels/messaging"
import type { ProactiveTrigger } from "./next-reply/triggers"
import type { ResponseParseError } from "./response/parser"
import type { ScheduleStoreError, ScheduleNotFound } from "../scheduling/store"

export class ChannelExecutionError extends Data.TaggedError("ChannelExecutionError")<{
  readonly stage: "actions" | "state"
  // 已确认完成的动作数；失败的当前动作也可能已在外部发生。
  readonly completedActions: number
  readonly cause:
    | ChannelPlatformError
    | NotebookStoreError
    | NoteNotFound
    | StickerStoreError
    | StickerNotFound
    | StickerConflict
    | ChannelStoreError
    | ChannelNotFound
    | CharacterRoutineError
    | InvalidSchedule
}> {
  override get message(): string {
    return `回合提交失败（阶段=${this.stage}，已完成动作=${this.completedActions}，原因=${this.cause._tag}）`
  }
}

export type ChannelReplyError =
  | CharacterNotFound
  | CharacterRoutineError
  | CharacterLoadError
  | StickerStoreError
  | StickerNotFound
  | StickerConflict
  | ChannelStoreError
  | NotebookStoreError
  | NoteNotFound
  | ChannelPlatformError
  | ModelError
  | ResponseParseError
  | InvalidReply
  | ChannelExecutionError
  | ChannelNotFound
  | ScheduleStoreError
  | ScheduleNotFound
  | InvalidSchedule

export interface ChannelTurnResult {
  readonly actionsExecuted: number
  readonly spoke: boolean
}

export class ChannelRoleplay extends Context.Service<
  ChannelRoleplay,
  {
    readonly reply: (input: {
      readonly key: ChannelKey
      readonly presetId: CharacterId
      readonly incoming: Message | readonly [Message, ...Message[]]
      readonly observed?: { readonly reason?: string }
      readonly tryEnterCommit?: Effect.Effect<boolean>
    }) => Effect.Effect<ChannelTurnResult, ChannelReplyError>
    // 频道定时任务处理器：调用 Scheduler 认领并执行，旧快照或已暂停/删除任务不执行。
    readonly scheduled: (
      task: ScheduleTask,
    ) => Effect.Effect<
      ({ readonly runId: string } & ChannelTurnResult) | undefined,
      ChannelReplyError | ScheduleStoreError | InvalidSchedule
    >
    readonly proactive: (
      trigger: ProactiveTrigger,
      options?: { readonly tryEnterCommit?: Effect.Effect<boolean> },
    ) => Effect.Effect<ChannelTurnResult, ChannelReplyError>
    readonly ambient: (
      trigger: ProactiveTrigger,
      options?: { readonly tryEnterCommit?: Effect.Effect<boolean> },
    ) => Effect.Effect<ChannelTurnResult, ChannelReplyError>
  }
>()("yokai/dialogue/ChannelRoleplay") {}

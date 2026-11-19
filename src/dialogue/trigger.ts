import type { Message } from "../channels/message"
import type { ScheduleRun } from "../scheduling/schedule"

export interface GroupTriggerConfig {
  readonly at: boolean
  readonly quote: boolean
  readonly nameContains: boolean
  readonly namePrefix: boolean
}

export interface DebounceConfig {
  readonly debounceMs: number
  readonly maxDebounceMs: number
}

export type ChannelTrigger =
  | { readonly type: "message"; readonly messages: readonly [Message, ...Message[]]; readonly reason?: string }
  | { readonly type: "schedule"; readonly run: ScheduleRun; readonly text: string; readonly time: number }
  | { readonly type: "next-reply"; readonly reason: string; readonly time: number }
  | { readonly type: "ambient"; readonly reason: string; readonly time: number }

import type { Message } from "../channels/message"
import type { ScheduleRun } from "../scheduling/schedule"

export type ChannelTrigger =
  | { readonly type: "message"; readonly message: Message; readonly reason?: string }
  | { readonly type: "schedule"; readonly run: ScheduleRun; readonly text: string; readonly time: number }
  | { readonly type: "next-reply"; readonly reason: string; readonly time: number }

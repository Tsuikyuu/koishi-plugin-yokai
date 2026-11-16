import type { Channel } from "../../channels/channel"
import type { CharacterPreset } from "../../characters/preset"
import type { CharacterRoutine } from "../../characters/routine"
import type { ChannelTrigger } from "../trigger"
import type { ModelInput } from "../../models/model"
import type { Note } from "../../notebook/note"
import type { ChannelHistory } from "../../channels/messaging"
import type { ImageAttachment } from "./attachments"

export interface ChannelContextInput {
  readonly channel: Channel
  readonly preset: CharacterPreset
  readonly history: ChannelHistory
  readonly notes: ReadonlyArray<Note>
  readonly trigger: ChannelTrigger
  readonly timezone: string
  readonly now: number
  readonly routine: CharacterRoutine | undefined
  // 本轮实际随请求附带的图片；未附带的图片在消息中标记 attached="false"。
  readonly attachments: ReadonlyArray<ImageAttachment>
}
export type ChannelContextBuilder = (input: ChannelContextInput) => ModelInput

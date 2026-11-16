import type { Channel } from "../../channels/channel"
import type { CharacterPreset } from "../../characters/preset"
import type { CharacterRoutine } from "../../characters/routine"
import type { ChannelTrigger } from "../trigger"
import type { ModelInput } from "../../models/model"
import type { Note } from "../../notebook/note"
import type { ChannelHistory } from "../../channels/messaging"

export interface ChannelContextInput {
  readonly channel: Channel
  readonly preset: CharacterPreset
  readonly history: ChannelHistory
  readonly notes: ReadonlyArray<Note>
  readonly trigger: ChannelTrigger
  readonly timezone: string
  readonly now: number
  readonly routine: CharacterRoutine | undefined
}
export type ChannelContextBuilder = (input: ChannelContextInput) => ModelInput

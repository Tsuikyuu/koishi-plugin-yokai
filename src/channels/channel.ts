import { Schema } from "effect"
import { CharacterId } from "../characters/character"
import type { CharacterState } from "../characters/state"

// Koishi 频道表主键；由哪个机器人账号受理由 Koishi 的 assignee 决定。
export interface ChannelKey {
  readonly platform: string
  readonly channelId: string
}

// Koishi 的频道全局标识（session.cid），用于笔记、锁等按频道隔离的数据。
export const ChannelId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("ChannelId"))
export type ChannelId = typeof ChannelId.Type

export const channelIdOf = (key: ChannelKey): ChannelId => Schema.decodeSync(ChannelId)(`${key.platform}:${key.channelId}`)

export interface Channel extends ChannelKey {
  readonly id: ChannelId
  readonly presetId: typeof CharacterId.Type
  readonly state: CharacterState
}

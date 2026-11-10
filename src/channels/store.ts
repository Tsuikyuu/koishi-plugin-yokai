import { Context, Data, type Effect } from "effect"
import type { Channel, ChannelId, ChannelKey } from "./channel"
import type { CharacterState } from "../characters/state"
import type { CharacterId } from "../characters/character"

export class ChannelStoreError extends Data.TaggedError("ChannelStoreError")<{
  readonly operation: string
}> {}
// Koishi 频道记录不存在（例如关闭 autoAssign 后未建档），或频道尚未绑定角色。
export class ChannelNotFound extends Data.TaggedError("ChannelNotFound")<{
  readonly channelId: ChannelId
}> {}

export class ChannelStore extends Context.Service<
  ChannelStore,
  {
    // 未绑定角色的频道返回 undefined。
    readonly find: (key: ChannelKey) => Effect.Effect<Channel | undefined, ChannelStoreError>
    // 只写入已由 Koishi 建档的频道记录，不创建频道。
    readonly bind: (
      key: ChannelKey,
      presetId: CharacterId,
      state: CharacterState,
    ) => Effect.Effect<Channel, ChannelStoreError | ChannelNotFound>
    readonly listPresetIds: () => Effect.Effect<ReadonlyArray<CharacterId>, ChannelStoreError>
    readonly setState: (
      key: ChannelKey,
      state: CharacterState,
    ) => Effect.Effect<void, ChannelStoreError | ChannelNotFound>
  }
>()("yokai/channels/ChannelStore") {}

import type { Effect } from "effect"
import type { Channel, ChannelKey } from "./channel"
import type { CharacterId } from "../characters/character"
import type { CharacterLoadError, CharacterNotFound } from "../characters/errors"
import type { ChannelNotFound, ChannelStore, ChannelStoreError } from "./store"
import type { CharacterCatalog } from "../characters/catalog"

type ChannelSetupError = ChannelStoreError | ChannelNotFound | CharacterNotFound | CharacterLoadError

// 已绑定的频道使用原绑定；未绑定才使用 presetId。调用方串行执行同一频道的初始化。
export type InitializeChannel = (
  key: ChannelKey,
  presetId: CharacterId,
) => Effect.Effect<Channel, ChannelSetupError, ChannelStore | CharacterCatalog>

// 入口在开始接收事件或启动调度前执行，失败必须终止启动。
export type ValidateChannelPresets = Effect.Effect<void, ChannelSetupError, ChannelStore | CharacterCatalog>

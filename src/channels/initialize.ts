import { Effect } from "effect"
import { CharacterCatalog } from "../characters/catalog"
import { ChannelStore } from "./store"
import type { InitializeChannel, ValidateChannelPresets } from "./lifecycle"

export const validateChannelPresets: ValidateChannelPresets = Effect.gen(function* () {
  const channels = yield* ChannelStore
  const characters = yield* CharacterCatalog
  const ids = yield* channels.listPresetIds()
  yield* Effect.forEach(ids, (id) => characters.get(id), { discard: true })
})

export const initializeChannel: InitializeChannel = (key, presetId) =>
  Effect.gen(function* () {
    const channels = yield* ChannelStore
    const characters = yield* CharacterCatalog
    const existing = yield* channels.find(key)
    const preset = yield* characters.get(existing?.presetId ?? presetId)
    if (existing !== undefined) return existing
    const { emotion, condition, activity, short_memory } = preset.initialState
    return yield* channels.bind(key, presetId, { emotion, condition, activity, short_memory })
  })

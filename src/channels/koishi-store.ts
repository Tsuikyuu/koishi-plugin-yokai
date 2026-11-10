import { Effect, Layer, Schema, type Semaphore } from "effect"
import type { Context } from "koishi"
import { ChannelNotFound, ChannelStore, ChannelStoreError } from "./store"
import { channelIdOf, type Channel, type ChannelKey } from "./channel"
import { CharacterId } from "../characters/character"
import { CharacterState } from "../characters/state"
import type {} from "./table"

const Row = Schema.Struct({
  yokaiPreset: CharacterId,
  yokaiState: CharacterState,
})
const decode = Schema.decodeUnknownSync(Row)
const where = (key: ChannelKey) => ({ platform: key.platform, id: key.channelId })
const channel = (key: ChannelKey, data: unknown): Channel => {
  const row = decode(data)
  return {
    platform: key.platform,
    channelId: key.channelId,
    id: channelIdOf(key),
    presetId: row.yokaiPreset,
    state: row.yokaiState,
  }
}

export const channelStoreLayer = (database: Context["database"], serialize: Semaphore.Semaphore["withPermit"]) =>
  Layer.succeed(
    ChannelStore,
    ChannelStore.of({
      find: Effect.fn("KoishiChannelStore.find")(
        (key) =>
          Effect.tryPromise({
            try: async () => {
              const [row] = await database.get("channel", where(key), ["yokaiPreset", "yokaiState"])
              return row?.yokaiPreset ? channel(key, row) : undefined
            },
            catch: () => new ChannelStoreError({ operation: "find" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      bind: Effect.fn("KoishiChannelStore.bind")(
        (key, presetId, state) =>
          Effect.tryPromise({
            try: async () => {
              const result = await database.set("channel", where(key), { yokaiPreset: presetId, yokaiState: state })
              if (result.matched === 0) throw new ChannelNotFound({ channelId: channelIdOf(key) })
              return channel(key, { yokaiPreset: presetId, yokaiState: state })
            },
            catch: (error) => (error instanceof ChannelNotFound ? error : new ChannelStoreError({ operation: "bind" })),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      listPresetIds: Effect.fn("KoishiChannelStore.listPresetIds")(
        () =>
          Effect.tryPromise({
            try: async () => {
              const rows = await database.get("channel", { yokaiPreset: { $ne: "" } }, ["yokaiPreset"])
              return [...new Set(rows.map((row) => Schema.decodeUnknownSync(CharacterId)(row.yokaiPreset)))]
            },
            catch: () => new ChannelStoreError({ operation: "listPresetIds" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      setState: Effect.fn("KoishiChannelStore.setState")(
        (key, state) =>
          Effect.tryPromise({
            try: async () => {
              const result = await database.set("channel", where(key), { yokaiState: state })
              if (result.matched === 0) throw new ChannelNotFound({ channelId: channelIdOf(key) })
            },
            catch: (error) =>
              error instanceof ChannelNotFound ? error : new ChannelStoreError({ operation: "setState" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
    }),
  )

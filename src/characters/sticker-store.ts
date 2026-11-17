import { Context, Data, type Effect } from "effect"
import type { CharacterId } from "./character"
import type { Sticker, StickerAsset, StickerId, StickerInput } from "./sticker"

export class StickerStoreError extends Data.TaggedError("StickerStoreError")<{
  readonly operation: string
  readonly reason?: string
}> {}

export class StickerNotFound extends Data.TaggedError("StickerNotFound")<{
  readonly characterId: CharacterId
  readonly stickerId: StickerId
}> {}

export class StickerConflict extends Data.TaggedError("StickerConflict")<{
  readonly characterId: CharacterId
  readonly reason: string
}> {}

export class CharacterStickers extends Context.Service<
  CharacterStickers,
  {
    readonly list: (characterId: CharacterId) => Effect.Effect<ReadonlyArray<Sticker>, StickerStoreError>
    readonly load: (
      characterId: CharacterId,
      stickerId: StickerId,
    ) => Effect.Effect<StickerAsset, StickerStoreError | StickerNotFound>
    readonly save: (input: StickerInput) => Effect.Effect<Sticker, StickerStoreError | StickerConflict>
    readonly update: (
      characterId: CharacterId,
      stickerId: StickerId,
      summary: string,
    ) => Effect.Effect<Sticker, StickerStoreError | StickerNotFound>
    readonly remove: (
      characterId: CharacterId,
      stickerId: StickerId,
    ) => Effect.Effect<void, StickerStoreError | StickerNotFound>
  }
>()("yokai/characters/CharacterStickers") {}

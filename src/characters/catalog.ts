import { Context, type Effect } from "effect"
import type { CharacterPreset } from "./preset"
import type { CharacterId } from "./character"
import type { CharacterNotFound, CharacterLoadError } from "./errors"

export class CharacterCatalog extends Context.Service<
  CharacterCatalog,
  {
    readonly get: (id: CharacterId) => Effect.Effect<CharacterPreset, CharacterNotFound | CharacterLoadError>
  }
>()("yokai/characters/CharacterCatalog") {}

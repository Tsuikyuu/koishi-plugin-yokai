import { Context, type Effect } from "effect"
import type { CharacterId, StickerId } from "./character"
import type { CharacterLoadError } from "./errors"
import type { ImageMimeType } from "../media/image"

// 已解析的表情包文件；简介短语来自角色预设，由调用方按 id 组合。
export interface StickerFile {
  readonly id: StickerId
  readonly sha256: string
  readonly mimeType: ImageMimeType
  readonly bytes: Uint8Array
}

export class CharacterStickers extends Context.Service<
  CharacterStickers,
  {
    // 启动校验：每个声明的 ID 必须对应唯一、可读且格式有效的图片文件。
    readonly validate: (
      characterId: CharacterId,
      stickerIds: ReadonlyArray<StickerId>,
    ) => Effect.Effect<void, CharacterLoadError>
    readonly load: (characterId: CharacterId, stickerId: StickerId) => Effect.Effect<StickerFile, CharacterLoadError>
  }
>()("yokai/characters/CharacterStickers") {}

import { Schema } from "effect"
import type { CharacterId } from "./character"
import type { ImageMimeType } from "../media/image"

// 表情包 ID 用于在 XML 属性与列表中唯一标识单张贴图，禁止空白与控制字符。
export const StickerId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[^\s\p{C}]+$/u),
).pipe(Schema.brand("StickerId"))
export type StickerId = typeof StickerId.Type

// 单个角色可收藏的表情包数量上限，保证上下文可全量展示且无需额外检索轮次。
export const MaxCharacterStickers = 40

export interface Sticker {
  readonly id: StickerId
  readonly characterId: CharacterId
  readonly sha256: string
  readonly mimeType: ImageMimeType
  readonly byteLength: number
  readonly summary: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface StickerAsset extends Sticker {
  readonly bytes: Uint8Array
}

export interface StickerInput {
  readonly characterId: CharacterId
  readonly id: StickerId
  readonly summary: string
  readonly sha256: string
  readonly mimeType: ImageMimeType
  readonly bytes: Uint8Array
}

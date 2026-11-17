export interface StickerRecord {
  characterId: string
  id: string
  sha256: string
  mimeType: string
  byteLength: number
  summary: string
  createdAt: Date
  updatedAt: Date
}

declare module "koishi" {
  interface Tables {
    yokai_sticker: StickerRecord
  }
}

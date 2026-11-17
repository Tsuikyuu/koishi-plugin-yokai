import type { Context } from "koishi"
import type {} from "./sticker-tables"

export function registerStickerModels(ctx: Context): void {
  ctx.model.extend(
    "yokai_sticker",
    {
      characterId: "string",
      id: "string",
      sha256: "string",
      mimeType: "string",
      byteLength: "unsigned",
      summary: "text",
      createdAt: "timestamp",
      updatedAt: "timestamp",
    },
    {
      primary: ["characterId", "id"],
      unique: [["characterId", "sha256"]],
    },
  )
}

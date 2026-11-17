import type { Context } from "koishi"
import { registerChannelModel } from "../channels/register-table"
import { registerStickerModels } from "../characters/register-sticker-tables"
import { registerNotebookModels } from "../notebook/register-tables"
import { registerScheduleModels } from "../scheduling/register-tables"

export function registerModels(ctx: Context): void {
  registerChannelModel(ctx)
  registerStickerModels(ctx)
  registerNotebookModels(ctx)
  registerScheduleModels(ctx)
}

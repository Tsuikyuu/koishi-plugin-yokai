import type { Context } from "koishi"
import { registerChannelModel } from "../channels/register-table"
import { registerNotebookModels } from "../notebook/register-tables"
import { registerScheduleModels } from "../scheduling/register-tables"

export function registerModels(ctx: Context): void {
  registerChannelModel(ctx)
  registerNotebookModels(ctx)
  registerScheduleModels(ctx)
}

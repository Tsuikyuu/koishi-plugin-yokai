import type { Context } from "koishi"
import type {} from "./table"

export function registerChannelModel(ctx: Context): void {
  ctx.model.extend("channel", {
    yokaiPreset: "string",
    yokaiState: { type: "json", nullable: true, initial: null },
  })
}

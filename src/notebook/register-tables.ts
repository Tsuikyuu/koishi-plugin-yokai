import type { Context } from "koishi"
import type {} from "./tables"

export function registerNotebookModels(ctx: Context): void {
  ctx.model.extend(
    "yokai_note",
    {
      id: "string",
      channelId: "string",
      text: "text",
      searchText: "text",
      createdAt: "timestamp",
      updatedAt: "timestamp",
    },
    { primary: "id" },
  )
  ctx.model.extend(
    "yokai_note_relation",
    {
      channelId: "string",
      sourceId: "string",
      targetId: "string",
      kind: "string",
    },
    { primary: ["sourceId", "targetId"] },
  )
}

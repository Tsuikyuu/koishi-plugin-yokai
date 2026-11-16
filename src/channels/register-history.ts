import type { Context } from "koishi"
import type {} from "./history-table"

export const registerHistoryModel = (ctx: Context): void => {
  ctx.model.extend(
    "yokai_history",
    {
      id: "unsigned",
      platform: "string",
      channelId: "string",
      direct: "boolean",
      guildId: { type: "string", nullable: true },
      userId: "string",
      referrer: { type: "text", nullable: true },
      direction: "string",
      messageId: "string",
      senderId: "string",
      senderName: "string",
      time: "timestamp",
      text: "text",
      parts: { type: "json", nullable: true, initial: null },
      quote: { type: "string", nullable: true },
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["platform", "channelId", "messageId"]],
    },
  )
}

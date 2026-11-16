import type { Schema } from "effect"
import type {} from "koishi"

// 按 Koishi 频道主键（platform, channelId）归属；会话元数据用于还原定时发送的原生会话。
export interface HistoryRow {
  id: number
  platform: string
  channelId: string
  direct: boolean
  guildId: string | null
  userId: string
  referrer: string | null
  direction: "incoming" | "outgoing"
  messageId: string
  senderId: string
  senderName: string
  time: Date
  text: string
  // 结构化片段（文本、@ 与图片元数据）；旧记录为 null，按 text 回退。
  parts: Schema.Json | null
  quote: string | null
}

declare module "koishi" {
  interface Tables {
    yokai_history: HistoryRow
  }
}

import type { Message } from "../../channels/message"

// 上下文与引用校验共用同一窗口，不能引用只存在于完整历史中的消息。
export const recentHistory = (messages: ReadonlyArray<Message>) => messages.slice(-50)

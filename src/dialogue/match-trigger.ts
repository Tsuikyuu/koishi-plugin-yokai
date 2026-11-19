import type { Character } from "../characters/character"
import type { Message, ParticipantId } from "../channels/message"
import type { ChannelHistory } from "../channels/messaging"
import type { GroupTriggerConfig } from "./trigger"

export interface TriggerMatchTarget {
  readonly botId: ParticipantId
  readonly quotedBot: boolean
}

// 从频道历史推导触发判定所需的机器人身份与引用归属。
export const triggerTargetFromHistory = (message: Message, history: ChannelHistory): TriggerMatchTarget => ({
  botId: history.bot.id,
  quotedBot:
    message.quote !== undefined &&
    (history.quotedBot ?? history.messages.some((item) => item.id === message.quote && item.sender === history.bot.id)),
})

// 判断群聊入站消息是否命中任一已启用的触发门控。
export const matchesGroupTrigger = (
  config: GroupTriggerConfig,
  message: Message,
  target: TriggerMatchTarget,
  character: Character,
): boolean => {
  if (config.at && message.parts.some((part) => part.type === "at" && part.target === target.botId)) {
    return true
  }
  if (config.quote && message.quote !== undefined && target.quotedBot) {
    return true
  }
  if (!config.nameContains && !config.namePrefix) {
    return false
  }
  const names = [
    ...new Set([character.name, ...character.aliases].map((name) => name.trim()).filter((name) => name !== "")),
  ]
  if (names.length === 0) {
    return false
  }
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trimStart()
  if (text === "") {
    return false
  }
  if (config.nameContains && names.some((name) => text.includes(name))) {
    return true
  }
  if (config.namePrefix && names.some((name) => text.startsWith(name))) {
    return true
  }
  return false
}

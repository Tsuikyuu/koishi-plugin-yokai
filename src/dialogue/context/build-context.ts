import type { ChannelContextBuilder } from "./context"
import { element, escapeXml, localTime, messageXml } from "./xml"
import { characterContext } from "../../characters/prompt"
import { routineContext } from "./routine-context"
import { channelOutputProtocol } from "../response/protocol"

export const buildChannelContext: ChannelContextBuilder = ({
  channel,
  preset,
  history,
  notes,
  trigger,
  timezone,
  now,
  routine,
}) => {
  const state = channel.state
  const time = now
  const triggerXml =
    trigger.type === "message"
      ? `<trigger reason="${escapeXml(trigger.reason ?? "message")}" messageid="${escapeXml(trigger.message.id)}">${escapeXml(trigger.reason ?? "")}</trigger>`
      : trigger.type === "schedule"
        ? `<trigger reason="wake-up" scheduleid="${escapeXml(trigger.run.scheduleId)}" scheduled_at="${trigger.run.scheduledAt.getTime()}">${escapeXml(trigger.text)}</trigger>`
        : `<trigger reason="next-reply" time="${trigger.time}">${escapeXml(trigger.reason)}</trigger>`
  const user = [
    "# 当前环境",
    `<environment>${element("channel_id", channel.channelId)}${element("platform", channel.platform)}` +
      `${element("bot_id", history.bot.id)}<time>${time}</time>${element("timezone", timezone)}` +
      `${element("local_time", localTime(time, timezone))}${triggerXml}</environment>`,
    "# 参与者",
    `<participants>${history.participants
      .map((p) => `<participant id="${escapeXml(p.id)}" name="${escapeXml(p.name)}" />`)
      .join("")}</participants>`,
    "# 此前保存的角色状态",
    `<state>${element("emotion", state.emotion)}${element("condition", state.condition)}${element("activity", state.activity)}${element("short_memory", state.short_memory)}</state>`,
    routineContext(routine, now, timezone),
    "# 角色记事本（最近创建的部分笔记及关联）",
    `<notebook>${notes
      .map(
        (note) =>
          `<note id="${escapeXml(note.id)}" created_at="${note.createdAt.getTime()}">${element("text", note.text)}` +
          note.relations
            .map(
              (relation) =>
                `<relation kind="${relation.kind}" direction="${relation.direction}" noteid="${escapeXml(relation.note.id)}" created_at="${relation.note.createdAt.getTime()}">${escapeXml(relation.note.text)}</relation>`,
            )
            .join("") +
          `</note>`,
      )
      .join("\n")}</notebook>`,
    "# 平台历史",
    `<history>${history.messages.map(messageXml).join("\n")}</history>`,
    ...(trigger.type === "message"
      ? ["# 本次触发消息", `<incoming>${messageXml(trigger.message)}</incoming>`]
      : trigger.type === "schedule"
        ? ["# 本次定时触发", "你安排的事情到时间了，具体内容见 trigger。请结合当前情境决定是否发言。"]
        : ["# 本次短期唤醒", "你之前设置的短期条件已满足，具体内容见 trigger。请结合当前情境决定是否发言。"]),
    "# 提示",
    `- 消息最开头的“${preset.character.name}”（若存在）只是一个对你的称呼，并不与后面的词构成组合关系，如：“${preset.character.name}硬盘怎么扩容”实际上是在问“硬盘怎么扩容？”`,
    "- 并非每一条消息都需要回复",
    "  - 有时候引用你的消息的人只是在跟别人说话",
    "  - 当你因为各种原因延迟回复了上一轮中的消息（具体见消息发送时间和当前时间），又在本轮看到了别人在当时留下的催促，请忽视",
    "  - 当一条消息已经过去十分钟以上时，最好不回复，因为已经错过最佳时机",
    "- 有时候图片没能附加在你的上下文中，如undefined或[图片]，请忽视它们，如果有人问你，就说你看不到那些图，没人问的话请忽视",
    "- 若要使用与消息ID有关的功能，请仔细检查、确保你选择了正确的消息ID！",
    "- 请在输出前仔细思考：",
    "  1. 你需要哪些信息？你是否记得它们？如果不记得，仔细遍历**整个聊天记录**去找到它们",
    "  2. 你的输出是否符合**所有的要求、设定**？如果不符合，需要修正",
    "  完成后，才能输出正式的结果",
  ].join("\n")
  return {
    messages: [
      {
        role: "system",
        content: [
          `你必须扮演「${preset.character.name}」，依据下方角色设定，以该角色的身份、口吻和立场参与当前对话。结合角色状态、记事本和聊天情境决定如何回应或保持沉默，并遵守输出协议。`,
          "日程是你的生活背景，用于保持当前处境与行为连贯。你知道自己正在做什么，但无需向别人交代完整安排。需要调整作息时，可在 actions 中写 routine 动作修改日常时间表。",
          "state 是此前保存的状态，short_memory 是过往交流摘要，需要结合当前情境判断是否仍适用。current_activity 提供此刻的生活背景；没有时间依据时，不把旧活动和短期记忆当成刚刚发生的事。",
          "生活经历应符合角色设定，不依据旧记录中与角色设定冲突的内容继续编写经历。",
          "trigger reason 为 wake-up 或 next-reply 时，这是你主动发起的回合；不要伪造用户消息，结合当前情境决定是否发言。",
          "回应对方此刻表达的意思和情绪，只提及与话题有关的生活细节，不为了说明作息而补充起止时间、前后活动或解释整条时间线。",
          "按角色性格决定说多少，不必每次都把事情解释完整。",
          channelOutputProtocol,
          characterContext(preset),
        ].join("\n"),
      },
      { role: "user", content: user },
    ],
  }
}

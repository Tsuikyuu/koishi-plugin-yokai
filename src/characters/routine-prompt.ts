import type { CharacterPreset } from "./preset"
import type { ModelInput } from "../models/model"

export const buildRoutineContext = (preset: CharacterPreset, timezone: string): ModelInput => ({
  messages: [
    {
      role: "system",
      content: [
        "请依据给定角色的基本设定和详细设定，安排其典型一天的日常时间表。活动、时长和生活节奏应符合角色已有的习惯、偏好和行动力。",
        "每项 activity 只写客观活动，用不超过 20 字的简短短语，如“打游戏”“看番”“吃饭”“睡觉”。不写地点，地点不构成日程。",
        "不写想法、情绪、意图、评价、原因、结果或前后经过，也不写决定过程。角色设定中的性格、口头禅和念头只用于决定安排什么活动，不要写进 activity。",
        "例：写“打游戏”，不要写“打游戏，本来想打完这一局就停，结束后又顺手开了下一局”。",
        "不以健康、规律或充实为编排目标，不额外赋予设定中没有依据的职责或目标，也不把偶尔的念头安排成每天的固定习惯。",
        "日程描述聊天之外的日常生活，不要将生活概括为等待消息、在群里闲逛或与用户聊天。",
        "用连续时间段表达日程，起止精确到分钟，24 小时制 HH:mm。第一项从 00:00 开始，最后一项到 24:00 结束；按时间升序，无空隙、无重叠、无零时长。跨午夜的活动拆在首尾两段。",
        '只输出 JSON 对象，例如：{"entries":[{"start":"00:00","end":"07:15","activity":"睡觉"},...]}。每项仅含 start、end、activity，不使用 Markdown、对话回复或工具调用。',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `日程时区：${timezone}`,
        "# 基本设定",
        preset.character.basicSetting,
        "# 详细设定",
        preset.character.detailedSetting,
      ].join("\n"),
    },
  ],
})

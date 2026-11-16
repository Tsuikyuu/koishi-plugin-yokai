import type { CharacterPreset } from "./preset"

export const characterContext = (preset: CharacterPreset): string => {
  const character = preset.character
  return [
    "# 角色设定",
    `你的名字是${character.name}。`,
    ...(character.aliases.length === 0 ? [] : [`你也被称为：${character.aliases.join("、")}。`]),
    "## 基本设定",
    character.basicSetting,
    "## 详细设定",
    character.detailedSetting,
    "## 当前场景",
    character.scene,
    "## 说话风格",
    character.style,
    "## 行为指引",
    ...character.guidance.map((item) => `- ${item}`),
  ].join("\n")
}

// 只向模型提供 ID 与简介短语；文件路径与格式由程序维护。
export const stickerContext = (preset: CharacterPreset): string => {
  const stickers = preset.character.stickers ?? {}
  return [
    "## 可用表情包",
    "用 <sticker id=\"表情包ID\" /> 发送其中一张；ID 只能来自下列列表，一次动作一张。",
    ...Object.entries(stickers).map(([id, summary]) => `- ${id}：${summary}`),
  ].join("\n")
}

export const hasStickers = (preset: CharacterPreset): boolean =>
  Object.keys(preset.character.stickers ?? {}).length > 0

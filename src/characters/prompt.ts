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

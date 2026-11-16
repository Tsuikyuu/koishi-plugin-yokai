import { Schema } from "effect"

export const CharacterId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("CharacterId"))
export type CharacterId = typeof CharacterId.Type

// 表情包 ID 同时用作文件名主干：不能包含路径分隔符、空白或 Windows 保留字符。
export const StickerId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^(?!\.{1,2}$)[^\s/\\:*?"<>|]+$/u),
).pipe(Schema.brand("StickerId"))
export type StickerId = typeof StickerId.Type

// 角色预设只声明 ID 与简介短语；文件路径、扩展名和格式由程序维护。
export const CharacterStickers = Schema.Record(StickerId, Schema.String.check(Schema.isNonEmpty()))
export type CharacterStickers = typeof CharacterStickers.Type

export const Character = Schema.Struct({
  id: CharacterId,
  name: Schema.String.check(Schema.isNonEmpty()),
  aliases: Schema.Array(Schema.String),
  basicSetting: Schema.String,
  detailedSetting: Schema.String,
  scene: Schema.String,
  style: Schema.String,
  guidance: Schema.Array(Schema.String),
  stickers: Schema.optionalKey(CharacterStickers),
})
export type Character = typeof Character.Type

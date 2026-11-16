import { Schema } from "effect"
import { ImageMimeType } from "../media/image"

export const ModelToolCall = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  // 保留原始 JSON 参数，具体工具在应用边界解析。
  arguments: Schema.String,
})
export type ModelToolCall = typeof ModelToolCall.Type

export const ModelTool = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
})
export type ModelTool = typeof ModelTool.Type

// 工具循环中的不透明续接上下文，只由 adapter 解释；不进入平台历史或调用记录。
const Continuation = Schema.Redacted(Schema.Unknown)

export const ModelTextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.NonEmptyString,
})

// 图片以 data（Base64）随请求发送；sha256 用于去重与调用记录定位，不改变供应商请求。
export const ModelImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  sha256: Schema.NonEmptyString,
  mimeType: ImageMimeType,
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  data: Schema.Redacted(Schema.NonEmptyString),
})
export type ModelImagePart = typeof ModelImagePart.Type

export const ModelUserPart = Schema.Union([ModelTextPart, ModelImagePart])
export type ModelUserPart = typeof ModelUserPart.Type

// 纯文本调用保持字符串形式；附带图片时按顺序使用文本锚点与图片片段。
export const ModelUserContent = Schema.Union([
  Schema.String,
  Schema.Array(ModelUserPart).check(Schema.isMinLength(1)),
])
export type ModelUserContent = typeof ModelUserContent.Type

export const ModelMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.Literal("user"), content: ModelUserContent }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.String,
    continuation: Schema.optionalKey(Continuation),
    toolCalls: Schema.optionalKey(Schema.NonEmptyArray(ModelToolCall)),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), toolCallId: Schema.NonEmptyString, content: Schema.String }),
])
export type ModelMessage = typeof ModelMessage.Type

// 非流式、供应商无关；不暴露 SDK 类型。
export const ModelInput = Schema.Struct({
  messages: Schema.Array(ModelMessage),
  tools: Schema.optionalKey(Schema.NonEmptyArray(ModelTool)),
})
export type ModelInput = typeof ModelInput.Type

// 工具调用可无正文；最终回复必须非空。不包含供应商推理字段。
export const ModelOutput = Schema.Union([
  Schema.Struct({
    text: Schema.NonEmptyString,
    toolCalls: Schema.optionalKey(Schema.Never),
    continuation: Schema.optionalKey(Continuation),
  }),
  Schema.Struct({
    text: Schema.String,
    toolCalls: Schema.NonEmptyArray(ModelToolCall),
    continuation: Schema.optionalKey(Continuation),
  }),
])
export type ModelOutput = typeof ModelOutput.Type

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  kind: Schema.Literals([
    "Authentication",
    "RateLimit",
    "Http",
    "Transport",
    "Timeout",
    "InvalidResponse",
    "IncompleteResponse",
    "Recording",
  ]),
  status: Schema.optionalKey(Schema.Number),
}) {}

import { Schema } from "effect"

export const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.String,
      message: Schema.Struct({
        role: Schema.Literal("assistant"),
        content: Schema.NullOr(Schema.String),
        reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
        // 图片未通过供应商内容审核时返回拒答说明，正文会被剥离。
        refusal: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    }),
  ),
})

export const ToolCalls = Schema.NonEmptyArray(
  Schema.Struct({
    id: Schema.NonEmptyString,
    type: Schema.Literal("function"),
    function: Schema.Struct({ name: Schema.NonEmptyString, arguments: Schema.String }),
  }),
)

export const Continuation = Schema.Struct({
  api: Schema.Literal("chat-completions"),
  reasoning_content: Schema.String,
})

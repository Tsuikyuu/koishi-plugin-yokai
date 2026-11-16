import { Schema } from "effect"

export const FunctionCall = Schema.Struct({
  id: Schema.optionalKey(Schema.NonEmptyString),
  name: Schema.NonEmptyString,
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

const thought = {
  thought: Schema.optionalKey(Schema.Boolean),
  thoughtSignature: Schema.optionalKey(Schema.String),
}
const Part = Schema.Union([
  Schema.Struct({ text: Schema.String, ...thought }),
  Schema.Struct({ functionCall: FunctionCall, ...thought }),
])

export const ModelContent = Schema.Struct({
  role: Schema.optionalKey(Schema.Literal("model")),
  parts: Schema.NonEmptyArray(Part),
})
export const Continuation = Schema.Struct({
  api: Schema.Literal("gemini-generate-content"),
  content: ModelContent,
})
export const GenerateContentResponse = Schema.Struct({
  candidates: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        finishReason: Schema.optionalKey(Schema.String),
        content: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  ),
  promptFeedback: Schema.optionalKey(Schema.Struct({ blockReason: Schema.optionalKey(Schema.String) })),
})

export interface Content {
  readonly role: "user" | "model"
  readonly parts: ReadonlyArray<unknown>
}

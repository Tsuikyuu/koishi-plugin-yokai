import { Effect, Redacted, Schema } from "effect"
import { ModelError, type ModelInput } from "../model"
import { Continuation, type Content } from "./protocol"

const invalid = () => new ModelError({ kind: "InvalidResponse" })
const parseArguments = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

export const requestContents = Effect.fn("Gemini.requestContents")(function* (input: ModelInput) {
  let contents: ReadonlyArray<Content> = []
  let calls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly providerId?: string | undefined }> = []
  for (const [index, message] of input.messages.entries()) {
    if (message.role === "system") continue
    if (message.role === "assistant") {
      const content =
        message.continuation === undefined
          ? {
              parts: [
                ...(message.content === "" ? [] : [{ text: message.content }]),
                ...(yield* Effect.forEach(message.toolCalls ?? [], (call) =>
                  parseArguments(call.arguments).pipe(
                    Effect.map((args) => ({ functionCall: { id: call.id, name: call.name, args } })),
                    Effect.mapError(invalid),
                  ),
                )),
              ],
            }
          : (yield* Schema.decodeUnknownEffect(Continuation)(Redacted.value(message.continuation)).pipe(
              Effect.mapError(invalid),
            )).content
      const functions = content.parts.flatMap((part) =>
        "functionCall" in part && !("thought" in part && part.thought) ? [part.functionCall] : [],
      )
      calls = (message.toolCalls ?? []).map((call, index) => ({
        id: call.id,
        name: call.name,
        providerId: functions[index]?.id,
      }))
      // 保留每个原始 part 及其 thoughtSignature，不重新拼接模型正文。
      contents = [...contents, { role: "model", parts: content.parts }]
      continue
    }
    if (message.role === "tool") {
      const call = calls.find((call) => call.id === message.toolCallId)
      if (!call) return yield* Effect.fail(invalid())
      const part = {
        functionResponse: {
          name: call.name,
          ...(call.providerId === undefined ? {} : { id: call.providerId }),
          response: { output: message.content },
        },
      }
      // 并行调用的结果必须处于同一个 user turn，且与原调用逐一对应。
      const previous = contents[contents.length - 1]
      contents =
        input.messages[index - 1]?.role === "tool" && previous !== undefined
          ? [...contents.slice(0, -1), { role: "user", parts: [...previous.parts, part] }]
          : [...contents, { role: "user", parts: [part] }]
      continue
    }
    contents = [...contents, { role: "user", parts: [{ text: message.content }] }]
  }
  return contents
})

import { Effect, Redacted, Schema } from "effect"
import { ModelError, type ModelInput } from "../model"
import { Continuation } from "./protocol"

export const requestMessages = Effect.fn("ChatCompletions.requestMessages")(function* (input: ModelInput) {
  return yield* Effect.forEach(input.messages, (message) => Effect.gen(function* () {
    if (message.role === "tool")
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content }
    if (message.role !== "assistant") return { role: message.role, content: message.content }
    const state = message.continuation === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Continuation)(Redacted.value(message.continuation)).pipe(
          Effect.mapError(() => new ModelError({ kind: "InvalidResponse" })),
        )
    return {
      role: "assistant",
      content: message.content,
      ...(state === undefined ? {} : { reasoning_content: state.reasoning_content }),
      ...(message.toolCalls === undefined ? {} : {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      }),
    }
  }))
})

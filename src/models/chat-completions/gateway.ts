import { Array as Arr, Effect, Layer, Schema } from "effect"
import { ModelGateway } from "../gateway"
import { ModelError } from "../model"
import type { ReasoningEffort } from "../openai/config"
import type { ChatCompletionsConfig } from "./config"
import { ModelHttp } from "../http/client"

const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.String,
      message: Schema.Struct({
        role: Schema.Literal("assistant"),
        content: Schema.NullOr(Schema.String),
        tool_calls: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    }),
  ),
})

const ToolCalls = Schema.NonEmptyArray(
  Schema.Struct({
    id: Schema.NonEmptyString,
    type: Schema.Literal("function"),
    function: Schema.Struct({ name: Schema.NonEmptyString, arguments: Schema.String }),
  }),
)

export const ModelGatewayChatCompletions = (
  config: ChatCompletionsConfig & { readonly baseUrl: string; readonly reasoningEffort?: ReasoningEffort },
) =>
  Layer.effect(
    ModelGateway,
    Effect.gen(function* () {
      const http = yield* ModelHttp
      return ModelGateway.of({
        generate: Effect.fn("ModelGatewayChatCompletions.generate")(
          function* (input) {
            const raw = yield* http.postJson({
              url: `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
              apiKey: config.apiKey,
              body: {
                model: config.model,
                stream: false,
                ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
                ...(config.topP === undefined ? {} : { top_p: config.topP }),
                ...(config.reasoningEffort === undefined ? {} : { reasoning_effort: config.reasoningEffort }),
                messages: input.messages.map((message) => {
                  if (message.role === "tool")
                    return { role: "tool", tool_call_id: message.toolCallId, content: message.content }
                  if (message.role === "assistant" && message.toolCalls !== undefined)
                    return {
                      role: "assistant",
                      content: message.content,
                      tool_calls: message.toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.arguments },
                      })),
                    }
                  return { role: message.role, content: message.content }
                }),
                ...(input.tools === undefined
                  ? {}
                  : { tools: input.tools.map((tool) => ({ type: "function", function: tool })) }),
              },
            })
            const completion = yield* Schema.decodeUnknownEffect(Completion)(raw).pipe(
              Effect.mapError(() => new ModelError({ kind: "InvalidResponse" })),
            )
            const choice = completion.choices[0]
            if (completion.choices.length !== 1 || choice === undefined)
              return yield* Effect.fail(new ModelError({ kind: "InvalidResponse" }))
            if (choice.finish_reason === "tool_calls" && input.tools !== undefined) {
              const calls = yield* Schema.decodeUnknownEffect(ToolCalls)(choice.message.tool_calls).pipe(
                Effect.mapError(() => new ModelError({ kind: "InvalidResponse" })),
              )
              const tools = input.tools
              if (
                new Set(calls.map((call) => call.id)).size !== calls.length ||
                calls.some((call) => !tools.some((tool) => tool.name === call.function.name))
              ) {
                return yield* Effect.fail(new ModelError({ kind: "InvalidResponse" }))
              }
              return {
                text: choice.message.content ?? "",
                toolCalls: Arr.map(calls, (call) => ({
                  id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                })),
              }
            }
            if (choice.finish_reason !== "stop" || (choice.message.tool_calls?.length ?? 0) !== 0) {
              return yield* Effect.fail(new ModelError({ kind: "IncompleteResponse" }))
            }
            const text = choice.message.content
            if (text === null || text.trim() === "")
              return yield* Effect.fail(new ModelError({ kind: "InvalidResponse" }))
            // reasoning_content、用量及其他供应商字段不会进入业务输出或日志。
            return { text }
          },
          (effect) =>
            effect.pipe(
              Effect.timeout(config.timeoutMs),
              Effect.catchTag("TimeoutError", () => Effect.fail(new ModelError({ kind: "Timeout" }))),
            ),
        ),
      })
    }),
  )

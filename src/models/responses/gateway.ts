import { Array as Arr, Effect, Layer, Redacted, Schema } from "effect"
import { ModelGateway } from "../gateway"
import { ModelError, type ModelInput } from "../model"
import type { OpenAIConfig } from "../openai/config"
import { ModelHttp } from "../http/client"

const Output = Schema.Array(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("message"),
      role: Schema.Literal("assistant"),
      status: Schema.String,
      id: Schema.optionalKey(Schema.NonEmptyString),
      phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
      content: Schema.Array(
        Schema.Union([
          Schema.Struct({
            type: Schema.Literal("output_text"),
            text: Schema.String,
            annotations: Schema.optionalKey(Schema.Array(Schema.Unknown)),
          }),
          Schema.Struct({ type: Schema.Literal("refusal"), refusal: Schema.String }),
        ]),
      ),
    }),
    Schema.Struct({
      type: Schema.Literal("function_call"),
      call_id: Schema.NonEmptyString,
      id: Schema.optionalKey(Schema.NonEmptyString),
      name: Schema.NonEmptyString,
      arguments: Schema.String,
      status: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("reasoning"),
      id: Schema.NonEmptyString,
      summary: Schema.Array(Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String })),
      encrypted_content: Schema.NonEmptyString,
    }),
  ]),
)
const ResponseBody = Schema.Struct({ status: Schema.String, output: Schema.Array(Schema.Unknown) })
const Continuation = Schema.Struct({ api: Schema.Literal("openai-responses"), output: Output })
const invalid = () => new ModelError({ kind: "InvalidResponse" })
const incomplete = () => new ModelError({ kind: "IncompleteResponse" })

const requestInput = (input: ModelInput) =>
  Effect.forEach(input.messages, (message): Effect.Effect<ReadonlyArray<unknown>, ModelError> => {
    if (message.role === "tool")
      return Effect.succeed([{ type: "function_call_output", call_id: message.toolCallId, output: message.content }])
    if (message.role === "assistant") {
      if (message.continuation !== undefined)
        return Schema.decodeUnknownEffect(Continuation)(Redacted.value(message.continuation)).pipe(
          Effect.map((state) => state.output),
          Effect.mapError(invalid),
        )
      return Effect.succeed([
        ...(message.content === "" ? [] : [{ role: "assistant", content: message.content }]),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      ])
    }
    return Effect.succeed([{ role: message.role, content: message.content }])
  }).pipe(Effect.map((items) => items.flat()))

export const ModelGatewayResponses = (config: OpenAIConfig & { readonly baseUrl: string }) =>
  Layer.effect(
    ModelGateway,
    Effect.gen(function* () {
      const http = yield* ModelHttp
      return ModelGateway.of({
        generate: Effect.fn("ModelGatewayResponses.generate")(
          function* (input) {
            const items = yield* requestInput(input)
            const reasoning = {
              ...(config.reasoningEffort === undefined ? {} : { effort: config.reasoningEffort }),
              ...(config.reasoningMode === undefined ? {} : { mode: config.reasoningMode }),
              ...(config.reasoningContext === undefined ? {} : { context: config.reasoningContext }),
            }
            const raw = yield* http.postJson({
              url: `${config.baseUrl.replace(/\/+$/, "")}/responses`,
              apiKey: config.apiKey,
              body: {
                model: config.model,
                stream: false,
                store: false,
                ...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
                ...(config.maxOutputTokens === undefined ? {} : { max_output_tokens: config.maxOutputTokens }),
                ...(config.verbosity === undefined ? {} : { text: { verbosity: config.verbosity } }),
                input: items,
                // 无服务端会话；工具循环显式携带加密推理上下文。
                include: ["reasoning.encrypted_content"],
                ...(input.tools === undefined
                  ? {}
                  : { tools: input.tools.map((tool) => ({ type: "function", ...tool, strict: false })) }),
              },
            })
            const response = yield* Schema.decodeUnknownEffect(ResponseBody)(raw).pipe(Effect.mapError(invalid))
            if (response.status !== "completed") return yield* Effect.fail(incomplete())
            const output = yield* Schema.decodeUnknownEffect(Output)(response.output).pipe(Effect.mapError(invalid))
            const messages = output.filter((item) => item.type === "message")
            const calls = output.filter((item) => item.type === "function_call")
            if (
              messages.some(
                (message) => message.status !== "completed" || message.content.some((part) => part.type === "refusal"),
              ) ||
              calls.some((call) => call.status !== undefined && call.status !== "completed")
            ) {
              return yield* Effect.fail(incomplete())
            }
            const text = messages
              .flatMap((message) => message.content.flatMap((part) => (part.type === "output_text" ? [part.text] : [])))
              .join("")
            if (Arr.isArrayNonEmpty(calls)) {
              if (input.tools === undefined) return yield* Effect.fail(incomplete())
              const tools = input.tools
              if (
                new Set(calls.map((call) => call.call_id)).size !== calls.length ||
                calls.some((call) => !tools.some((tool) => tool.name === call.name))
              )
                return yield* Effect.fail(invalid())
              return {
                text,
                toolCalls: Arr.map(calls, (call) => ({ id: call.call_id, name: call.name, arguments: call.arguments })),
                continuation: Redacted.make({ api: "openai-responses", output }),
              }
            }
            if (text.trim() === "") return yield* Effect.fail(invalid())
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

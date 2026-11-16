import { Array as Arr, Effect, Layer, Redacted, Schema } from "effect"
import { ModelGateway, type ModelCapabilities } from "../gateway"
import { ModelError } from "../model"
import type { ReasoningEffort } from "../deepseek/config"
import type { ChatCompletionsConfig } from "./config"
import { ModelHttp } from "../http/client"
import { requestMessages } from "./messages"
import { Completion, ToolCalls } from "./protocol"

export const ModelGatewayChatCompletions = (
  config: ChatCompletionsConfig & { readonly baseUrl: string; readonly reasoningEffort?: ReasoningEffort },
  // DeepSeek Flash 原生支持图片；具体模型由调用方按模型目录声明覆盖。
  capabilities: ModelCapabilities = { imageInput: true },
) =>
  Layer.effect(
    ModelGateway,
    Effect.gen(function* () {
      const http = yield* ModelHttp
      return ModelGateway.of({
        capabilities,
        generate: Effect.fn("ModelGatewayChatCompletions.generate")(
          function* (input) {
            const messages = yield* requestMessages(input)
            const raw = yield* http.postJson({
              url: `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
              apiKey: config.apiKey,
              body: {
                model: config.model,
                stream: false,
                ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
                ...(config.topP === undefined ? {} : { top_p: config.topP }),
                ...(config.reasoningEffort === undefined ? {} : { reasoning_effort: config.reasoningEffort }),
                ...(config.maxOutputTokens === undefined ? {} : { max_tokens: config.maxOutputTokens }),
                ...(config.stopSequences?.length ? { stop: config.stopSequences } : {}),
                messages,
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
            // 思考模式带工具时须续接原始推理；仅保存在不透明字段中，不进入角色正文或调用记录。
            const continuation =
              input.tools === undefined || choice.message.reasoning_content == null
                ? {}
                : {
                    continuation: Redacted.make({
                      api: "chat-completions",
                      reasoning_content: choice.message.reasoning_content,
                    }),
                  }
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
                ...continuation,
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
            // 图片未通过内容审核时正文被剥离，按未完成响应处理，不把拒答说明当角色发言。
            if (choice.message.refusal != null && choice.message.refusal !== "") {
              return yield* Effect.fail(new ModelError({ kind: "IncompleteResponse" }))
            }
            const text = choice.message.content
            if (text === null || text.trim() === "")
              return yield* Effect.fail(new ModelError({ kind: "InvalidResponse" }))
            return { text, ...continuation }
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

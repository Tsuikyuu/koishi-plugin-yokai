import { Array as Arr, Effect, Layer, Redacted, Schema } from "effect"
import { ModelGateway } from "../gateway"
import { ModelHttp } from "../http/client"
import { ModelError } from "../model"
import { DefaultBaseUrl } from "../provider"
import type { GeminiConfig } from "./config"
import { requestContents } from "./messages"
import { GenerateContentResponse, ModelContent } from "./protocol"

const invalid = () => new ModelError({ kind: "InvalidResponse" })
const incomplete = () => new ModelError({ kind: "IncompleteResponse" })

export const ModelGatewayGemini = (config: GeminiConfig) =>
  Layer.effect(
    ModelGateway,
    Effect.gen(function* () {
      const http = yield* ModelHttp
      const baseUrl = (config.baseUrl ?? DefaultBaseUrl.gemini).replace(/\/+$/, "")
      const model = config.model.replace(/^models\//, "")
      return ModelGateway.of({
        generate: Effect.fn("ModelGatewayGemini.generate")(
          function* (input) {
            const contents = yield* requestContents(input)
            const instructions = input.messages
              .filter((message) => message.role === "system")
              .map((message) => ({ text: message.content }))
            const raw = yield* http.postJson({
              url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
              apiKey: config.apiKey,
              auth: "x-goog-api-key",
              body: {
                contents,
                ...(instructions.length === 0 ? {} : { systemInstruction: { parts: instructions } }),
                generationConfig: {
                  ...(config.thinkingLevel === undefined
                    ? {}
                    : { thinkingConfig: { thinkingLevel: config.thinkingLevel.toUpperCase() } }),
                  ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
                  ...(config.stopSequences?.length ? { stopSequences: config.stopSequences } : {}),
                  ...(config.seed === undefined ? {} : { seed: config.seed }),
                  ...(config.presencePenalty === undefined ? {} : { presencePenalty: config.presencePenalty }),
                  ...(config.frequencyPenalty === undefined ? {} : { frequencyPenalty: config.frequencyPenalty }),
                },
                ...(config.safetySettings?.length ? { safetySettings: config.safetySettings } : {}),
                ...(input.tools === undefined
                  ? {}
                  : {
                      tools: [{
                        functionDeclarations: input.tools.map((tool) => ({
                          name: tool.name,
                          description: tool.description,
                          parametersJsonSchema: tool.parameters,
                        })),
                      }],
                    }),
              },
            })
            const response = yield* Schema.decodeUnknownEffect(GenerateContentResponse)(raw).pipe(Effect.mapError(invalid))
            const blocked = response.promptFeedback?.blockReason
            if (blocked !== undefined && blocked !== "BLOCK_REASON_UNSPECIFIED")
              return yield* Effect.fail(incomplete())
            const candidate = response.candidates?.[0]
            if (response.candidates?.length !== 1 || candidate === undefined)
              return yield* Effect.fail(invalid())
            if (candidate.finishReason !== "STOP") return yield* Effect.fail(incomplete())
            const content = yield* Schema.decodeUnknownEffect(ModelContent)(candidate.content).pipe(Effect.mapError(invalid))
            const visible = content.parts.filter((part) => part.thought !== true)
            const text = visible.flatMap((part) => ("text" in part ? [part.text] : [])).join("")
            const calls = visible.flatMap((part) => ("functionCall" in part ? [part.functionCall] : []))
            if (Arr.isArrayNonEmpty(calls)) {
              if (input.tools === undefined) return yield* Effect.fail(incomplete())
              const tools = input.tools
              const toolCalls = Arr.map(calls, (call, index) => ({
                // Gemini 可省略调用 ID；本地 ID 只供工具循环关联结果，不回传给供应商。
                id: call.id ?? `gemini-${input.messages.length}-${index}`,
                name: call.name,
                arguments: JSON.stringify(call.args ?? {}),
              }))
              if (
                new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length ||
                toolCalls.some((call) => !tools.some((tool) => tool.name === call.name))
              ) return yield* Effect.fail(invalid())
              return {
                text,
                toolCalls,
                continuation: Redacted.make({ api: "gemini-generate-content", content }),
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

import { Effect, Schema } from "effect"
import { InvalidReply } from "./invalid-reply"
import { type Channel } from "../channels/channel"
import { type ModelInput } from "../models/model"
import { type NoteId } from "../notebook/note"
import { NotebookQueryArguments, notebookQueryTool } from "./tools/notebook-query"
import { ModelGateway } from "../models/gateway"
import { NotebookStore } from "../notebook/store"
import { WakeUpToolArguments, wakeUpTool } from "./tools/wake-up"
import { executeWakeUpTool } from "./tools/execute-wake-up"

const parseArguments = Schema.decodeUnknownEffect(Schema.fromJsonString(NotebookQueryArguments), {
  onExcessProperty: "error",
})

const parseWakeUp = Schema.decodeUnknownEffect(Schema.fromJsonString(WakeUpToolArguments), {
  onExcessProperty: "error",
})

// 工具按调用顺序执行；wake-up 写入立即生效，混合 XML 正文仍只是草稿。
export const generateChannelResponse = Effect.fn("generateChannelResponse")(function* (
  channel: Channel,
  context: ModelInput,
  initialNoteIds: ReadonlyArray<NoteId>,
  timezone: string,
) {
  const model = yield* ModelGateway
  const notebook = yield* NotebookStore
  let input: ModelInput = { ...context, tools: [notebookQueryTool, wakeUpTool] }
  let noteIds = initialNoteIds
  for (let round = 0; ; round++) {
    yield* Effect.logDebug(`第 ${round + 1} 轮模型调用，输入消息 ${input.messages.length} 条`)
    const output = yield* model.generate(input)
    if (output.toolCalls === undefined) {
      yield* Effect.logDebug(`第 ${round + 1} 轮模型返回最终回复，${output.text.length} 字符`)
      return { text: output.text, noteIds }
    }
    yield* Effect.logDebug(
      `第 ${round + 1} 轮模型请求工具：${output.toolCalls.map((call) => `${call.name}(${call.arguments})`).join("; ")}`,
    )
    if (round === 8) return yield* Effect.fail(new InvalidReply({ reason: "工具调用超过 8 轮" }))
    const calls = yield* Effect.forEach(output.toolCalls, (call) =>
      Effect.gen(function* () {
        if (call.name === "wake-up") {
          const args = yield* parseWakeUp(call.arguments).pipe(
            Effect.mapError(() => new InvalidReply({ reason: "wake-up 工具参数无效" })),
          )
          return { type: "wake-up" as const, call, args }
        }
        if (call.name !== "notebook-query") return yield* Effect.fail(new InvalidReply({ reason: "未知工具" }))
        const args = yield* parseArguments(call.arguments).pipe(
          Effect.mapError(() => new InvalidReply({ reason: "记事本查询参数无效" })),
        )
        return { type: "notebook" as const, call, queries: args.queries }
      }),
    )
    const results = yield* Effect.forEach(calls, (item) =>
      Effect.gen(function* () {
        if (item.type === "wake-up")
          return { content: JSON.stringify(yield* executeWakeUpTool(channel, timezone, item.args)), noteIds: [] }
        const pages = yield* Effect.forEach(item.queries, (query) => notebook.query(channel.id, query), {
          concurrency: "unbounded",
        })
        return {
          content: JSON.stringify({ results: pages }),
          noteIds: pages.flatMap((page) =>
            page.notes.flatMap((note) => [note.id, ...note.relations.map((relation) => relation.note.id)]),
          ),
        }
      }),
    )
    yield* Effect.logDebug(
      `工具执行完成：${calls.map(({ call }, index) => `${call.name} -> ${results[index]!.content}`).join("; ")}`,
    )
    noteIds = [...noteIds, ...results.flatMap((result) => result.noteIds)]
    input = {
      ...input,
      messages: [
        ...input.messages,
        {
          role: "assistant",
          content: output.text,
          toolCalls: output.toolCalls,
          ...(output.continuation === undefined ? {} : { continuation: output.continuation }),
        },
        ...calls.map(({ call }, index) => ({
          role: "tool" as const,
          toolCallId: call.id,
          content: results[index]!.content,
        })),
      ],
    }
  }
})

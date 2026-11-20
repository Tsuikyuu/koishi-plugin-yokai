import { Cause, Effect, Exit, Option, Schema } from "effect"
import { InvalidReply } from "./invalid-reply"
import { type Channel } from "../channels/channel"
import { type ModelInput, type ModelMessage, type ModelToolCall } from "../models/model"
import { type NoteId } from "../notebook/note"
import { NotebookQueryArguments, notebookQueryTool } from "./tools/notebook-query"
import { ModelGateway } from "../models/gateway"
import { NotebookStore } from "../notebook/store"
import { WakeUpToolArguments, wakeUpTool } from "./tools/wake-up"
import { executeWakeUpTool } from "./tools/execute-wake-up"
import { escapeXml } from "./context/xml"
import { parseChannelResponse } from "./response/parse-xml"

export const MaxParseRewriteRetries = 2

const parseArguments = Schema.decodeUnknownEffect(Schema.fromJsonString(NotebookQueryArguments), {
  onExcessProperty: "error",
})

const parseWakeUp = Schema.decodeUnknownEffect(Schema.fromJsonString(WakeUpToolArguments), {
  onExcessProperty: "error",
})

type ParsedToolCall =
  | { readonly type: "wake-up"; readonly call: ModelToolCall; readonly args: typeof WakeUpToolArguments.Type }
  | {
      readonly type: "notebook"
      readonly call: ModelToolCall
      readonly queries: (typeof NotebookQueryArguments.Type)["queries"]
    }

const formatParseReceipt = (reason: string): string =>
  [
    `<protocol-receipt status="rejected">`,
    `系统协议回执（非聊天参与者消息）：你上一次输出的回复未能通过 XML 响应协议解析（${escapeXml(reason)}），尚未发送任何消息或执行任何动作。`,
    `请保留原本的角色想法与动作内容，修正 XML 格式问题后，直接重新输出完整的 <response>...</response> XML（不要在角色发言中提及本次回执，不要输出 XML 外的任何正文或 Markdown 围栏）。`,
    `</protocol-receipt>`,
  ].join("\n")

// 工具按调用顺序执行；最终无工具回复若 XML 解析出错，附带协议回执打回重写（最多重试 2 次）。
export const generateChannelResponse = Effect.fn("generateChannelResponse")(function* (
  channel: Channel,
  context: ModelInput,
  initialNoteIds: ReadonlyArray<NoteId>,
  timezone: string,
  tryEnterCommit?: Effect.Effect<boolean>,
) {
  const model = yield* ModelGateway
  const notebook = yield* NotebookStore
  let input: ModelInput = { ...context, tools: [notebookQueryTool, wakeUpTool] }
  let noteIds = initialNoteIds
  let toolRounds = 0
  let parseRetries = 0

  while (true) {
    const output = yield* model.generate(input)
    if (output.toolCalls === undefined) {
      const parsed = yield* Effect.exit(parseChannelResponse(output.text))
      if (Exit.isSuccess(parsed)) {
        return { text: output.text, response: parsed.value, noteIds }
      }
      const failure = Cause.findErrorOption(parsed.cause)
      if (Option.isNone(failure) || parseRetries >= MaxParseRewriteRetries) {
        yield* Effect.logDebug(`模型最终输出：\n${output.text}`)
        return yield* Effect.failCause(parsed.cause)
      }
      parseRetries += 1
      const error = failure.value
      yield* Effect.logDebug(
        `模型输出解析失败，打回重写（第 ${parseRetries}/${MaxParseRewriteRetries} 次，${error.message}）：\n${output.text}`,
      )
      const rejectedAssistant: ModelMessage = {
        role: "assistant",
        content: output.text,
      }
      const receiptMessage: ModelMessage = {
        role: "user",
        content: formatParseReceipt(error.message),
      }
      input = {
        ...input,
        messages: [...input.messages, rejectedAssistant, receiptMessage],
      }
      continue
    }

    yield* Effect.logDebug(
      `第 ${toolRounds + 1} 轮模型请求工具：${output.toolCalls.map((call) => `${call.name}(${call.arguments})`).join("; ")}`,
    )
    if (toolRounds === 8) return yield* Effect.fail(new InvalidReply({ reason: "工具调用超过 8 轮" }))
    toolRounds += 1

    const calls = yield* Effect.forEach(output.toolCalls, (call): Effect.Effect<ParsedToolCall, InvalidReply> =>
      Effect.gen(function* () {
        if (call.name === "wake-up") {
          const args = yield* parseWakeUp(call.arguments).pipe(
            Effect.mapError(() => new InvalidReply({ reason: "wake-up 工具参数无效" })),
          )
          return { type: "wake-up", call, args }
        }
        if (call.name !== "notebook-query") return yield* Effect.fail(new InvalidReply({ reason: "未知工具" }))
        const args = yield* parseArguments(call.arguments).pipe(
          Effect.mapError(() => new InvalidReply({ reason: "记事本查询参数无效" })),
        )
        return { type: "notebook", call, queries: args.queries }
      }),
    )

    if (
      tryEnterCommit !== undefined &&
      calls.some((item) => item.type === "wake-up" && item.args.operation !== "query")
    ) {
      const allowed = yield* tryEnterCommit
      if (!allowed) return undefined
    }

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
    const toolMessages: ReadonlyArray<ModelMessage> = calls.map(({ call }, index) => ({
      role: "tool",
      toolCallId: call.id,
      content: results[index]!.content,
    }))
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
        ...toolMessages,
      ],
    }
  }
})

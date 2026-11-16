import { DateTime, Effect, Layer, Schema } from "effect"
import { InvalidReply } from "./invalid-reply"
import { channelIdOf, type Channel, type ChannelKey } from "../channels/channel"
import { type ChannelTrigger } from "./trigger"
import { ChannelExecutionError, ChannelRoleplay } from "./dialogue"
import { ChannelPlatform } from "../channels/messaging"
import { ChannelNotFound, ChannelStore } from "../channels/store"
import { CharacterCatalog } from "../characters/catalog"
import { CharacterRoutines } from "../characters/routines"
import { CharacterRoutineError } from "../characters/routine"
import { ChannelTriggers } from "./next-reply/triggers"
import { executeRoutineAction } from "../characters/execute-routine-actions"
import { ModelGateway } from "../models/gateway"
import { NotebookStore } from "../notebook/store"
import { Scheduler } from "../scheduling/scheduler"
import { WakeUpReplyPayload } from "./tools/wake-up-payload"
import { initializeChannel, validateChannelPresets } from "../channels/initialize"
import { buildChannelContext } from "./context/build-context"
import { parseChannelResponse } from "./response/parse-xml"
import { executeNoteAction, loadRecentNotes } from "../notebook/execute-actions"
import { makeChannelLock } from "../channels/lock"
import { generateChannelResponse } from "./tool-loop"

// 定时与短期唤醒只针对已绑定角色的频道；绑定缺失说明频道数据已被移除。
const bound = (channels: ChannelStore["Service"], key: ChannelKey) =>
  channels
    .find(key)
    .pipe(
      Effect.flatMap((channel) =>
        channel === undefined ? Effect.fail(new ChannelNotFound({ channelId: channelIdOf(key) })) : Effect.succeed(channel),
      ),
    )

export const ChannelRoleplayLive = (timezone: string, routines: CharacterRoutines["Service"] | undefined) =>
  Layer.effect(
    ChannelRoleplay,
    Effect.gen(function* () {
      const channels = yield* ChannelStore
      const characters = yield* CharacterCatalog
      const triggers = yield* ChannelTriggers
      const notebook = yield* NotebookStore
      const platform = yield* ChannelPlatform
      const model = yield* ModelGateway
      const scheduler = yield* Scheduler
      const withChannel = yield* makeChannelLock
      yield* validateChannelPresets

      const execute = Effect.fn("ChannelRoleplay.execute")(function* (channel: Channel, trigger: ChannelTrigger) {
        yield* Effect.logDebug(
          `开始执行回合，触发类型 ${trigger.type}${"reason" in trigger && trigger.reason ? `，原因：${trigger.reason}` : ""}`,
        )
        yield* triggers.clear(channel)
        const preset = yield* characters.get(channel.presetId)
        yield* Effect.logDebug(`已加载角色预设 ${channel.presetId}（${preset.character.name}）`)
        const history = yield* platform.history(
          channel,
          trigger.type === "message"
            ? { beforeMessageId: trigger.message.id, limit: 50 }
            : { beforeTime: trigger.time, limit: 50 },
        )
        yield* Effect.logDebug(
          `已读取历史 ${history.messages.length} 条，参与者 ${history.participants.length} 人`,
        )
        const notes = yield* loadRecentNotes(channel.id).pipe(Effect.provideService(NotebookStore, notebook))
        yield* Effect.logDebug(`已加载近期笔记 ${notes.length} 条`)
        const routine = routines === undefined ? undefined : yield* routines.get(channel.presetId)
        const now = yield* DateTime.nowAsDate
        const context = yield* Effect.try({
          try: () =>
            buildChannelContext({ channel, preset, history, notes, trigger, timezone, routine, now: now.getTime() }),
          catch: (error) => new InvalidReply({ reason: error instanceof Error ? error.message : "角色上下文组装失败" }),
        })
        yield* Effect.logDebug(
          `上下文组装完成，消息 ${context.messages.length} 条，共 ${context.messages.reduce(
            (sum, message) =>
              sum +
              (typeof message.content === "string"
                ? message.content.length
                : message.content.reduce((count, part) => count + (part.type === "text" ? part.text.length : 0), 0)),
            0,
          )} 字符`,
        )
        const output = yield* generateChannelResponse(
          channel,
          context,
          notes.flatMap((note) => [note.id, ...note.relations.map((relation) => relation.note.id)]),
          timezone,
        ).pipe(
          Effect.provideService(ModelGateway, model),
          Effect.provideService(NotebookStore, notebook),
          Effect.provideService(Scheduler, scheduler),
        )
        yield* Effect.logDebug(`模型最终输出：\n${output.text}`)
        const response = yield* parseChannelResponse(output.text).pipe(
          Effect.tapError((error) => Effect.logDebug(`响应解析失败：${error.reason}`)),
        )
        yield* Effect.logDebug(
          `响应解析完成，动作 ${response.actions.length} 个（${response.actions.map((action) => action.type).join(", ") || "无"}），状态字段 ${Object.keys(response.status).join(", ") || "无"}`,
        )
        const nextReplies = response.actions.filter((action) => action.type === "next-reply")
        const messageIds = new Set([
          ...history.messages.map((message) => message.id),
          ...(trigger.type === "message" ? [trigger.message.id] : []),
        ])
        const noteIds = new Set(output.noteIds)
        for (const action of response.actions) {
          if (action.type === "message" && action.quote !== undefined && !messageIds.has(action.quote)) {
            return yield* Effect.fail(new InvalidReply({ reason: "消息引用不在当前上下文中" }))
          }
          if (action.type === "note-add" && action.links?.some((link) => !noteIds.has(link.noteId))) {
            return yield* Effect.fail(new InvalidReply({ reason: "笔记引用不在当前上下文中" }))
          }
        }
        let completedActions = 0
        for (const action of response.actions) {
          if (action.type === "next-reply") continue
          yield* Effect.logDebug(`执行动作 #${completedActions + 1} ${action.type}`)
          const actionEffect: Effect.Effect<void, ChannelExecutionError["cause"]> =
            action.type === "message"
              ? platform.send(channel, action)
              : action.type === "note-add"
                ? executeNoteAction(channel.id, action).pipe(
                    Effect.provideService(NotebookStore, notebook),
                    Effect.asVoid,
                  )
                : routines === undefined
                  ? Effect.fail(new CharacterRoutineError({ reason: "日程功能未开启，无法执行 routine 动作" }))
                  : executeRoutineAction(channel.presetId, action).pipe(
                      Effect.provideService(CharacterRoutines, routines),
                    )
          yield* actionEffect.pipe(
            Effect.mapError((cause) => new ChannelExecutionError({ stage: "actions", completedActions, cause })),
          )
          completedActions++
        }
        if (Object.keys(response.status).length > 0) {
          yield* channels
            .setState(channel, { ...channel.state, ...response.status })
            .pipe(Effect.mapError((cause) => new ChannelExecutionError({ stage: "state", completedActions, cause })))
          yield* Effect.logDebug(`频道状态已更新：${JSON.stringify(response.status)}`)
        }
        if (nextReplies.length > 0) {
          yield* triggers.register(channel, nextReplies, (yield* DateTime.nowAsDate).getTime())
          yield* Effect.logDebug(`已登记短期唤醒条件 ${nextReplies.length} 个`)
        }
        return { actionsExecuted: completedActions }
      })

      return ChannelRoleplay.of({
        reply: ({ key, presetId, incoming }) =>
          withChannel(
            channelIdOf(key),
            Effect.gen(function* () {
              const channel = yield* initializeChannel(key, presetId).pipe(
                Effect.provideService(ChannelStore, channels),
                Effect.provideService(CharacterCatalog, characters),
              )
              yield* Effect.logDebug(`频道已绑定角色 ${channel.presetId}`)
              const now = yield* DateTime.nowAsDate
              const reason = yield* triggers.observeAndMatch(channel, incoming, now.getTime())
              if (reason !== undefined) yield* Effect.logDebug(`消息命中短期唤醒条件：${reason}`)
              return yield* execute(channel, {
                type: "message",
                message: incoming,
                ...(reason === undefined ? {} : { reason }),
              })
            }),
          ),
        scheduled: (task) =>
          Effect.gen(function* () {
            const payload = yield* Schema.decodeUnknownEffect(WakeUpReplyPayload, { onExcessProperty: "error" })(
              task.payload,
            ).pipe(Effect.mapError(() => new InvalidReply({ reason: "该任务不是有效的主动唤醒任务" })))
            return yield* withChannel(
              channelIdOf(payload),
              scheduler
                .run(
                  task,
                  (run) =>
                    Effect.gen(function* () {
                      const channel = yield* bound(channels, payload)
                      const now = yield* DateTime.nowAsDate
                      return yield* execute(channel, { type: "schedule", run, text: payload.text, time: now.getTime() })
                    }),
                  (error) =>
                    error._tag === "ChannelExecutionError"
                      ? { stage: error.stage, completedActions: error.completedActions }
                      : {},
                )
                .pipe(
                  Effect.map((result) =>
                    result === undefined ? undefined : { runId: result.runId, ...result.result },
                  ),
                ),
            )
          }),
        proactive: (trigger) =>
          Effect.gen(function* () {
            return yield* withChannel(
              channelIdOf(trigger.channel),
              Effect.gen(function* () {
                const channel = yield* bound(channels, trigger.channel)
                return yield* execute(channel, { type: "next-reply", reason: trigger.reason, time: trigger.time })
              }),
            )
          }),
      })
    }),
  )

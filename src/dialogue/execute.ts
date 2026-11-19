import { DateTime, Effect, Layer, Schema } from "effect"
import { InvalidReply } from "./invalid-reply"
import { channelIdOf, type Channel, type ChannelKey } from "../channels/channel"
import type { Message } from "../channels/message"
import { type ChannelTrigger, type GroupTriggerConfig } from "./trigger"
import { matchesGroupTrigger, triggerTargetFromHistory } from "./match-trigger"
import { ChannelExecutionError, ChannelRoleplay } from "./dialogue"
import { ChannelPlatform, type ChannelHistory } from "../channels/messaging"
import { ChannelMediaStore } from "../channels/media"
import { ChannelNotFound, ChannelStore } from "../channels/store"
import { CharacterCatalog } from "../characters/catalog"
import type { CharacterPreset } from "../characters/preset"
import { CharacterRoutines } from "../characters/routines"
import { CharacterRoutineError } from "../characters/routine"
import { MaxCharacterStickers, type StickerId, type StickerInput } from "../characters/sticker"
import { CharacterStickers } from "../characters/sticker-store"
import { ChannelTriggers } from "./next-reply/triggers"
import { executeRoutineAction } from "../characters/execute-routine-actions"
import type { ImageMimeType } from "../media/image"
import { ModelGateway } from "../models/gateway"
import { NotebookStore } from "../notebook/store"
import { Scheduler } from "../scheduling/scheduler"
import { WakeUpReplyPayload } from "./tools/wake-up-payload"
import { initializeChannel, validateChannelPresets } from "../channels/initialize"
import { buildChannelContext } from "./context/build-context"
import { parseChannelResponse } from "./response/parse-xml"
import { executeNoteAction, loadRecentNotes } from "../notebook/execute-actions"
import { generateChannelResponse } from "./tool-loop"
import { loadImageAttachments } from "./context/attachments"
import type { MessageAction, StickerDelivery } from "../channels/message-action"
import type { NoteAction } from "../notebook/note"
import type { RoutineAction } from "../characters/routine"

// 定时与短期唤醒只针对已绑定角色的频道；绑定缺失说明频道数据已被移除。
const bound = (channels: ChannelStore["Service"], key: ChannelKey) =>
  channels.find(key).pipe(
    Effect.flatMap((channel) =>
      channel === undefined ? Effect.fail(new ChannelNotFound({ channelId: channelIdOf(key) })) : Effect.succeed(channel),
    ),
  )

interface WorkingSticker {
  readonly summary: string
  readonly sha256: string
  readonly pendingAsset?: {
    readonly mimeType: ImageMimeType
    readonly bytes: Uint8Array
  }
}

type Execution =
  | { readonly type: "message"; readonly action: MessageAction }
  | { readonly type: "sticker"; readonly delivery: StickerDelivery }
  | { readonly type: "sticker-save"; readonly input: StickerInput }
  | { readonly type: "sticker-update"; readonly stickerId: StickerId; readonly summary: string }
  | { readonly type: "sticker-delete"; readonly stickerId: StickerId }
  | { readonly type: "note-add"; readonly action: NoteAction }
  | { readonly type: "routine"; readonly action: RoutineAction }

export const ChannelRoleplayLive = (
  timezone: string,
  routines: CharacterRoutines["Service"] | undefined,
  groupTriggers?: GroupTriggerConfig,
) =>
  Layer.effect(
    ChannelRoleplay,
    Effect.gen(function* () {
      const channels = yield* ChannelStore
      const characters = yield* CharacterCatalog
      const stickers = yield* CharacterStickers
      const media = yield* ChannelMediaStore
      const triggers = yield* ChannelTriggers
      const notebook = yield* NotebookStore
      const platform = yield* ChannelPlatform
      const model = yield* ModelGateway
      const scheduler = yield* Scheduler
      yield* validateChannelPresets

      const execute = Effect.fn("ChannelRoleplay.execute")(function* (
        channel: Channel,
        trigger: ChannelTrigger,
        options?: {
          readonly preloaded?: { readonly preset: CharacterPreset; readonly history: ChannelHistory }
          readonly tryEnterCommit?: Effect.Effect<boolean>
        },
      ) {
        yield* Effect.logDebug(
          `开始执行回合，触发类型 ${trigger.type}${"reason" in trigger && trigger.reason ? `，原因：${trigger.reason}` : ""}`,
        )
        const preset = options?.preloaded ? options.preloaded.preset : yield* characters.get(channel.presetId)
        const currentStickers = yield* stickers.list(channel.presetId)
        yield* Effect.logDebug(
          `已加载角色预设 ${channel.presetId}（${preset.character.name}），当前表情包 ${currentStickers.length} 张`,
        )
        const history = options?.preloaded
          ? options.preloaded.history
          : yield* platform.history(
              channel,
              trigger.type === "message"
                ? {
                    beforeMessageId: trigger.messages[0].id,
                    incomingIds: trigger.messages.map((message) => message.id),
                    limit: 50,
                  }
                : { beforeTime: trigger.time, limit: 50 },
            )
        yield* Effect.logDebug(
          `已读取历史 ${history.messages.length} 条，参与者 ${history.participants.length} 人`,
        )
        const knownStickerHashes = new Set(currentStickers.map((item) => item.sha256))
        // 主模型不支持图片时不读取媒体，所有未识别为已有表情包的图片在上下文中标记为 attached="false"。
        const attachments = model.capabilities.imageInput
          ? yield* loadImageAttachments(media, history, trigger, knownStickerHashes)
          : []
        const notes = yield* loadRecentNotes(channel.id).pipe(Effect.provideService(NotebookStore, notebook))
        yield* Effect.logDebug(`已加载近期笔记 ${notes.length} 条`)
        const routine = routines === undefined ? undefined : yield* routines.get(channel.presetId)
        const now = yield* DateTime.nowAsDate
        const context = yield* Effect.try({
          try: () =>
            buildChannelContext({
              channel,
              preset,
              stickers: currentStickers,
              history,
              notes,
              trigger,
              timezone,
              routine,
              now: now.getTime(),
              attachments,
            }),
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
          options?.tryEnterCommit,
        ).pipe(
          Effect.provideService(ModelGateway, model),
          Effect.provideService(NotebookStore, notebook),
          Effect.provideService(Scheduler, scheduler),
        )
        if (output === undefined) {
          yield* Effect.logDebug("本轮思考已被后续新消息抢占，放弃继续生成")
          return { actionsExecuted: 0, spoke: false }
        }
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
          ...(trigger.type === "message" ? trigger.messages.map((message) => message.id) : []),
        ])
        const participantIds = new Set<string>(history.participants.map((participant) => participant.id))
        const noteIds = new Set(output.noteIds)
        const attachmentsByRef = new Map(attachments.map((item) => [item.ref, item]))
        const workingStickers = new Map<StickerId, WorkingSticker>(
          currentStickers.map((item) => [item.id, { summary: item.summary, sha256: item.sha256 }]),
        )
        const executions: Execution[] = []
        // 先完整校验并按顺序推演工作集，再执行任何外部动作；失败不会发出半截消息。
        for (const action of response.actions) {
          if (action.type === "next-reply") {
            if (action.userId !== "all" && (action.userId === history.bot.id || !participantIds.has(action.userId))) {
              return yield* Effect.fail(new InvalidReply({ reason: "短期唤醒目标用户不在当前上下文中" }))
            }
            continue
          }
          if (action.type === "message") {
            for (const part of action.parts) {
              if (part.type !== "at") continue
              if (history.direct) return yield* Effect.fail(new InvalidReply({ reason: "私聊不能使用 @ 提及" }))
              if (part.user === history.bot.id || !participantIds.has(part.user)) {
                return yield* Effect.fail(new InvalidReply({ reason: "消息提及不在当前上下文中" }))
              }
            }
            if (action.quote !== undefined && !messageIds.has(action.quote)) {
              return yield* Effect.fail(new InvalidReply({ reason: "消息引用不在当前上下文中" }))
            }
            executions.push({ type: "message", action })
            continue
          }
          if (action.type === "sticker-delete") {
            if (!workingStickers.has(action.stickerId)) {
              return yield* Effect.fail(new InvalidReply({ reason: `角色没有名为 ${action.stickerId} 的表情包` }))
            }
            workingStickers.delete(action.stickerId)
            executions.push({ type: "sticker-delete", stickerId: action.stickerId })
            continue
          }
          if (action.type === "sticker-save") {
            const attachment = attachmentsByRef.get(action.ref)
            if (attachment === undefined) {
              return yield* Effect.fail(
                new InvalidReply({ reason: `表情包收藏引用的图片 ${action.ref} 不在当前附带画面中` }),
              )
            }
            if (workingStickers.has(action.stickerId)) {
              return yield* Effect.fail(new InvalidReply({ reason: `表情包 ID ${action.stickerId} 已存在` }))
            }
            if ([...workingStickers.values()].some((item) => item.sha256 === attachment.sha256)) {
              return yield* Effect.fail(new InvalidReply({ reason: "该图片已在角色表情包中" }))
            }
            if (workingStickers.size >= MaxCharacterStickers) {
              return yield* Effect.fail(
                new InvalidReply({ reason: `角色表情包数量已达上限 ${MaxCharacterStickers}` }),
              )
            }
            workingStickers.set(action.stickerId, {
              summary: action.summary,
              sha256: attachment.sha256,
              pendingAsset: { mimeType: attachment.mimeType, bytes: attachment.bytes },
            })
            executions.push({
              type: "sticker-save",
              input: {
                characterId: channel.presetId,
                id: action.stickerId,
                summary: action.summary,
                sha256: attachment.sha256,
                mimeType: attachment.mimeType,
                bytes: attachment.bytes,
              },
            })
            continue
          }
          if (action.type === "sticker-update") {
            const existing = workingStickers.get(action.stickerId)
            if (existing === undefined) {
              return yield* Effect.fail(new InvalidReply({ reason: `角色没有名为 ${action.stickerId} 的表情包` }))
            }
            workingStickers.set(action.stickerId, { ...existing, summary: action.summary })
            executions.push({ type: "sticker-update", stickerId: action.stickerId, summary: action.summary })
            continue
          }
          if (action.type === "sticker") {
            const current = workingStickers.get(action.stickerId)
            if (current === undefined) {
              return yield* Effect.fail(new InvalidReply({ reason: `角色没有名为 ${action.stickerId} 的表情包` }))
            }
            if (action.quote !== undefined && !messageIds.has(action.quote)) {
              return yield* Effect.fail(new InvalidReply({ reason: "消息引用不在当前上下文中" }))
            }
            const asset =
              current.pendingAsset !== undefined
                ? current.pendingAsset
                : yield* stickers.load(channel.presetId, action.stickerId)
            executions.push({
              type: "sticker",
              delivery: {
                type: "sticker",
                stickerId: action.stickerId,
                summary: current.summary,
                sha256: current.sha256,
                mimeType: asset.mimeType,
                byteLength: asset.bytes.byteLength,
                bytes: asset.bytes,
                ...(action.quote === undefined ? {} : { quote: action.quote }),
              },
            })
            continue
          }
          if (action.type === "note-add" && action.links?.some((link) => !noteIds.has(link.noteId))) {
            return yield* Effect.fail(new InvalidReply({ reason: "笔记引用不在当前上下文中" }))
          }
          executions.push(
            action.type === "note-add"
              ? { type: "note-add", action }
              : { type: "routine", action },
          )
        }
        if (options?.tryEnterCommit !== undefined) {
          const allowed = yield* options.tryEnterCommit
          if (!allowed) {
            yield* Effect.logDebug("本轮思考已被后续新消息抢占，放弃提交")
            return { actionsExecuted: 0, spoke: false }
          }
        }
        yield* triggers.clear(channel)
        let completedActions = 0
        let spoke = false
        for (const execution of executions) {
          yield* Effect.logDebug(`执行动作 #${completedActions + 1} ${execution.type}`)
          let actionEffect: Effect.Effect<void, ChannelExecutionError["cause"]>
          switch (execution.type) {
            case "message":
              spoke = true
              actionEffect = platform.send(channel, execution.action)
              break
            case "sticker":
              spoke = true
              actionEffect = platform.send(channel, execution.delivery)
              break
            case "sticker-save":
              actionEffect = stickers.save(execution.input).pipe(Effect.asVoid)
              break
            case "sticker-update":
              actionEffect = stickers.update(channel.presetId, execution.stickerId, execution.summary).pipe(Effect.asVoid)
              break
            case "sticker-delete":
              actionEffect = stickers.remove(channel.presetId, execution.stickerId)
              break
            case "note-add":
              actionEffect = executeNoteAction(channel.id, execution.action).pipe(
                Effect.provideService(NotebookStore, notebook),
                Effect.asVoid,
              )
              break
            case "routine":
              actionEffect =
                routines === undefined
                  ? Effect.fail(new CharacterRoutineError({ reason: "日程功能未开启，无法执行 routine 动作" }))
                  : executeRoutineAction(channel.presetId, execution.action).pipe(
                      Effect.provideService(CharacterRoutines, routines),
                    )
              break
          }
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
        return { actionsExecuted: completedActions, spoke }
      })

      return ChannelRoleplay.of({
        reply: ({ key, presetId, incoming, observed, tryEnterCommit }) =>
          Effect.gen(function* () {
            const messages: readonly [Message, ...Message[]] = "id" in incoming ? [incoming] : incoming
            const channel = yield* initializeChannel(key, presetId).pipe(
              Effect.provideService(ChannelStore, channels),
              Effect.provideService(CharacterCatalog, characters),
            )
            yield* Effect.logDebug(`频道已绑定角色 ${channel.presetId}`)
            const preset = yield* characters.get(channel.presetId)
            const history = yield* platform.history(channel, {
              beforeMessageId: messages[0].id,
              incomingIds: messages.map((message) => message.id),
              limit: 50,
            })
            let reason = observed?.reason
            if (observed === undefined) {
              const now = yield* DateTime.nowAsDate
              for (const message of messages) {
                const matched = yield* triggers.observeAndMatch(channel, message, now.getTime())
                if (matched !== undefined && reason === undefined) reason = matched
              }
              if (reason !== undefined) yield* Effect.logDebug(`消息命中短期唤醒条件：${reason}`)
              if (
                groupTriggers !== undefined &&
                !history.direct &&
                reason === undefined &&
                !messages.some((message) =>
                  matchesGroupTrigger(groupTriggers, message, triggerTargetFromHistory(message, history), preset.character),
                )
              ) {
                yield* Effect.logDebug("群聊消息未命中触发条件，跳过本轮")
                return { actionsExecuted: 0, spoke: false }
              }
            }
            return yield* execute(
              channel,
              {
                type: "message",
                messages,
                ...(reason === undefined ? {} : { reason }),
              },
              {
                preloaded: { preset, history },
                ...(tryEnterCommit === undefined ? {} : { tryEnterCommit }),
              },
            )
          }),
        scheduled: (task) =>
          Effect.gen(function* () {
            const payload = yield* Schema.decodeUnknownEffect(WakeUpReplyPayload, { onExcessProperty: "error" })(
              task.payload,
            ).pipe(Effect.mapError(() => new InvalidReply({ reason: "该任务不是有效的主动唤醒任务" })))
            return yield* scheduler
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
              )
          }),
        proactive: (trigger, options) =>
          Effect.gen(function* () {
            const channel = yield* bound(channels, trigger.channel)
            return yield* execute(
              channel,
              { type: "next-reply", reason: trigger.reason, time: trigger.time },
              options?.tryEnterCommit === undefined ? undefined : { tryEnterCommit: options.tryEnterCommit },
            )
          }),
        ambient: (trigger, options) =>
          Effect.gen(function* () {
            const channel = yield* bound(channels, trigger.channel)
            return yield* execute(
              channel,
              { type: "ambient", reason: trigger.reason, time: trigger.time },
              options?.tryEnterCommit === undefined ? undefined : { tryEnterCommit: options.tryEnterCommit },
            )
          }),
      })
    }),
  )

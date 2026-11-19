import { join } from "node:path"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import { Universal, type Context, type Session } from "koishi"
import type { Config } from "../config/schema"
import type { ConfigurationError } from "../config/error"
import { resolveConfig, resolveModel } from "../config/resolve"
import { ChannelRoleplay, type ChannelReplyError } from "../dialogue/dialogue"
import { ChannelRoleplayLive } from "../dialogue/execute"
import { makeChannelCoordinator } from "../dialogue/channel-coordinator"
import { matchesGroupTrigger } from "../dialogue/match-trigger"
import { ChannelStore, ChannelStoreError } from "../channels/store"
import { ChannelMediaStore } from "../channels/media"
import { channelMediaStoreFile } from "../channels/file-media"
import type { KoishiHistoryError } from "../channels/history"
import { CharacterCatalog } from "../characters/catalog"
import { CharacterRoutinesLive } from "../characters/generated-routines"
import { CharacterRoutines } from "../characters/routines"
import { stickerStoreLayer } from "../characters/koishi-sticker-store"
import { ChannelTriggers } from "../dialogue/next-reply/triggers"
import { ChannelTriggersLive } from "../dialogue/next-reply/track-triggers"
import { ModelGatewayRecorded } from "../models/records/recorded-gateway"
import { WakeUpReplyPayload } from "../dialogue/tools/wake-up-payload"
import { runDueSchedules } from "../scheduling/runner"
import { InvalidReply } from "../dialogue/invalid-reply"
import { channelIdOf } from "../channels/channel"
import { type ScheduleTask } from "../scheduling/schedule"
import { CharacterCatalogLocal } from "../characters/file-catalog"
import { databaseLayer } from "./database"
import { createKoishiHistory, keyOf } from "../channels/koishi-history"
import { loggerLayer } from "./logger"
import { ModelHttpKoishi } from "../models/http/koishi-client"
import { makeImageSupport, watchModelSchema } from "./model-schema"
import { ModelGatewayDeepSeek } from "../models/deepseek/gateway"
import { ModelGatewayOpenAI } from "../models/openai/gateway"
import { ModelGatewayGemini } from "../models/gemini/gateway"
import { ModelTraceStoreFile } from "../models/records/file-store"

const report = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(Cause.pretty(cause))

export const pluginLayer = (ctx: Context, raw: Config) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* resolveConfig(raw, ctx.baseDir)
      const databaseGate = yield* Semaphore.make(1)
      const base = yield* Layer.build(
        Layer.mergeAll(
          databaseLayer(ctx.database, databaseGate.withPermit),
          stickerStoreLayer(ctx.database, databaseGate.withPermit, join(config.dataDirectory, "stickers")),
          ModelTraceStoreFile(join(config.dataDirectory, "logs")),
        ),
      )
      const http = ModelHttpKoishi(ctx.http)
      const imageSupport = yield* makeImageSupport()
      // 模型列表是控制台输入选项，失败只影响可选项，不阻断插件启动。
      yield* watchModelSchema(ctx, raw.models, imageSupport).pipe(Effect.provide(http))
      const catalog = () => CharacterCatalogLocal(config.directory, config.presets)
      const modelLayer = Effect.gen(function* () {
        const selected = yield* resolveModel(raw.models)
        const imageInput = (yield* Ref.get(imageSupport)).get(`${selected.provider}/${selected.model}`) ?? true
        yield* Effect.logDebug(
          `选用模型 ${selected.provider}/${selected.model}（图片输入${imageInput ? "已启用" : "不受支持，本轮不附带图片"}）`,
        )
        const capabilities = { imageInput }
        const gateway =
          selected.provider === "deepseek"
            ? ModelGatewayDeepSeek(selected, capabilities)
            : selected.provider === "gemini"
              ? ModelGatewayGemini(selected, capabilities)
              : ModelGatewayOpenAI(selected, capabilities)
        return ModelGatewayRecorded(selected.model).pipe(Layer.provide(gateway.pipe(Layer.provide(http))))
      })
      const channels = yield* ChannelStore.pipe(Effect.provideContext(base))
      const presets = yield* Effect.gen(function* () {
        const characters = yield* CharacterCatalog
        const ids = yield* channels.listPresetIds()
        return yield* Effect.forEach(
          [config.characterId, ...ids.filter((id) => id !== config.characterId)],
          characters.get,
        )
      }).pipe(Effect.provide(catalog()))
      const media = channelMediaStoreFile(ctx.http, join(config.dataDirectory, "media"), ctx.baseDir)
      const routines = config.routineEnabled
        ? yield* CharacterRoutines.pipe(
            Effect.provideContext(
              yield* Layer.build(
                CharacterRoutinesLive(presets, config.timezone).pipe(Layer.provide(yield* modelLayer)),
              ).pipe(Effect.provideContext(base)),
            ),
          )
        : undefined
      const triggers = yield* Layer.build(ChannelTriggersLive)
      const triggerService = yield* ChannelTriggers.pipe(Effect.provideContext(triggers))
      const history = yield* createKoishiHistory(ctx, databaseGate.withPermit, media)
      const run = yield* FiberSet.makeRuntime()

      // 每轮创建当前模型与角色目录快照，文件预设每轮重新读取。
      const execute = <A>(
        session: Session,
        runTurn: (service: ChannelRoleplay["Service"]) => Effect.Effect<A, ChannelReplyError>,
      ) =>
        Effect.gen(function* () {
          const model = yield* modelLayer
          const roleplay = ChannelRoleplayLive(config.timezone, routines, config.triggers).pipe(
            Layer.provide(
              Layer.mergeAll(
                model,
                catalog(),
                history.channelPlatform(session),
                Layer.succeed(ChannelMediaStore, media),
              ),
            ),
          )
          return yield* Effect.flatMap(ChannelRoleplay, runTurn).pipe(
            Effect.provide(roleplay),
            Effect.provideContext(triggers),
            Effect.provideContext(base),
          )
        })

      const coordinator = yield* makeChannelCoordinator<
        Session,
        ConfigurationError | ChannelReplyError | KoishiHistoryError
      >(
        config.debounce,
        {
          runMessage: (batch, tryEnterCommit) =>
            Effect.gen(function* () {
              const result = yield* execute(batch.context, (roleplay) =>
                roleplay.reply({
                  key: batch.key,
                  presetId: batch.presetId,
                  incoming: batch.messages,
                  observed: { ...(batch.reason === undefined ? {} : { reason: batch.reason }) },
                  tryEnterCommit,
                }),
              )
              yield* Effect.logDebug(
                `消息回合完成，合并消息 ${batch.messages.length} 条，执行动作 ${result.actionsExecuted} 个`,
              )
            }).pipe(
              Effect.catchCause(report),
              Effect.withLogSpan("turn"),
              Effect.annotateLogs({ channel: channelIdOf(batch.key), trigger: "message" }),
            ),
          runProactive: (trigger, tryEnterCommit) =>
            Effect.gen(function* () {
              const session = yield* history.sessionFor(trigger.channel)
              if (!session) return yield* Effect.logDebug("无法还原可发送的会话（无在线受理机器人或被过滤），跳过")
              const result = yield* execute(session, (roleplay) => roleplay.proactive(trigger, { tryEnterCommit }))
              yield* Effect.logDebug(`主动回合完成，执行动作 ${result.actionsExecuted} 个`)
            }).pipe(
              Effect.catchCause(report),
              Effect.withLogSpan("turn"),
              Effect.annotateLogs({ channel: channelIdOf(trigger.channel), trigger: "next-reply" }),
            ),
          runScheduled: (task) =>
            Effect.gen(function* () {
              const payload = yield* Schema.decodeUnknownEffect(WakeUpReplyPayload)(task.payload).pipe(
                Effect.mapError(() => new InvalidReply({ reason: "无法识别的主动唤醒任务" })),
              )
              const session = yield* history.sessionFor(payload)
              if (!session) return yield* Effect.logDebug("无法还原可发送的会话（无在线受理机器人或被过滤），跳过")
              const result = yield* execute(session, (roleplay) => roleplay.scheduled(task))
              yield* Effect.logDebug(
                result === undefined ? "定时任务已失效，未执行" : `定时回合完成，执行动作 ${result.actionsExecuted} 个`,
              )
            }).pipe(
              Effect.withLogSpan("turn"),
              Effect.annotateLogs({ trigger: "schedule" }),
            ),
        },
        (effect) => Effect.sync(() => run(effect)),
      )

      // 由 Koishi 中间件调用：入站消息立即落库，再交由单频道协调器防抖合并或静默跳过。
      const receive = Effect.fn("Yokai.receive")(function* (session: Session) {
        const key = keyOf(session)
        yield* Effect.logDebug(
          `收到消息 message=${session.messageId} user=${session.userId} direct=${session.isDirect}：${session.content}`,
        )
        if (!key) return yield* Effect.logDebug("会话缺少平台或频道标识，忽略")
        // Koishi 只为群聊建档；私聊按同一规则（autoAssign）补建频道记录。
        if (session.isDirect) {
          yield* Effect.tryPromise({
            try: () => session.getChannel(key.channelId, ["assignee"]),
            catch: () => new ChannelStoreError({ operation: "attach" }),
          })
          yield* Effect.logDebug("私聊频道记录已就绪")
        }
        const received = yield* history.recordIncoming(session)
        if (!received) return yield* Effect.logDebug("消息未写入历史（无文本或重复事件），跳过本轮")
        const now = Date.now()
        const reason = yield* triggerService.observeAndMatch(key, received.incoming, now)
        if (reason !== undefined) yield* Effect.logDebug(`消息命中短期唤醒条件：${reason}`)
        let triggered = received.direct || reason !== undefined
        if (!triggered) {
          const existing = yield* channels.find(key)
          const preset = yield* Effect.flatMap(CharacterCatalog, (service) =>
            service.get(existing?.presetId ?? config.characterId),
          ).pipe(Effect.provide(catalog()))
          triggered = matchesGroupTrigger(
            config.triggers,
            received.incoming,
            { botId: received.botId, quotedBot: received.quotedBot },
            preset.character,
          )
        }
        yield* coordinator.submitMessage({
          key,
          presetId: config.characterId,
          context: session,
          message: received.incoming,
          triggered,
          ...(reason === undefined ? {} : { reason }),
          now,
        })
      })

      const dispatch = Effect.fn("Yokai.dispatch")(function* (task: ScheduleTask) {
        const payload = yield* Schema.decodeUnknownEffect(WakeUpReplyPayload)(task.payload).pipe(
          Effect.mapError(() => new InvalidReply({ reason: "无法识别的主动唤醒任务" })),
        )
        yield* Effect.logDebug(`定时任务 ${task.id} 到期：${payload.text}`)
        yield* coordinator.submitScheduled(payload, task).pipe(
          Effect.annotateLogs({ channel: channelIdOf(payload) }),
        )
      })

      const scheduleTick = Effect.gen(function* () {
        const results = yield* runDueSchedules(dispatch).pipe(Effect.provideContext(base))
        for (const { exit } of results) if (Exit.isFailure(exit)) yield* report(exit.cause)
      })
      const proactiveTick = Effect.gen(function* () {
        const pending = yield* triggerService.due(Date.now())
        yield* Effect.forEach(
          pending,
          (trigger) =>
            Effect.gen(function* () {
              yield* Effect.logDebug(`短期唤醒条件满足：${trigger.reason}`)
              yield* coordinator.submitProactive(trigger)
            }).pipe(Effect.catchCause(report)),
          { concurrency: "unbounded", discard: true },
        )
      })
      const schedulePass = yield* Semaphore.make(1)
      const proactivePass = yield* Semaphore.make(1)
      // 监听与时钟归当前 ctx；额外 finalizer 也覆盖初始化失败时的回收。
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          // 指令中间件先于本插件注册，匹配到指令的消息不会进入角色扮演；后续中间件不等待模型回合。
          ctx.middleware(async (session, next) => {
            const turn = Effect.runPromise(
              Fiber.await(
                run(
                  receive(session).pipe(
                    Effect.catchCause(report),
                    Effect.withLogSpan("turn"),
                    Effect.annotateLogs({ channel: session.cid, trigger: "message" }),
                  ),
                ),
              ),
            )
            const result = await next()
            await turn
            return result
          }),
        ),
        (dispose) => Effect.sync(dispose),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          ctx.on("bot-status-updated", (bot) => {
            if (bot.status === Universal.Status.ONLINE) {
              run(history.syncBot(bot).pipe(Effect.catchCause(report)))
            } else {
              run(history.invalidateBot(bot).pipe(Effect.catchCause(report)))
            }
          }),
        ),
        (dispose) => Effect.sync(dispose),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          ctx.on("bot-removed", (bot) => {
            run(history.invalidateBot(bot).pipe(Effect.catchCause(report)))
          }),
        ),
        (dispose) => Effect.sync(dispose),
      )
      for (const bot of ctx.bots) {
        if (bot.status === Universal.Status.ONLINE) {
          yield* Effect.sync(() => run(history.syncBot(bot).pipe(Effect.catchCause(report))))
        }
      }
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          ctx.setInterval(() => {
            run(schedulePass.withPermitsIfAvailable(1)(scheduleTick).pipe(Effect.catchCause(report)))
            run(proactivePass.withPermitsIfAvailable(1)(proactiveTick).pipe(Effect.catchCause(report)))
          }, 1000),
        ),
        (dispose) => Effect.sync(dispose),
      )
    }).pipe(Effect.provide(loggerLayer(ctx))),
  )

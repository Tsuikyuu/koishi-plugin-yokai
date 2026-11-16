import { join } from "node:path"
import {
  Cause,
  Context as Services,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import type { Context, Session } from "koishi"
import type { Config } from "../config/schema"
import { resolveConfig, resolveModel } from "../config/resolve"
import { ChannelRoleplay, type ChannelReplyError } from "../dialogue/dialogue"
import { ChannelRoleplayLive } from "../dialogue/execute"
import { ChannelStore, ChannelStoreError } from "../channels/store"
import { makeChannelLock } from "../channels/lock"
import { CharacterCatalog } from "../characters/catalog"
import { CharacterRoutinesLive } from "../characters/generated-routines"
import { CharacterRoutines } from "../characters/routines"
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
        Layer.merge(
          databaseLayer(ctx.database, databaseGate.withPermit),
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
      const channels = Services.get(base, ChannelStore)
      const presets = yield* Effect.gen(function* () {
        const characters = yield* CharacterCatalog
        const ids = yield* channels.listPresetIds()
        return yield* Effect.forEach(
          [config.characterId, ...ids.filter((id) => id !== config.characterId)],
          characters.get,
        )
      }).pipe(Effect.provide(catalog()))
      const routines = config.routineEnabled
        ? Services.get(
            yield* Layer.build(
              CharacterRoutinesLive(presets, config.timezone).pipe(Layer.provide(yield* modelLayer)),
            ).pipe(Effect.provideContext(base)),
            CharacterRoutines,
          )
        : undefined
      const triggers = yield* Layer.build(ChannelTriggersLive)
      const history = yield* createKoishiHistory(ctx, databaseGate.withPermit)
      const withChannel = yield* makeChannelLock

      // 频道锁内创建本轮模型与角色目录快照，文件预设每轮重新读取。
      const execute = <A>(
        session: Session,
        run: (service: ChannelRoleplay["Service"]) => Effect.Effect<A, ChannelReplyError>,
      ) =>
        Effect.gen(function* () {
          const model = yield* modelLayer
          const roleplay = ChannelRoleplayLive(config.timezone, routines).pipe(
            Layer.provide(Layer.mergeAll(model, catalog(), history.channelPlatform(session))),
          )
          return yield* Effect.flatMap(ChannelRoleplay, run).pipe(
            Effect.provide(roleplay),
            Effect.provideContext(triggers),
            Effect.provideContext(base),
          )
        })

      // 由 Koishi 中间件调用：过滤器、自身消息、频道建档与受理人判断已由框架完成。
      const receive = Effect.fn("Yokai.receive")(function* (session: Session) {
        const key = keyOf(session)
        yield* Effect.logDebug(
          `收到消息 message=${session.messageId} user=${session.userId} direct=${session.isDirect}：${session.content}`,
        )
        if (!key) return yield* Effect.logDebug("会话缺少平台或频道标识，忽略")
        yield* Effect.logDebug("等待频道锁")
        yield* withChannel(
          channelIdOf(key),
          Effect.gen(function* () {
            yield* Effect.logDebug("已获取频道锁")
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
            const result = yield* execute(session, (roleplay) =>
              roleplay.reply({ ...received, presetId: config.characterId }),
            )
            yield* Effect.logDebug(`消息回合完成，执行动作 ${result.actionsExecuted} 个`)
          }),
        )
      })

      const dispatch = Effect.fn("Yokai.dispatch")(function* (task: ScheduleTask) {
        const payload = yield* Schema.decodeUnknownEffect(WakeUpReplyPayload)(task.payload).pipe(
          Effect.mapError(() => new InvalidReply({ reason: "无法识别的主动唤醒任务" })),
        )
        yield* Effect.logDebug(`定时任务 ${task.id} 到期：${payload.text}`)
        yield* withChannel(
          channelIdOf(payload),
          Effect.gen(function* () {
            const session = yield* history.sessionFor(payload)
            if (!session) return yield* Effect.logDebug("无法还原可发送的会话（无在线受理机器人或被过滤），跳过")
            const result = yield* execute(session, (roleplay) => roleplay.scheduled(task))
            yield* Effect.logDebug(
              result === undefined ? "定时任务已失效，未执行" : `定时回合完成，执行动作 ${result.actionsExecuted} 个`,
            )
          }),
        ).pipe(
          Effect.withLogSpan("turn"),
          Effect.annotateLogs({ channel: channelIdOf(payload), trigger: "schedule" }),
        )
      })

      const scheduleTick = Effect.gen(function* () {
        const results = yield* runDueSchedules(dispatch).pipe(Effect.provideContext(base))
        for (const { exit } of results) if (Exit.isFailure(exit)) yield* report(exit.cause)
      })
      const proactiveTick = Effect.gen(function* () {
        const pending = yield* Services.get(triggers, ChannelTriggers).due(Date.now())
        yield* Effect.forEach(
          pending,
          (trigger) =>
            Effect.gen(function* () {
              yield* Effect.logDebug(`短期唤醒条件满足：${trigger.reason}`)
              yield* withChannel(
                channelIdOf(trigger.channel),
                Effect.gen(function* () {
                  const session = yield* history.sessionFor(trigger.channel)
                  if (!session) return yield* Effect.logDebug("无法还原可发送的会话（无在线受理机器人或被过滤），跳过")
                  const result = yield* execute(session, (roleplay) => roleplay.proactive(trigger))
                  yield* Effect.logDebug(`主动回合完成，执行动作 ${result.actionsExecuted} 个`)
                }),
              )
            }).pipe(
              Effect.catchCause(report),
              Effect.withLogSpan("turn"),
              Effect.annotateLogs({ channel: channelIdOf(trigger.channel), trigger: "next-reply" }),
            ),
          { concurrency: "unbounded", discard: true },
        )
      })
      const schedulePass = yield* Semaphore.make(1)
      const proactivePass = yield* Semaphore.make(1)
      const run = yield* FiberSet.makeRuntime()
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
          ctx.setInterval(() => {
            run(schedulePass.withPermitsIfAvailable(1)(scheduleTick).pipe(Effect.catchCause(report)))
            run(proactivePass.withPermitsIfAvailable(1)(proactiveTick).pipe(Effect.catchCause(report)))
          }, 1000),
        ),
        (dispose) => Effect.sync(dispose),
      )
    }).pipe(Effect.provide(loggerLayer(ctx))),
  )

import { DateTime, Deferred, Effect, Exit, Ref } from "effect"
import { channelIdOf, type ChannelId, type ChannelKey } from "../channels/channel"
import type { Message, ParticipantId } from "../channels/message"
import type { CharacterId } from "../characters/character"
import type { ScheduleTask } from "../scheduling/schedule"
import type { ProactiveTrigger } from "./next-reply/triggers"
import type { ChannelCoordinator, ChannelTurnRunner, IncomingSubmission } from "./coordinator"
import type { DebounceConfig } from "./trigger"

interface MessageBatch<Ctx> {
  readonly key: ChannelKey
  readonly presetId: CharacterId
  readonly context: Ctx
  readonly messages: readonly [Message, ...Message[]]
  readonly trackedSenders: ReadonlySet<ParticipantId>
  readonly reason: string | undefined
  readonly firstTriggeredAt: number
  readonly lastTrackedAt: number
  readonly capAt: number
  readonly done: Deferred.Deferred<void>
}

type InstantJob<ScheduleError> =
  | {
      readonly type: "proactive"
      readonly source: "next-reply" | "ambient"
      readonly trigger: ProactiveTrigger
      readonly done: Deferred.Deferred<void>
    }
  | {
      readonly type: "scheduled"
      readonly task: ScheduleTask
      readonly done: Deferred.Deferred<void, ScheduleError>
    }

type ActiveTurn<Ctx, ScheduleError> =
  | {
      readonly type: "message"
      readonly batch: MessageBatch<Ctx>
      readonly bystanders: ReadonlyArray<Message>
      readonly interruptible: boolean
      readonly cancel: Deferred.Deferred<void>
    }
  | {
      readonly type: "proactive"
      readonly job: Extract<InstantJob<ScheduleError>, { readonly type: "proactive" }>
      readonly interruptible: boolean
      readonly cancel: Deferred.Deferred<void>
    }
  | {
      readonly type: "scheduled"
      readonly job: Extract<InstantJob<ScheduleError>, { readonly type: "scheduled" }>
    }

interface ChannelEntry<Ctx, ScheduleError> {
  readonly pendingBatch: MessageBatch<Ctx> | undefined
  readonly instantQueue: ReadonlyArray<InstantJob<ScheduleError>>
  readonly active: ActiveTurn<Ctx, ScheduleError> | undefined
  readonly wakeDebounce: Deferred.Deferred<void> | undefined
}

type WorkerStep<Ctx, ScheduleError> =
  | { readonly kind: "stop" }
  | { readonly kind: "sleep"; readonly delayMs: number; readonly wake: Deferred.Deferred<void> }
  | {
      readonly kind: "message"
      readonly batch: MessageBatch<Ctx>
      readonly cancel: Deferred.Deferred<void>
    }
  | {
      readonly kind: "proactive"
      readonly job: Extract<InstantJob<ScheduleError>, { readonly type: "proactive" }>
      readonly cancel: Deferred.Deferred<void>
    }
  | {
      readonly kind: "scheduled"
      readonly job: Extract<InstantJob<ScheduleError>, { readonly type: "scheduled" }>
    }

type RacedTurnOutcome =
  | { readonly kind: "completed"; readonly exit: Exit.Exit<void> }
  | { readonly kind: "preempted" }

const appendMessages = (
  head: readonly [Message, ...Message[]],
  extra: ReadonlyArray<Message>,
): readonly [Message, ...Message[]] => [head[0], ...head.slice(1), ...extra]

const createBatch = <Ctx>(
  input: IncomingSubmission<Ctx>,
  config: DebounceConfig,
  done: Deferred.Deferred<void>,
): MessageBatch<Ctx> => ({
  key: input.key,
  presetId: input.presetId,
  context: input.context,
  messages: [input.message],
  trackedSenders: new Set([input.message.sender]),
  reason: input.reason,
  firstTriggeredAt: input.now,
  lastTrackedAt: input.now,
  capAt: input.now + config.maxDebounceMs,
  done,
})

const mergeIntoBatch = <Ctx>(
  batch: MessageBatch<Ctx>,
  bystanders: ReadonlyArray<Message>,
  input: IncomingSubmission<Ctx>,
  tracked: boolean,
  extendCapMs?: number,
): MessageBatch<Ctx> => {
  const messages = appendMessages(batch.messages, [...bystanders, input.message])
  if (!tracked) {
    return { ...batch, messages }
  }
  const trackedSenders = input.triggered
    ? new Set([...batch.trackedSenders, input.message.sender])
    : batch.trackedSenders
  return {
    ...batch,
    context: input.context,
    messages,
    trackedSenders,
    reason: batch.reason ?? input.reason,
    lastTrackedAt: input.now,
    capAt: extendCapMs === undefined ? batch.capAt : Math.max(batch.capAt, input.now + extendCapMs),
  }
}

export const makeChannelCoordinator = <Ctx, ScheduleError = never>(
  config: DebounceConfig,
  runner: ChannelTurnRunner<Ctx, ScheduleError>,
  spawn: (effect: Effect.Effect<void>) => Effect.Effect<unknown>,
): Effect.Effect<ChannelCoordinator<Ctx, ScheduleError>> =>
  Effect.gen(function* () {
    const states = yield* Ref.make<ReadonlyMap<ChannelId, ChannelEntry<Ctx, ScheduleError>>>(new Map())

    const makeTryEnterCommit = (channelId: ChannelId, cancel: Deferred.Deferred<void>): Effect.Effect<boolean> =>
      Ref.modify(states, (all) => {
        const entry = all.get(channelId)
        if (entry?.active === undefined || entry.active.type === "scheduled" || entry.active.cancel !== cancel) {
          return [false, all]
        }
        if (!entry.active.interruptible) {
          return [true, all]
        }
        const nextActive: ActiveTurn<Ctx, ScheduleError> =
          entry.active.type === "message"
            ? { ...entry.active, interruptible: false }
            : { ...entry.active, interruptible: false }
        return [true, new Map(all).set(channelId, { ...entry, active: nextActive })]
      })

    const selectNextStep = (channelId: ChannelId, currentMs: number): Effect.Effect<WorkerStep<Ctx, ScheduleError>> =>
      Ref.modify(
        states,
        (
          all,
        ): readonly [WorkerStep<Ctx, ScheduleError>, ReadonlyMap<ChannelId, ChannelEntry<Ctx, ScheduleError>>] => {
        const entry = all.get(channelId)
        if (entry === undefined) {
          return [{ kind: "stop" }, all]
        }
        if (entry.pendingBatch !== undefined) {
          const wakeAt = Math.min(entry.pendingBatch.capAt, entry.pendingBatch.lastTrackedAt + config.debounceMs)
          const delayMs = wakeAt - currentMs
          if (delayMs > 0) {
            const wake = Deferred.makeUnsafe<void>()
            const updated: ChannelEntry<Ctx, ScheduleError> = { ...entry, active: undefined, wakeDebounce: wake }
            return [{ kind: "sleep", delayMs, wake }, new Map(all).set(channelId, updated)]
          }
          const cancel = Deferred.makeUnsafe<void>()
          const batch = entry.pendingBatch
          const updated: ChannelEntry<Ctx, ScheduleError> = {
            ...entry,
            pendingBatch: undefined,
            wakeDebounce: undefined,
            active: { type: "message", batch, bystanders: [], interruptible: true, cancel },
          }
          return [{ kind: "message", batch, cancel }, new Map(all).set(channelId, updated)]
        }
        const firstJob = entry.instantQueue[0]
        if (firstJob !== undefined) {
          const rest = entry.instantQueue.slice(1)
          if (firstJob.type === "scheduled") {
            const updated: ChannelEntry<Ctx, ScheduleError> = {
              ...entry,
              instantQueue: rest,
              wakeDebounce: undefined,
              active: { type: "scheduled", job: firstJob },
            }
            return [{ kind: "scheduled", job: firstJob }, new Map(all).set(channelId, updated)]
          }
          const cancel = Deferred.makeUnsafe<void>()
          const updated: ChannelEntry<Ctx, ScheduleError> = {
            ...entry,
            instantQueue: rest,
            wakeDebounce: undefined,
            active: { type: "proactive", job: firstJob, interruptible: true, cancel },
          }
          return [{ kind: "proactive", job: firstJob, cancel }, new Map(all).set(channelId, updated)]
        }
        const next = new Map(all)
        next.delete(channelId)
        return [{ kind: "stop" }, next]
      })

    const finishInterruptibleTurn = (
      channelId: ChannelId,
      cancel: Deferred.Deferred<void>,
    ): Effect.Effect<boolean> =>
      Ref.modify(states, (all) => {
        const entry = all.get(channelId)
        if (entry?.active === undefined || entry.active.type === "scheduled" || entry.active.cancel !== cancel) {
          return [true, all]
        }
        return [false, new Map(all).set(channelId, { ...entry, active: undefined })]
      })

    const finishScheduledTurn = (channelId: ChannelId): Effect.Effect<void> =>
      Ref.update(states, (all) => {
        const entry = all.get(channelId)
        if (entry === undefined) return all
        return new Map(all).set(channelId, { ...entry, active: undefined })
      })

    const worker = (channelId: ChannelId): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const now = yield* DateTime.nowAsDate
          const step = yield* selectNextStep(channelId, now.getTime())
          if (step.kind === "stop") {
            return
          }
          if (step.kind === "sleep") {
            yield* Effect.raceFirst(Effect.sleep(`${step.delayMs} millis`), Deferred.await(step.wake))
            continue
          }
          if (step.kind === "scheduled") {
            const exit = yield* Effect.exit(runner.runScheduled(step.job.task))
            yield* finishScheduledTurn(channelId)
            yield* Deferred.done(step.job.done, exit)
            continue
          }
          if (step.kind === "proactive") {
            const tryEnterCommit = makeTryEnterCommit(channelId, step.cancel)
            const runTurn =
              step.job.source === "ambient"
                ? runner.runAmbient(step.job.trigger, tryEnterCommit)
                : runner.runProactive(step.job.trigger, tryEnterCommit)
            const raced = yield* Effect.raceFirst(
              Effect.exit(runTurn).pipe(Effect.map((exit): RacedTurnOutcome => ({ kind: "completed", exit }))),
              Deferred.await(step.cancel).pipe(Effect.map((): RacedTurnOutcome => ({ kind: "preempted" }))),
            )
            const preempted = yield* finishInterruptibleTurn(channelId, step.cancel)
            if (!preempted && raced.kind === "completed") {
              yield* Deferred.done(step.job.done, raced.exit)
            } else {
              yield* Deferred.succeed(step.job.done, void 0)
            }
            continue
          }
          const tryEnterCommit = makeTryEnterCommit(channelId, step.cancel)
          const raced = yield* Effect.raceFirst(
            Effect.exit(
              runner.runMessage(
                {
                  key: step.batch.key,
                  presetId: step.batch.presetId,
                  context: step.batch.context,
                  messages: step.batch.messages,
                  ...(step.batch.reason === undefined ? {} : { reason: step.batch.reason }),
                },
                tryEnterCommit,
              ),
            ).pipe(Effect.map((exit): RacedTurnOutcome => ({ kind: "completed", exit }))),
            Deferred.await(step.cancel).pipe(Effect.map((): RacedTurnOutcome => ({ kind: "preempted" }))),
          )
          const preempted = yield* finishInterruptibleTurn(channelId, step.cancel)
          if (!preempted && raced.kind === "completed") {
            yield* Deferred.done(step.batch.done, raced.exit)
          }
        }
      }).pipe(
        Effect.onInterrupt(() =>
          Ref.update(states, (all) => {
            const next = new Map(all)
            next.delete(channelId)
            return next
          }),
        ),
      )

    const submitInterruptible = (source: "next-reply" | "ambient", trigger: ProactiveTrigger): Effect.Effect<void> =>
      Effect.gen(function* () {
        const channelId = channelIdOf(trigger.channel)
        const decision = yield* Ref.modify(
          states,
          (
            all,
          ): readonly [
            { readonly startWorker: boolean; readonly wait: Deferred.Deferred<void> | undefined },
            ReadonlyMap<ChannelId, ChannelEntry<Ctx, ScheduleError>>,
          ] => {
            // 主动唤醒与旁听探头无需防抖；若频道已有待处理或执行中的回合，直接跳过
            if (all.has(channelId)) {
              return [{ startWorker: false, wait: undefined }, all]
            }
            const done = Deferred.makeUnsafe<void>()
            const created: ChannelEntry<Ctx, ScheduleError> = {
              pendingBatch: undefined,
              instantQueue: [{ type: "proactive", source, trigger, done }],
              active: undefined,
              wakeDebounce: undefined,
            }
            return [{ startWorker: true, wait: done }, new Map(all).set(channelId, created)]
          },
        )
        if (decision.startWorker) {
          yield* spawn(worker(channelId))
        }
        if (decision.wait !== undefined) {
          yield* Deferred.await(decision.wait)
        }
      })

    return {
      submitMessage: (input) =>
        Effect.gen(function* () {
          const channelId = channelIdOf(input.key)
          const decision = yield* Ref.modify(
            states,
            (
              all,
            ): readonly [
              {
                readonly startWorker: boolean
                readonly signal: Deferred.Deferred<void> | undefined
                readonly wait: Deferred.Deferred<void> | undefined
              },
              ReadonlyMap<ChannelId, ChannelEntry<Ctx, ScheduleError>>,
            ] => {
            const entry = all.get(channelId)
            // 频道空闲：仅当命中触发条件时创建批次并启动协调协程
            if (entry === undefined) {
              if (!input.triggered) {
                return [{ startWorker: false, signal: undefined, wait: undefined }, all]
              }
              const done = Deferred.makeUnsafe<void>()
              const batch = createBatch(input, config, done)
              const created: ChannelEntry<Ctx, ScheduleError> = {
                pendingBatch: batch,
                instantQueue: [],
                active: undefined,
                wakeDebounce: undefined,
              }
              return [{ startWorker: true, signal: undefined, wait: done }, new Map(all).set(channelId, created)]
            }

            // 正在对消息批次进行可中断推理：仅被跟踪的发言人追发或新触发消息才会打断重想
            if (entry.active?.type === "message" && entry.active.interruptible) {
              const shouldInterrupt = input.triggered || entry.active.batch.trackedSenders.has(input.message.sender)
              if (!shouldInterrupt) {
                const nextActive: ActiveTurn<Ctx, ScheduleError> = {
                  ...entry.active,
                  bystanders: [...entry.active.bystanders, input.message],
                }
                return [
                  { startWorker: false, signal: undefined, wait: undefined },
                  new Map(all).set(channelId, { ...entry, active: nextActive }),
                ]
              }
              const merged = mergeIntoBatch(
                entry.active.batch,
                entry.active.bystanders,
                input,
                true,
                config.debounceMs,
              )
              const updated: ChannelEntry<Ctx, ScheduleError> = {
                ...entry,
                pendingBatch: merged,
                active: undefined,
              }
              return [
                { startWorker: false, signal: entry.active.cancel, wait: merged.done },
                new Map(all).set(channelId, updated),
              ]
            }

            // 正在对主动沉默唤醒进行可中断推理：遇到明确触发消息时让位给用户对话
            if (entry.active?.type === "proactive" && entry.active.interruptible) {
              if (!input.triggered) {
                return [{ startWorker: false, signal: undefined, wait: undefined }, all]
              }
              const done = Deferred.makeUnsafe<void>()
              const batch = createBatch(input, config, done)
              const updated: ChannelEntry<Ctx, ScheduleError> = {
                ...entry,
                pendingBatch: batch,
                active: undefined,
              }
              return [
                { startWorker: false, signal: entry.active.cancel, wait: done },
                new Map(all).set(channelId, updated),
              ]
            }

            // 处于防抖阶段，或当前回合已进入不可中断提交/定时执行阶段
            if (entry.pendingBatch !== undefined) {
              const tracked = input.triggered || entry.pendingBatch.trackedSenders.has(input.message.sender)
              const merged = mergeIntoBatch(entry.pendingBatch, [], input, tracked)
              const updated: ChannelEntry<Ctx, ScheduleError> = {
                ...entry,
                pendingBatch: merged,
                wakeDebounce: tracked ? undefined : entry.wakeDebounce,
              }
              return [
                {
                  startWorker: false,
                  signal: tracked ? entry.wakeDebounce : undefined,
                  wait: tracked ? merged.done : undefined,
                },
                new Map(all).set(channelId, updated),
              ]
            }

            if (!input.triggered) {
              return [{ startWorker: false, signal: undefined, wait: undefined }, all]
            }
            const done = Deferred.makeUnsafe<void>()
            const batch = createBatch(input, config, done)
            return [
              { startWorker: false, signal: undefined, wait: done },
              new Map(all).set(channelId, { ...entry, pendingBatch: batch }),
            ]
          })

          if (decision.signal !== undefined) {
            yield* Deferred.succeed(decision.signal, void 0)
          }
          if (decision.startWorker) {
            yield* spawn(worker(channelId))
          }
          if (decision.wait !== undefined) {
            yield* Deferred.await(decision.wait)
          }
        }),

      submitProactive: (trigger) => submitInterruptible("next-reply", trigger),

      submitAmbient: (trigger) => submitInterruptible("ambient", trigger),

      submitScheduled: (key, task) =>
        Effect.gen(function* () {
          const channelId = channelIdOf(key)
          const done = Deferred.makeUnsafe<void, ScheduleError>()
          const startWorker = yield* Ref.modify(states, (all) => {
            const entry = all.get(channelId)
            const job: InstantJob<ScheduleError> = { type: "scheduled", task, done }
            if (entry === undefined) {
              const created: ChannelEntry<Ctx, ScheduleError> = {
                pendingBatch: undefined,
                instantQueue: [job],
                active: undefined,
                wakeDebounce: undefined,
              }
              return [true, new Map(all).set(channelId, created)]
            }
            return [false, new Map(all).set(channelId, { ...entry, instantQueue: [...entry.instantQueue, job] })]
          })
          if (startWorker) {
            yield* spawn(worker(channelId))
          }
          return yield* Deferred.await(done)
        }),
    }
  })

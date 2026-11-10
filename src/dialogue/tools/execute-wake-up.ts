import { Effect, Schema } from "effect"
import { InvalidReply } from "../invalid-reply"
import { type ChannelKey } from "../../channels/channel"
import { type ScheduleInput, type ScheduleTask } from "../../scheduling/schedule"
import { ScheduleNotFound } from "../../scheduling/store"
import { Scheduler } from "../../scheduling/scheduler"
import { WakeUpReplyPayload } from "./wake-up-payload"
import type { WakeUpToolArguments } from "./wake-up"

const describe = (task: ScheduleTask) =>
  Schema.decodeUnknownEffect(WakeUpReplyPayload)(task.payload).pipe(
    Effect.map((payload) => ({
      id: task.id,
      kind: task.kind,
      ...(task.kind === "cron" ? { cron: task.cron } : { at: task.at?.toISOString() ?? null }),
      timezone: task.timezone,
      text: payload.text,
      state: task.state,
      nextAt: task.nextAt?.toISOString() ?? null,
    })),
    Effect.mapError(() => new InvalidReply({ reason: "唤醒任务数据无效" })),
  )

const parseAt = (value: string) =>
  Effect.try({
    try: () => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
        throw new Error("timezone required")
      const at = new Date(value)
      if (Number.isNaN(at.getTime())) throw new Error("invalid date")
      return at
    },
    catch: () => new InvalidReply({ reason: "at 必须是带时区的 ISO 8601 时间" }),
  })

const target = ({ platform, channelId }: ChannelKey) => ({ platform, channelId })

const assertOwnership = (task: ScheduleTask, channel: ChannelKey) =>
  task.payload.type === "wake-up" &&
  task.payload.platform === channel.platform &&
  task.payload.channelId === channel.channelId
    ? Effect.void
    : Effect.fail(new ScheduleNotFound({ scheduleId: task.id }))

const scheduleInput = (
  channel: ChannelKey,
  timezone: string,
  args: Extract<WakeUpToolArguments, { operation: "create" | "update" }>,
): Effect.Effect<ScheduleInput, InvalidReply> =>
  Effect.gen(function* () {
    const payload = { type: "wake-up" as const, ...target(channel), text: args.text }
    return "at" in args
      ? { kind: "at", cron: "", at: yield* parseAt(args.at), timezone, payload }
      : { kind: "cron", cron: args.cron, at: null, timezone, payload }
  })

export const executeWakeUpTool = Effect.fn("executeWakeUpTool")(function* (
  channel: ChannelKey,
  timezone: string,
  args: WakeUpToolArguments,
) {
  const scheduler = yield* Scheduler
  const payload = { type: "wake-up" as const, ...target(channel) }
  switch (args.operation) {
    case "query": {
      const page = yield* scheduler.query({ ...args, payload })
      return { tasks: yield* Effect.forEach(page.tasks, describe), hasMore: page.hasMore }
    }
    case "create":
      return yield* describe(yield* scheduler.create(yield* scheduleInput(channel, timezone, args)))
    case "pause": {
      const task = yield* scheduler.get(args.id)
      yield* assertOwnership(task, channel)
      yield* scheduler.cancel(args.id)
      return { id: args.id, state: "paused" }
    }
    case "resume": {
      const task = yield* scheduler.get(args.id)
      yield* assertOwnership(task, channel)
      return yield* describe(yield* scheduler.update(args.id, task, true))
    }
    case "delete": {
      const task = yield* scheduler.get(args.id)
      yield* assertOwnership(task, channel)
      yield* scheduler.delete(args.id)
      return { id: args.id, deleted: true }
    }
    case "update": {
      const task = yield* scheduler.get(args.id)
      yield* assertOwnership(task, channel)
      return yield* describe(yield* scheduler.update(args.id, yield* scheduleInput(channel, timezone, args), true))
    }
  }
})

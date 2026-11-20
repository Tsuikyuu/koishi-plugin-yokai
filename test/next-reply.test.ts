import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Schema } from "effect"
import type { ChannelKey } from "../src/channels/channel"
import { Message } from "../src/channels/message"
import { NextReplyTtlMs, NextReplyTtlSeconds } from "../src/dialogue/next-reply/action"
import { ChannelTriggersLive } from "../src/dialogue/next-reply/track-triggers"
import { ChannelTriggers } from "../src/dialogue/next-reply/triggers"
import { decodeChannelResponse } from "../src/dialogue/response/parse-xml"

const channel: ChannelKey = { platform: "test", channelId: "room" }
const msg = (sender: string, time: number): Message =>
  Schema.decodeSync(Message)({
    id: `m-${sender}-${time}`,
    sender,
    time,
    parts: [{ type: "text", text: "hi" }],
  })

test("next-reply expires after 3 minutes for message_from_user and prunes stale entries on due()", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const triggers = yield* ChannelTriggers
      const start = 1_000_000

      // 3 分钟内有效
      yield* triggers.register(
        channel,
        [{ type: "next-reply", condition: "message_from_user", userId: "alice", group: "next-0" }],
        start,
      )
      const matched = yield* triggers.observeAndMatch(channel, msg("alice", start + NextReplyTtlMs - 1), start + NextReplyTtlMs - 1)
      assert.equal(matched, "收到用户 alice 的新消息")

      // 达到 3 分钟（180s）后过期失效，不再唤醒
      yield* triggers.register(
        channel,
        [{ type: "next-reply", condition: "message_from_user", userId: "alice", group: "next-0" }],
        start,
      )
      const expired = yield* triggers.observeAndMatch(channel, msg("alice", start + NextReplyTtlMs), start + NextReplyTtlMs)
      assert.equal(expired, undefined)

      // due() 也会在到达 3 分钟时清理已过期的 message_from_user 状态
      yield* triggers.register(
        channel,
        [{ type: "next-reply", condition: "message_from_user", userId: "alice", group: "next-0" }],
        start,
      )
      assert.deepEqual(yield* triggers.due(start + NextReplyTtlMs), [])
      assert.equal(
        yield* triggers.observeAndMatch(channel, msg("alice", start + NextReplyTtlMs - 10), start + NextReplyTtlMs - 10),
        undefined,
      )
    }).pipe(Effect.provide(ChannelTriggersLive)),
  )
})

test("next-reply silence expires at 3 minutes instead of being extended indefinitely by ongoing chat", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const triggers = yield* ChannelTriggers
      const start = 2_000_000

      // 群聊持续刷屏导致 60s 沉默被推到 3 分钟外：到达 3 分钟时自动过期作废
      yield* triggers.register(
        channel,
        [{ type: "next-reply", condition: "silence", userId: "all", seconds: 60, group: "next-0" }],
        start,
      )
      assert.equal(yield* triggers.observeAndMatch(channel, msg("bob", start + 150_000), start + 150_000), undefined)
      assert.deepEqual(yield* triggers.due(start + NextReplyTtlMs), [])
      assert.deepEqual(yield* triggers.due(start + 220_000), [])

      // 刚好 180s 全群沉默在 1s 轮询抖动后仍可正常触发
      yield* triggers.register(
        channel,
        [{ type: "next-reply", condition: "silence", userId: "all", seconds: NextReplyTtlSeconds, group: "next-0" }],
        start,
      )
      const boundary = yield* triggers.due(start + NextReplyTtlMs + 500)
      assert.equal(boundary.length, 1)
      assert.equal(boundary[0]?.reason, `连续 ${NextReplyTtlSeconds} 秒没有新消息`)

      // 指定具体用户的 silence 在 3 分钟内未发消息且未设 max_wait_seconds 时自动过期
      yield* triggers.register(
        channel,
        [{ type: "next-reply", condition: "silence", userId: "alice", seconds: 30, group: "next-0" }],
        start,
      )
      assert.deepEqual(yield* triggers.due(start + NextReplyTtlMs), [])
      assert.equal(yield* triggers.observeAndMatch(channel, msg("alice", start + NextReplyTtlMs + 1000), start + NextReplyTtlMs + 1000), undefined)
      assert.deepEqual(yield* triggers.due(start + NextReplyTtlMs + 40_000), [])

      // 指定具体用户的 silence 若设置了 max_wait_seconds=180，到达 180s 时仍按契约触发
      yield* triggers.register(
        channel,
        [
          {
            type: "next-reply",
            condition: "silence",
            userId: "alice",
            seconds: 30,
            maxWaitSeconds: NextReplyTtlSeconds,
            group: "next-0",
          },
        ],
        start,
      )
      const maxWait = yield* triggers.due(start + NextReplyTtlMs + 500)
      assert.equal(maxWait.length, 1)
    }).pipe(Effect.provide(ChannelTriggersLive)),
  )
})

test("next-reply XML schema rejects seconds and max_wait_seconds exceeding the 3-minute TTL", () => {
  assert.equal(NextReplyTtlSeconds, 180)
  assert.doesNotThrow(() =>
    decodeChannelResponse(
      `<response><think/><actions/><next-reply type="silence" user_id="all" seconds="${NextReplyTtlSeconds}" /></response>`,
    ),
  )
  assert.doesNotThrow(() =>
    decodeChannelResponse(
      `<response><think/><actions/><next-reply type="silence" user_id="u1" seconds="30" max_wait_seconds="${NextReplyTtlSeconds}" /></response>`,
    ),
  )
  assert.throws(() =>
    decodeChannelResponse(
      `<response><think/><actions/><next-reply type="silence" user_id="all" seconds="${NextReplyTtlSeconds + 1}" /></response>`,
    ),
  )
  assert.throws(() =>
    decodeChannelResponse(
      `<response><think/><actions/><next-reply type="silence" user_id="u1" seconds="30" max_wait_seconds="${NextReplyTtlSeconds + 1}" /></response>`,
    ),
  )
})

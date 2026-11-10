import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Exit, Schema, Semaphore } from "effect"
import { Bot, Context, h, Universal, type Session } from "koishi"
import sqlite from "@koishijs/plugin-database-sqlite"
import { channelIdOf, type Channel, type ChannelKey } from "../src/channels/channel"
import { CharacterId } from "../src/characters/character"
import { MessageAction } from "../src/channels/message-action"
import { ChannelPlatform } from "../src/channels/messaging"
import { createKoishiHistory, encodeAction } from "../src/channels/koishi-history"
import { registerHistoryModel } from "../src/channels/register-history"

interface Sent {
  readonly channelId: string
  readonly content: string
  readonly direct: boolean | undefined
  readonly guildId: string | undefined
  readonly referrer: unknown
}

// Bot<KoishiContext> hits an upstream invariant generic constraint under strict
// optional fields. Native registration gives us the framework's actual Bot type.
const addBot = (ctx: Context, id: string, sent: Sent[], disposers: Array<() => void>) => {
  let registered: Context["bots"][number] | undefined
  const fork = ctx.plugin((botContext) => {
    const created: unknown = Reflect.construct(Bot, [botContext, {}, "test-platform"])
    assert.ok(created instanceof Bot)
    const bot = botContext.bots.find((candidate) => candidate.sn === created.sn)
    assert.ok(bot)
    bot.user = { id, name: "Yokai" }
    bot.online()
    bot.sendMessage = async (channelId, content, referrer, options) => {
      sent.push({
        channelId,
        content: h.normalize(content).join(""),
        direct: options?.session?.isDirect,
        guildId: options?.session?.guildId,
        referrer,
      })
      return [`sent-${sent.length}`]
    }
    registered = bot
  })
  assert.ok(fork)
  disposers.push(() => fork.dispose())
  assert.ok(registered)
  return registered
}

const fixture = async () => {
  const app = new Context()
  app.plugin(sqlite, { path: ":memory:" })
  registerHistoryModel(app)
  const sent: Sent[] = []
  const disposers: Array<() => void> = []
  const bot = addBot(app, "bot", sent, disposers)
  let enabled = true
  const scope = app.intersect(() => enabled)
  await app.start()
  // Koishi 中间件在接收消息时建档并指定受理人；这里直接准备频道记录。
  const assign = (channelId: string) => app.database.createChannel("test-platform", channelId, { assignee: "bot" })
  const history = await Effect.runPromise(
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1)
      return yield* createKoishiHistory(scope, lock.withPermit)
    }),
  )
  const incoming = (id: string, direct = false, userId = "human", channelId = "room"): Session =>
    bot.session({
      type: "message",
      timestamp: 1000 + Number(id.replace(/\D/g, "") || "0"),
      user: { id: userId, name: "Human" },
      channel: { id: channelId, type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
      ...(direct ? {} : { guild: { id: "guild" } }),
      message: { id, content: `Message ${id}` },
      referrer: { source: "native-referrer" },
    })
  return {
    app,
    bot,
    history,
    incoming,
    assign,
    sent,
    enable: (value: boolean) => {
      enabled = value
    },
    addBot: () => addBot(app, "bot", sent, disposers),
    close: async () => {
      for (const dispose of [...disposers].reverse()) dispose()
      await app.lifecycle.flush()
      await app.stop()
    },
  }
}

const action = Schema.decodeSync(MessageAction)({ type: "message", text: "Hello" })
const channelFor = (key: ChannelKey): Channel => ({
  ...key,
  id: channelIdOf(key),
  presetId: Schema.decodeSync(CharacterId)("companion"),
  state: { emotion: "calm", condition: "well", activity: "reading", short_memory: "" },
})

test("incoming history excludes duplicate events and the triggering participant message", async () => {
  const f = await fixture()
  try {
    const first = await Effect.runPromise(f.history.recordIncoming(f.incoming("m1")))
    assert.ok(first)
    const session = f.incoming("m2")
    const second = await Effect.runPromise(f.history.recordIncoming(session))
    assert.ok(second)
    const boundChannel = channelFor(second.key)
    const view = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ChannelPlatform).history(boundChannel, { beforeMessageId: second.incoming.id, limit: 50 })
      }).pipe(Effect.provide(f.history.channelPlatform(session))),
    )
    assert.deepEqual(
      view.messages.map((message) => message.id),
      ["m1"],
    )
    assert.equal(view.participants.find((person) => person.id === "human")?.name, "Human")
    assert.equal(view.bot.id, "bot")
    assert.equal(await Effect.runPromise(f.history.recordIncoming(session)), undefined)
    assert.equal((await f.app.database.get("yokai_history", {})).length, 2)
  } finally {
    await f.close()
  }
})

test("native sessions preserve private, guild and referrer metadata when delivering replies", async () => {
  const f = await fixture()
  try {
    const groupSession = f.incoming("group", false, "human", "same-id")
    const privateSession = f.incoming("private", true, "human", "private:human")
    const group = await Effect.runPromise(f.history.recordIncoming(groupSession))
    const direct = await Effect.runPromise(f.history.recordIncoming(privateSession))
    assert.ok(group && direct)
    await f.assign("private:human")
    for (const [session, event] of [
      [groupSession, group],
      [privateSession, direct],
    ] as const) {
      const boundChannel = channelFor(event.key)
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* ChannelPlatform).send(boundChannel, action)
        }).pipe(Effect.provide(f.history.channelPlatform(session))),
      )
    }
    assert.deepEqual(f.sent, [
      {
        channelId: "same-id",
        content: "Hello",
        direct: false,
        guildId: "guild",
        referrer: { source: "native-referrer" },
      },
      {
        channelId: "private:human",
        content: "Hello",
        direct: true,
        guildId: undefined,
        referrer: { source: "native-referrer" },
      },
    ])
    const restored = await Effect.runPromise(f.history.sessionFor(direct.key))
    assert.ok(restored)
    assert.equal(restored.isDirect, true)
    assert.equal(restored.channelId, "private:human")
    assert.deepEqual(restored.event.referrer, { source: "native-referrer" })
    assert.equal((await f.app.database.get("yokai_history", { direction: "outgoing" })).length, 2)
  } finally {
    await f.close()
  }
})

test("scheduled sessions use the Koishi assignee bot and Koishi filters", async () => {
  const f = await fixture()
  try {
    const received = await Effect.runPromise(f.history.recordIncoming(f.incoming("m1")))
    assert.ok(received)
    assert.equal(await Effect.runPromise(f.history.sessionFor(received.key)), undefined)
    await f.assign("room")
    assert.ok(await Effect.runPromise(f.history.sessionFor(received.key)))
    f.enable(false)
    assert.equal(await Effect.runPromise(f.history.sessionFor(received.key)), undefined)
    f.enable(true)
    await f.bot.dispose()
    assert.equal(await Effect.runPromise(f.history.sessionFor(received.key)), undefined)
    const replacement = f.addBot()
    const reconnected = await Effect.runPromise(f.history.sessionFor(received.key))
    assert.ok(reconnected)
    assert.equal(reconnected.bot.sn, replacement.sn)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* ChannelPlatform).send(received.key, action)
      }).pipe(Effect.provide(f.history.channelPlatform(reconnected))),
    )
    assert.equal(f.sent.length, 1)
  } finally {
    await f.close()
  }
})

test("failed or unconfirmed native sends never enter participant history", async () => {
  const f = await fixture()
  try {
    const session = f.incoming("m1")
    const received = await Effect.runPromise(f.history.recordIncoming(session))
    assert.ok(received)
    const send = Effect.gen(function* () {
      yield* (yield* ChannelPlatform).send(received.key, action)
    }).pipe(Effect.provide(f.history.channelPlatform(session)))
    f.bot.sendMessage = async () => {
      throw new Error("transport failed")
    }
    assert.equal(Exit.isFailure(await Effect.runPromiseExit(send)), true)
    f.bot.sendMessage = async () => []
    assert.equal(Exit.isFailure(await Effect.runPromiseExit(send)), true)
    const rows = await f.app.database.get("yokai_history", {})
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.text, "Message m1")
  } finally {
    await f.close()
  }
})

test("message and scheduled contexts select the correct chronological participant window", async () => {
  const f = await fixture()
  try {
    for (let id = 0; id < 60; id++) await Effect.runPromise(f.history.recordIncoming(f.incoming(`m${id}`)))
    const session = f.incoming("m60")
    const received = await Effect.runPromise(f.history.recordIncoming(session))
    assert.ok(received)
    const [messageView, scheduledView] = await Effect.runPromise(
      Effect.gen(function* () {
        const platform = yield* ChannelPlatform
        return [
          yield* platform.history(received.key, { beforeMessageId: received.incoming.id, limit: 50 }),
          yield* platform.history(received.key, { beforeTime: 1040, limit: 50 }),
        ] as const
      }).pipe(Effect.provide(f.history.channelPlatform(session))),
    )
    assert.equal(messageView.messages.length, 50)
    assert.equal(messageView.messages[0]?.id, "m10")
    assert.equal(messageView.messages.at(-1)?.id, "m59")
    assert.equal(scheduledView.messages.length, 40)
    assert.equal(scheduledView.messages[0]?.id, "m0")
    assert.equal(scheduledView.messages.at(-1)?.id, "m39")
  } finally {
    await f.close()
  }
})

test("cancellation waits for a submitted native send to settle and prevents the following action", async () => {
  const f = await fixture()
  try {
    const session = f.incoming("m1")
    const received = await Effect.runPromise(f.history.recordIncoming(session))
    assert.ok(received)
    let deliver: ((ids: string[]) => void) | undefined
    const delivery = new Promise<string[]>((resolve) => {
      deliver = resolve
    })
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    let calls = 0
    f.bot.sendMessage = () => {
      calls++
      notifyStarted?.()
      return delivery
    }
    const controller = new AbortController()
    const executing = Effect.runPromiseExit(
      Effect.gen(function* () {
        const platform = yield* ChannelPlatform
        yield* platform.send(received.key, action)
        yield* platform.send(received.key, action)
      }).pipe(Effect.provide(f.history.channelPlatform(session))),
      { signal: controller.signal },
    )
    await started
    controller.abort()
    assert.ok(deliver)
    deliver(["confirmed-first"])
    const exit = await executing
    assert.equal(Exit.isFailure(exit), true)
    assert.equal(calls, 1)
    const rows = await f.app.database.get("yokai_history", { direction: "outgoing" })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.messageId, "confirmed-first")
  } finally {
    await f.close()
  }
})

test("model text stays plain text while an explicit quote remains a native quote", () => {
  const quoted = Schema.decodeSync(MessageAction)({
    type: "message",
    text: '<at id="all"/> & <image src="https://example.invalid/secret"/>',
    quote: 'quoted"id',
  })
  const elements = h.parse(h.normalize(encodeAction(quoted)).join(""))
  assert.deepEqual(
    elements.map((element) => element.type),
    ["quote", "text"],
  )
  assert.equal(elements[0]?.attrs.id, quoted.quote)
  assert.equal(elements[1]?.toString(true), quoted.text)
})

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import SQLite from "@koishijs/plugin-database-sqlite"
import { Bot, Context, h, HTTP, Universal } from "koishi"
import { Schema } from "effect"
import { stringify } from "yaml"
import * as yokai from "../src/index"
import type { Config } from "../src/config/schema"

// Effect's default environment provider takes one process snapshot; reuse one
// unique fixture key across the plugin restarts exercised by this test file.

const deferred = <A>() => {
  let resolve = (_value: A) => {}
  const promise = new Promise<A>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
const RequestBody = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
  tools: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  temperature: Schema.optionalKey(Schema.Number),
})
interface Call {
  readonly body: typeof RequestBody.Type
  readonly response: ServerResponse
  readonly closed: Promise<void>
}
const readRequest = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Schema.decodeUnknownSync(RequestBody)(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}
const complete = (call: Call, content: string) => {
  call.response.setHeader("Content-Type", "application/json")
  call.response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }))
}
const routine = JSON.stringify({ entries: [{ start: "00:00", end: "24:00", activity: "reading" }] })
const preset = (
  setting: string,
  aliases: readonly string[] = [
    "first",
    "second",
    "interrupted",
    "enabled",
    "disabled",
    "unsupported",
    "service",
    "schedule",
    "silence",
  ],
) => ({
  version: 1,
  character: {
    id: "companion",
    name: "Yokai",
    aliases,
    basicSetting: setting,
    detailedSetting: "",
    scene: "chat",
    style: "natural",
    guidance: [],
  },
  initialState: { emotion: "calm", condition: "well", activity: "reading", short_memory: "" },
})

const addBot = (ctx: Context, sent: string[]) => {
  let registered: Context["bots"][number] | undefined
  const fork = ctx.plugin((botContext) => {
    const created: unknown = Reflect.construct(Bot, [botContext, {}, "lifecycle-test"])
    assert.ok(created instanceof Bot)
    const bot = botContext.bots.find((candidate) => candidate.sn === created.sn)
    assert.ok(bot)
    bot.user = { id: "bot", name: "Yokai" }
    bot.online()
    bot.sendMessage = async (_channelId, content) => {
      sent.push(h.normalize(content).join(""))
      return [`sent-${sent.length}`]
    }
    registered = bot
  })
  assert.ok(registered)
  assert.ok(fork)
  return { bot: registered, fork }
}

const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "yokai-lifecycle-"))
  const filename = join(directory, "data/yokai/characters/companion.yml")
  await mkdir(join(directory, "data/yokai/characters"), { recursive: true })
  await writeFile(filename, stringify(preset("original-setting")))
  const calls: Call[] = []
  const firstRoutine = deferred<Call>()
  let pendingReply = deferred<Call>()
  let holdReply = false
  let replyHandler: ((call: Call) => void) | undefined
  const server = createServer((request, response) => {
    void readRequest(request)
      .then((body) => {
        const closed = deferred<void>()
        response.on("close", () => closed.resolve())
        const call: Call = { body, response, closed: closed.promise }
        calls.push(call)
        if (body.tools === undefined) {
          if (calls.length === 1) firstRoutine.resolve(call)
          else complete(call, routine)
        } else if (replyHandler) {
          replyHandler(call)
        } else if (holdReply) {
          pendingReply.resolve(call)
        } else {
          complete(
            call,
            `<response><think/><actions><message>reply ${body.model}</message></actions><status/></response>`,
          )
        }
      })
      .catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error("invalid test request")))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const ctx = new Context()
  ctx.baseDir = directory
  ctx.plugin(SQLite, { path: ":memory:" })
  const httpFork = ctx.plugin(HTTP)
  assert.ok(httpFork)
  const sent: string[] = []
  const { bot, fork: botFork } = addBot(ctx, sent)
  await ctx.start()
  t.after(async () => {
    botFork.dispose()
    await ctx.lifecycle.flush()
    await ctx.stop()
    await ctx.lifecycle.flush()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  const config: Config = {
    version: 1,
    timezone: "Asia/Shanghai",
    models: {
      default: "deepseek/model-a",
      deepseek: {
        apiKey: "fixture-secret",
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 10000,
      },
    },
    characters: { directory: "characters", presets: { companion: "companion.yml" } },
    roleplay: { character: "companion", debounceMs: 0 },
  }
  const incoming = (id: string, channelId: string) => {
    const session = bot.session({
      type: "message",
      timestamp: Date.now(),
      user: { id: "human", name: "Human" },
      channel: { id: channelId, type: Universal.Channel.Type.TEXT },
      guild: { id: "guild" },
      message: { id, content: id },
    })
    session.content = id
    return session
  }
  const receive = (id: string, channelId = "room") => {
    const session = incoming(id, channelId)
    return ctx.parallel(session, "message", session)
  }
  return {
    ctx,
    bot,
    config,
    calls,
    sent,
    filename,
    httpFork,
    firstRoutine,
    receive,
    blockReply: () => {
      holdReply = true
      pendingReply = deferred<Call>()
      return pendingReply.promise
    },
    allowReplies: () => {
      holdReply = false
    },
    handleReplies: (handler: (call: Call) => void) => {
      replyHandler = handler
    },
    hookCount: () => ctx.$processor._hooks.length,
  }
}

const trackIntervals = (t: TestContext) => {
  const active = new Set<unknown>()
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  t.mock.method(globalThis, "setInterval", (callback: () => void, delay?: number) => {
    const timer = originalSet(callback, delay)
    if (delay === 1000) active.add(timer)
    return timer
  })
  t.mock.method(globalThis, "clearInterval", (timer: Parameters<typeof clearInterval>[0]) => {
    active.delete(timer)
    originalClear(timer)
  })
  return active
}

test(
  "native plugin initializes before listening, reloads file/model snapshots, and fully disposes an active turn",
  { timeout: 20000 },
  async (t) => {
    const intervals = trackIntervals(t)
    const f = await fixture(t)
    const baselineHooks = f.hookCount()
    const baselineTimers = intervals.size
    const fork = f.ctx.plugin(yokai, f.config)
    assert.ok(fork)
    const startup = await Promise.race([
      f.firstRoutine.promise,
      f.ctx.lifecycle.flush().then(() => {
        assert.ifError(fork.error)
        assert.fail("startup completed without a routine request")
      }),
    ])
    assert.equal(f.hookCount(), baselineHooks)
    assert.equal(intervals.size, baselineTimers)
    await f.receive("before-ready")
    assert.equal(f.calls.length, 1)
    complete(startup, routine)
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)
    assert.equal(f.hookCount(), baselineHooks + 1)
    assert.equal(intervals.size, baselineTimers + 1)
    assert.deepEqual(await f.ctx.database.get("yokai_history", {}), [])

    await f.receive("first")
    assert.deepEqual(f.sent, ["reply model-a"])
    assert.ok(f.calls.at(-1)?.body.messages.some((message) => message.content.includes("original-setting")))
    await writeFile(f.filename, stringify(preset("edited-setting")))
    const provider = f.config.models.deepseek
    assert.ok(provider)
    const updated: Config = {
      ...f.config,
      models: { ...f.config.models, default: "deepseek/model-b", deepseek: { ...provider, temperature: 0.7 } },
    }
    fork.update(updated)
    await f.ctx.lifecycle.flush()
    await f.receive("second")
    assert.deepEqual(f.sent, ["reply model-a", "reply model-b"])
    assert.equal(f.calls.filter((call) => call.body.tools === undefined).length, 1)
    assert.equal(f.calls.at(-1)?.body.temperature, 0.7)
    assert.ok(f.calls.at(-1)?.body.messages.some((message) => message.content.includes("edited-setting")))
    assert.equal(f.hookCount(), baselineHooks + 1)
    assert.equal(intervals.size, baselineTimers + 1)

    const blocked = f.blockReply()
    const running = f.receive("interrupted")
    const request = await blocked
    fork.dispose()
    await request.closed
    await running
    await f.ctx.lifecycle.flush()
    assert.equal(f.hookCount(), baselineHooks)
    assert.equal(intervals.size, baselineTimers)
    const requestsAfterDispose = f.calls.length
    await f.receive("after-dispose")
    assert.equal(f.calls.length, requestsAfterDispose)
    assert.equal(f.sent.length, 2)
    const history = await f.ctx.database.get("yokai_history", {})
    assert.equal(history.filter((row) => row.direction === "outgoing").length, 2)
    assert.deepEqual(
      history.map((row) => row.text).sort(),
      ["first", "second", "interrupted", "reply model-a", "reply model-b"].sort(),
    )
  },
)

test(
  "routine configuration skips generation and context, and takes effect across plugin reloads",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t)
    const baselineHooks = f.hookCount()
    const disabled: Config = { ...f.config, roleplay: { ...f.config.roleplay, routineEnabled: false } }
    const fork = f.ctx.plugin(yokai, disabled)
    assert.ok(fork)
    await Promise.race([
      f.firstRoutine.promise.then(() => assert.fail("disabled routines must not generate at startup")),
      f.ctx.lifecycle.flush(),
    ])
    assert.ifError(fork.error)
    assert.equal(f.calls.length, 0)
    assert.equal(f.hookCount(), baselineHooks + 1)

    await f.receive("first-disabled")
    assert.deepEqual(f.sent, ["reply model-a"])
    const first = f.calls.at(-1)
    assert.ok(first)
    const firstContext = first.body.messages.map((message) => message.content).join("\n")
    assert.doesNotMatch(firstContext, /routine|current_activity|日程/)
    assert.match(firstContext, /wake-up/)
    assert.match(firstContext, /next-reply/)

    fork.update({ ...f.config, roleplay: { ...f.config.roleplay, routineEnabled: true } })
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)
    assert.equal(f.calls.filter((call) => call.body.tools === undefined).length, 1)
    assert.equal(f.hookCount(), baselineHooks + 1)
    await f.receive("enabled")
    const enabled = f.calls.at(-1)
    assert.ok(enabled)
    const enabledContext = enabled.body.messages.map((message) => message.content).join("\n")
    assert.match(enabledContext, /<daily_routine /)
    assert.match(enabledContext, /<current_activity>/)
    assert.match(enabledContext, /<routine start=/)

    fork.update(disabled)
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)
    assert.equal(f.calls.filter((call) => call.body.tools === undefined).length, 1)
    assert.equal(f.hookCount(), baselineHooks + 1)
    await f.receive("disabled-again")
    const last = f.calls.at(-1)
    assert.ok(last)
    assert.doesNotMatch(last.body.messages.map((message) => message.content).join("\n"), /routine|current_activity|日程/)
    assert.equal(f.sent.length, 3)

    f.handleReplies((call) => complete(
      call,
      '<response><think/><actions><routine start="11:30" end="14:00">walking</routine><message>changed</message></actions><status/></response>',
    ))
    await f.receive("unsupported-action")
    assert.equal(f.sent.length, 3)
    const history = await f.ctx.database.get("yokai_history", {})
    assert.equal(history.filter((row) => row.direction === "outgoing").length, 3)
    fork.dispose()
    await f.ctx.lifecycle.flush()
    assert.equal(f.hookCount(), baselineHooks)
  },
)

test(
  "removing and restoring the HTTP dependency cancels work and restores one native listener and timer",
  { timeout: 20000 },
  async (t) => {
    const intervals = trackIntervals(t)
    const f = await fixture(t)
    const baselineHooks = f.hookCount()
    const baselineTimers = intervals.size
    const fork = f.ctx.plugin(yokai, f.config)
    assert.ok(fork)
    const startup = await Promise.race([
      f.firstRoutine.promise,
      f.ctx.lifecycle.flush().then(() => {
        assert.ifError(fork.error)
        assert.fail("startup completed without a routine request")
      }),
    ])
    complete(startup, routine)
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)
    const blocked = f.blockReply()
    const running = f.receive("before-service-removal")
    const request = await blocked
    f.httpFork.dispose()
    await request.closed
    await running
    await f.ctx.lifecycle.flush()
    assert.equal(f.hookCount(), baselineHooks)
    assert.equal(intervals.size, baselineTimers)
    const suspendedCalls = f.calls.length
    await f.receive("while-suspended")
    assert.equal(f.calls.length, suspendedCalls)

    f.allowReplies()
    f.ctx.plugin(HTTP)
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)
    assert.equal(f.hookCount(), baselineHooks + 1)
    assert.equal(intervals.size, baselineTimers + 1)
    assert.equal(f.calls.filter((call) => call.body.tools === undefined).length, 2)
    await f.receive("after-service-restored")
    assert.deepEqual(f.sent, ["reply model-a"])
    assert.equal(f.calls.filter((call) => call.body.tools !== undefined).length, 2)
    fork.dispose()
    await f.ctx.lifecycle.flush()
    assert.equal(f.hookCount(), baselineHooks)
    assert.equal(intervals.size, baselineTimers)
  },
)

test(
  "disposing during routine initialization cancels acquisition without registering late work",
  { timeout: 20000 },
  async (t) => {
    const intervals = trackIntervals(t)
    const f = await fixture(t)
    const baselineHooks = f.hookCount()
    const baselineTimers = intervals.size
    const fork = f.ctx.plugin(yokai, f.config)
    assert.ok(fork)
    const startup = await Promise.race([
      f.firstRoutine.promise,
      f.ctx.lifecycle.flush().then(() => {
        assert.ifError(fork.error)
        assert.fail("startup completed without a routine request")
      }),
    ])
    fork.dispose()
    await startup.closed
    await f.ctx.lifecycle.flush()
    assert.equal(f.hookCount(), baselineHooks)
    assert.equal(intervals.size, baselineTimers)
    await f.receive("after-initialization-disposed")
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.sent, [])
    assert.deepEqual(await f.ctx.database.get("yokai_history", {}), [])
  },
)

test(
  "a slow scheduled turn does not block another channel's silence trigger, and background disposal is clean",
  { timeout: 8000 },
  async (t) => {
    const intervals = trackIntervals(t)
    const f = await fixture(t)
    const baselineHooks = f.hookCount()
    const baselineTimers = intervals.size
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    t.after(() => {
      process.off("unhandledRejection", onUnhandled)
    })
    const fork = f.ctx.plugin(yokai, f.config)
    assert.ok(fork)
    const startup = await Promise.race([
      f.firstRoutine.promise,
      f.ctx.lifecycle.flush().then(() => {
        assert.ifError(fork.error)
        assert.fail("startup completed without a routine request")
      }),
    ])
    complete(startup, routine)
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)

    const scheduledGate = deferred<Call>()
    const proactiveGate = deferred<Call>()
    f.handleReplies((call) => {
      const context = call.body.messages.find((message) => message.role === "user")?.content
      assert.ok(context)
      if (context.includes('<trigger reason="wake-up"')) {
        scheduledGate.resolve(call)
      } else if (context.includes('<trigger reason="next-reply"')) {
        proactiveGate.resolve(call)
      } else {
        complete(
          call,
          context.includes("arm-silence")
            ? '<response><think/><actions><next-reply type="silence" user_id="all" seconds="1" /></actions><status/></response>'
            : "<response><think/><actions/><status/></response>",
        )
      }
    })
    await f.receive("seed-schedule", "room-a")
    const [channelA] = await f.ctx.database.get("channel", { platform: "lifecycle-test", id: "room-a" })
    assert.equal(channelA?.yokaiPreset, "companion")
    const due = new Date()
    await f.ctx.database.create("yokai_schedule", {
      id: randomUUID(),
      kind: "at",
      cron: "",
      at: due,
      timezone: "Asia/Shanghai",
      payload: { type: "wake-up", platform: "lifecycle-test", channelId: "room-a", text: "scheduled turn" },
      nextAt: due,
      state: "enabled",
      revision: 1,
    })
    // Wait for the real Koishi interval to start A, then arm B while A's HTTP
    // response remains blocked. No timer advancement or sleeps drive this test.
    const scheduled = await scheduledGate.promise
    assert.ok(scheduled.body.messages.some((message) => message.content.includes("room-a")))
    await f.receive("arm-silence", "room-b")
    const proactive = await proactiveGate.promise
    assert.ok(proactive.body.messages.some((message) => message.content.includes("room-b")))
    assert.equal(scheduled.response.writableEnded, false)
    assert.equal(scheduled.response.destroyed, false)
    assert.equal(
      f.calls.filter((call) =>
        call.body.messages.some((message) => message.content.includes('<trigger reason="wake-up"')),
      ).length,
      1,
    )

    fork.dispose()
    await Promise.all([scheduled.closed, proactive.closed])
    await f.ctx.lifecycle.flush()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(f.hookCount(), baselineHooks)
    assert.equal(intervals.size, baselineTimers)
    assert.deepEqual(unhandled, [])
    assert.deepEqual(f.sent, [])
    const history = await f.ctx.database.get("yokai_history", {})
    assert.deepEqual(history.map((row) => row.text).sort(), ["arm-silence", "seed-schedule"])
  },
)

test(
  "group trigger gates control at, quote, name and name-prefix while preserving history, next-reply and private chat",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t)
    await writeFile(f.filename, stringify(preset("gate-test", ["小追求"])))
    const send = (options: {
      readonly id: string
      readonly content: string
      readonly userId?: string
      readonly direct?: boolean
      readonly quote?: { readonly id: string; readonly user?: { readonly id: string } }
    }) => {
      const session = f.bot.session({
        type: "message",
        timestamp: Date.now(),
        user: { id: options.userId ?? "human", name: "Human" },
        channel: {
          id: options.direct ? "private:human" : "room",
          type: options.direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT,
        },
        ...(options.direct ? {} : { guild: { id: "guild" } }),
        message: {
          id: options.id,
          content: options.content,
        },
      })
      session.content = options.content
      if (options.quote && session.event.message) {
        session.event.message.quote = options.quote
      }
      return f.ctx.parallel(session, "message", session)
    }

    const baseRoleplay = {
      character: "companion",
      routineEnabled: false,
      triggerOnAt: false,
      triggerOnQuote: false,
      triggerOnName: false,
      triggerOnNamePrefix: false,
      debounceMs: 0,
    }
    const fork = f.ctx.plugin(yokai, {
      ...f.config,
      roleplay: { ...baseRoleplay, triggerOnAt: true },
    })
    assert.ok(fork)
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)

    // 未命中任何门控的普通群消息只写入历史，不触发模型调用
    await send({ id: "m-ignored", content: "今天天气不错" })
    assert.equal(f.calls.length, 0)
    assert.equal((await f.ctx.database.get("yokai_history", { messageId: "m-ignored" })).length, 1)

    // @ 其他群友不触发，@ 机器人触发
    await send({ id: "m-at-other", content: '<at id="other"/> 你好' })
    assert.equal(f.calls.length, 0)
    await send({ id: "m-at-bot", content: '<at id="bot"/> 你好' })
    assert.equal(f.calls.length, 1)
    assert.equal(f.sent.length, 1)

    // 仅开启 quote 触发：引用人类消息不触发，引用机器人已发送消息（sent-1）触发
    fork.update({
      ...f.config,
      roleplay: { ...baseRoleplay, triggerOnQuote: true },
    })
    await f.ctx.lifecycle.flush()
    await send({ id: "m-quote-at-disabled", content: '<at id="bot"/> 只开了引用触发' })
    assert.equal(f.calls.length, 1)
    await send({ id: "m-quote-human", content: "引用别人", quote: { id: "m-ignored" } })
    assert.equal(f.calls.length, 1)
    await send({ id: "m-quote-bot", content: "引用机器人", quote: { id: "sent-1" } })
    assert.equal(f.calls.length, 2)

    // 仅开启名称开头触发：句中提及不触发，开头提及角色名或别名触发
    fork.update({
      ...f.config,
      roleplay: { ...baseRoleplay, triggerOnNamePrefix: true },
    })
    await f.ctx.lifecycle.flush()
    await send({ id: "m-name-middle", content: "刚才小追求说了什么" })
    assert.equal(f.calls.length, 2)
    await send({ id: "m-name-prefix", content: "  小追求今天吃什么" })
    assert.equal(f.calls.length, 3)

    // 仅开启名称包含触发：句中提及触发，并在回复中注册针对 human 的 next-reply
    f.handleReplies((call) =>
      complete(
        call,
        '<response><think/><actions><next-reply type="message_from_user" user_id="human" /><message>等你下一句</message></actions><status/></response>',
      ),
    )
    fork.update({
      ...f.config,
      roleplay: { ...baseRoleplay, triggerOnName: true },
    })
    await f.ctx.lifecycle.flush()
    await send({ id: "m-name-contains", content: "问问Yokai的意见" })
    assert.equal(f.calls.length, 4)

    // 即使四个门控全部关闭，其他群友插话不会清空 next-reply，目标用户下一条消息仍可触发；私聊也不受门控限制
    f.handleReplies((call) =>
      complete(call, "<response><think/><actions><message>收到后续</message></actions><status/></response>"),
    )
    fork.update({
      ...f.config,
      roleplay: baseRoleplay,
    })
    await f.ctx.lifecycle.flush()
    // 先重新在当前实例注册一次 next-reply（插件重载会重建内存触发器）
    fork.update({
      ...f.config,
      roleplay: { ...baseRoleplay, triggerOnAt: true },
    })
    await f.ctx.lifecycle.flush()
    f.handleReplies((call) =>
      complete(
        call,
        '<response><think/><actions><next-reply type="message_from_user" user_id="human" /></actions><status/></response>',
      ),
    )
    await send({ id: "m-arm-next", content: '<at id="bot"/> 我有话说' })
    assert.equal(f.calls.length, 5)
    f.handleReplies((call) =>
      complete(call, "<response><think/><actions><message>接上话了</message></actions><status/></response>"),
    )
    await send({ id: "m-bystander", content: "路人插话", userId: "other" })
    assert.equal(f.calls.length, 5)
    await send({ id: "m-followup", content: "这是我的下半句话", userId: "human" })
    assert.equal(f.calls.length, 6)

    // 四个群聊门控全关时，私聊消息照常触发
    fork.update({
      ...f.config,
      roleplay: baseRoleplay,
    })
    await f.ctx.lifecycle.flush()
    await send({ id: "m-direct", content: "私聊不看群门控", direct: true })
    assert.equal(f.calls.length, 7)

    // 校验提示词中已包含 next-reply 使用时机说明且不含旧版误导描述
    const groupCallText = f.calls[0]?.body.messages.map((item) => item.content).join("\n") ?? ""
    assert.match(groupCallText, /普通闲聊默认不会唤醒你/)
    assert.doesNotMatch(groupCallText, /每条消息都会生成回合/)

    // 校验 next-reply 拒绝填写机器人自身或不在上下文中的无效 user_id（整轮不发出前序消息）
    const sentBeforeInvalid = f.sent.length
    f.handleReplies((call) =>
      complete(
        call,
        '<response><think/><actions><message>这句不该发出</message><next-reply type="message_from_user" user_id="bot" /></actions><status/></response>',
      ),
    )
    await send({ id: "m-invalid-bot-target", content: "测试填机器人自己ID", direct: true })
    assert.equal(f.sent.length, sentBeforeInvalid)

    f.handleReplies((call) =>
      complete(
        call,
        '<response><think/><actions><message>这句也不该发出</message><next-reply type="message_from_user" user_id="Human" /></actions><status/></response>',
      ),
    )
    await send({ id: "m-invalid-nickname-target", content: "测试填昵称而非ID", direct: true })
    assert.equal(f.sent.length, sentBeforeInvalid)

    fork.dispose()
    await f.ctx.lifecycle.flush()
  },
)

test(
  "debounce waits only for tracked speakers, preempts unsent thinking on tracked follow-up, and runs proactive turns immediately",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t)
    await writeFile(f.filename, stringify(preset("debounce-test", ["小追求"])))
    const send = (options: { readonly id: string; readonly content: string; readonly userId?: string }) => {
      const session = f.bot.session({
        type: "message",
        timestamp: Date.now(),
        user: { id: options.userId ?? "alice", name: options.userId ?? "Alice" },
        channel: { id: "room", type: Universal.Channel.Type.TEXT },
        guild: { id: "guild" },
        message: { id: options.id, content: options.content },
      })
      session.content = options.content
      return f.ctx.parallel(session, "message", session)
    }

    const fork = f.ctx.plugin(yokai, {
      ...f.config,
      roleplay: {
        character: "companion",
        routineEnabled: false,
        triggerOnAt: true,
        triggerOnQuote: true,
        triggerOnName: true,
        triggerOnNamePrefix: true,
        debounceMs: 120,
        maxDebounceMs: 600,
      },
    })
    assert.ok(fork)
    await f.ctx.lifecycle.flush()
    assert.ifError(fork.error)

    // 1. 提及者连发多条消息时合并为单次生成；路人插话不延长防抖但保留在批次序列中
    const firstTurn = send({ id: "d1", content: '<at id="bot"/>' })
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    await send({ id: "d2", content: "路人插一句无关的话", userId: "bystander" })
    const followUpTurn = send({ id: "d3", content: "我想问今天吃什么" })
    await Promise.all([firstTurn, followUpTurn])
    assert.equal(f.calls.length, 1)
    assert.equal(f.sent.length, 1)
    const mergedUserPrompt = f.calls[0]?.body.messages.find((item) => item.role === "user")?.content ?? ""
    assert.match(
      mergedUserPrompt,
      /<incoming>[\s\S]*id="d1"[\s\S]*id="d2"[\s\S]*id="d3"[\s\S]*<\/incoming>/,
    )

    // 2. 正在思考（尚未发送消息）时：路人说话不打断，提及者追发则中断旧请求并合并重新生成
    const inFlight = deferred<Call>()
    const rebuilt = deferred<Call>()
    let turnCallCount = 0
    f.handleReplies((call) => {
      turnCallCount++
      if (turnCallCount === 1) {
        inFlight.resolve(call)
      } else {
        rebuilt.resolve(call)
      }
    })
    const partOne = send({ id: "p1", content: '<at id="bot"/> 我先说上半句' })
    const firstCall = await inFlight.promise
    // 路人在模型思考期间发言：不应中断当前 HTTP 请求
    await send({ id: "p2", content: "路人路过", userId: "bystander" })
    assert.equal(firstCall.response.destroyed, false)
    // 提及者继续追发下半句：立即中断未发出的旧请求，防抖后合并为新请求
    const partTwo = send({ id: "p3", content: "这是补充的下半句" })
    await firstCall.closed
    const secondCall = await rebuilt.promise
    const rebuiltPrompt = secondCall.body.messages.find((item) => item.role === "user")?.content ?? ""
    assert.match(
      rebuiltPrompt,
      /<incoming>[\s\S]*id="p1"[\s\S]*id="p2"[\s\S]*id="p3"[\s\S]*<\/incoming>/,
    )
    complete(
      secondCall,
      '<response><think/><actions><next-reply type="silence" user_id="all" seconds="1" /><message quote="p3">听完了</message></actions><status/></response>',
    )
    await Promise.all([partOne, partTwo])
    assert.equal(f.sent.length, 2)

    // 3. 主动唤醒（如 silence 到期）在开启 2500ms 防抖时无需防抖，满 1 秒即直接进入生成
    const proactiveCall = deferred<Call>()
    f.handleReplies((call) => {
      const prompt = call.body.messages.find((item) => item.role === "user")?.content ?? ""
      if (prompt.includes('<trigger reason="next-reply"')) {
        proactiveCall.resolve(call)
      } else {
        complete(
          call,
          '<response><think/><actions><next-reply type="silence" user_id="all" seconds="1" /></actions><status/></response>',
        )
      }
    })
    fork.update({
      ...f.config,
      roleplay: {
        character: "companion",
        routineEnabled: false,
        debounceMs: 2500,
        maxDebounceMs: 8000,
      },
    })
    await f.ctx.lifecycle.flush()
    await send({ id: "s1", content: '<at id="bot"/> 等我沉默一秒' })
    const silenceStartedAt = Date.now()
    const proactive = await proactiveCall.promise
    assert.ok(Date.now() - silenceStartedAt < 2300)
    complete(proactive, "<response><think/><actions><message>冒泡</message></actions><status/></response>")

    fork.dispose()
    await f.ctx.lifecycle.flush()
  },
)

test(
  "plugin startup and bot reconnect backfill missed channel messages into model history without replying to offline messages",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t)
    await writeFile(f.filename, stringify(preset("sync-test", ["小追求"])))
    const roleplayConfig: Config = {
      ...f.config,
      roleplay: {
        character: "companion",
        routineEnabled: false,
        debounceMs: 0,
      },
    }

    // 第一阶段：启动插件并完成首轮交互，使频道 room 绑定角色并记录初始历史
    const firstFork = f.ctx.plugin(yokai, roleplayConfig)
    assert.ok(firstFork)
    await f.ctx.lifecycle.flush()
    assert.ifError(firstFork.error)

    const send = (id: string, content: string, timestamp: number) => {
      const session = f.bot.session({
        type: "message",
        timestamp,
        user: { id: "human", name: "Human" },
        channel: { id: "room", type: Universal.Channel.Type.TEXT },
        guild: { id: "guild" },
        message: { id, content },
      })
      session.content = content
      return f.ctx.parallel(session, "message", session)
    }

    await send("m-before", '<at id="bot"/> 我先去睡了', 1000)
    assert.equal(f.calls.length, 1)
    assert.equal(f.sent.length, 1)

    // 关闭插件，模拟停机期间群内产生包含提及机器人的多条新消息
    firstFork.dispose()
    await f.ctx.lifecycle.flush()

    let syncedNotify = deferred<void>()
    let platformHistory: Universal.Message[] = [
      { id: "m-before", content: '<at id="bot"/> 我先去睡了', timestamp: 1000, user: { id: "human", name: "Human" } },
      { id: "sent-1", content: "reply model-a", timestamp: 1001, user: { id: "bot", name: "Yokai" } },
      { id: "m-offline-1", content: "半夜房间着火了", timestamp: 2000, user: { id: "alice", name: "Alice" } },
      { id: "m-offline-2", content: '<at id="bot"/> 救命', timestamp: 2001, user: { id: "alice", name: "Alice" } },
    ]
    f.bot.getMessageList = async (channelId) => {
      assert.equal(channelId, "room")
      queueMicrotask(() => syncedNotify.resolve())
      return { data: platformHistory }
    }

    // 第二阶段：重启插件，自动补齐停机期间消息，但不对离线旧消息触发回复
    const secondFork = f.ctx.plugin(yokai, roleplayConfig)
    assert.ok(secondFork)
    await f.ctx.lifecycle.flush()
    assert.ifError(secondFork.error)
    await syncedNotify.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assert.equal(f.calls.length, 1)
    assert.equal(f.sent.length, 1)

    // 第三阶段：模拟机器人断线期间又产生新消息，重连上线后再次补齐
    f.bot.offline()
    syncedNotify = deferred<void>()
    platformHistory = [
      ...platformHistory,
      { id: "m-reconnect-gap", content: "幸好火已经扑灭了", timestamp: 3000, user: { id: "alice", name: "Alice" } },
    ]
    f.bot.online()
    await syncedNotify.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assert.equal(f.calls.length, 1)

    // 发送在线新消息触发回合，模型上下文应完整包含停机期间和断线期间的所有消息
    await send("m-wakeup", '<at id="bot"/> 早上好', 4000)
    assert.equal(f.calls.length, 2)
    const userPrompt = f.calls[1]?.body.messages.find((item) => item.role === "user")?.content ?? ""
    assert.match(
      userPrompt,
      /<history>[\s\S]*id="m-before"[\s\S]*id="sent-1"[\s\S]*id="m-offline-1"[\s\S]*半夜房间着火了[\s\S]*id="m-offline-2"[\s\S]*id="m-reconnect-gap"[\s\S]*幸好火已经扑灭了[\s\S]*<\/history>/,
    )

    secondFork.dispose()
    await f.ctx.lifecycle.flush()
  },
)

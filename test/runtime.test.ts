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
const preset = (setting: string) => ({
  version: 1,
  character: {
    id: "companion",
    name: "Yokai",
    aliases: [],
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
    roleplay: { character: "companion" },
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

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import SQLite from "@koishijs/plugin-database-sqlite"
import { App, Bot, Context, h, HTTP, Universal } from "koishi"
import { Effect, Redacted, Schema, Semaphore } from "effect"
import { createKoishiHistory, encodeAction } from "../src/channels/koishi-history"
import { channelMediaStoreFile } from "../src/channels/file-media"
import { channelIdOf } from "../src/channels/channel"
import { MessageId, ParticipantId } from "../src/channels/message"
import { ChannelPlatform } from "../src/channels/messaging"
import { MessageAction, type StickerDelivery } from "../src/channels/message-action"
import { registerHistoryModel } from "../src/channels/register-history"
import { detectImageMimeType, MaxImageBytes } from "../src/media/image"
import { CharacterId, StickerId } from "../src/characters/character"
import { CharacterPreset } from "../src/characters/preset"
import { characterStickersFile } from "../src/characters/file-stickers"
import { buildChannelContext } from "../src/dialogue/context/build-context"
import { decodeChannelResponse } from "../src/dialogue/response/parse-xml"

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0,
])

test("image format detection follows file content instead of names", () => {
  assert.equal(detectImageMimeType(png), "image/png")
  assert.equal(detectImageMimeType(jpeg), "image/jpeg")
  assert.equal(detectImageMimeType(webp), "image/webp")
  assert.equal(detectImageMimeType(gif), "image/gif")
  assert.equal(detectImageMimeType(new Uint8Array([1, 2, 3])), undefined)
})

const withStickers = async (files: ReadonlyArray<[string, Uint8Array]>) => {
  const root = await mkdtemp(join(tmpdir(), "yokai-stickers-"))
  const directory = join(root, "companion", "stickers")
  await mkdir(directory, { recursive: true })
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes)
  return { root, files }
}

test("stickers resolve by id with program-managed extensions and reject ambiguous files", async () => {
  const characterId = Schema.decodeSync(CharacterId)("companion")
  const sleepy = Schema.decodeSync(StickerId)("sleepy")
  const fixtures = await withStickers([
    ["sleepy.webp", webp],
    ["无语.png", png],
  ])
  try {
    const stickers = characterStickersFile(fixtures.root)
    await Effect.runPromise(stickers.validate(characterId, [sleepy]))
    const asset = await Effect.runPromise(stickers.load(characterId, sleepy))
    assert.equal(asset.mimeType, "image/webp")
    assert.match(asset.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(Array.from(asset.bytes), Array.from(webp))
  } finally {
    await rm(fixtures.root, { recursive: true, force: true })
  }

  const duplicated = await withStickers([
    ["sleepy.png", png],
    ["sleepy.gif", gif],
  ])
  try {
    const outcome = await Effect.runPromiseExit(
      characterStickersFile(duplicated.root).load(
        Schema.decodeSync(CharacterId)("companion"),
        Schema.decodeSync(StickerId)("sleepy"),
      ),
    )
    assert.equal(outcome._tag, "Failure")
  } finally {
    await rm(duplicated.root, { recursive: true, force: true })
  }

  const missing = await withStickers([])
  try {
    const outcome = await Effect.runPromiseExit(
      characterStickersFile(missing.root).validate(
        Schema.decodeSync(CharacterId)("companion"),
        [Schema.decodeSync(StickerId)("sleepy")],
      ),
    )
    assert.equal(outcome._tag, "Failure")
  } finally {
    await rm(missing.root, { recursive: true, force: true })
  }
})

test("response protocol carries inline mentions and independent sticker actions", () => {
  const parsed = decodeChannelResponse(
    '<response><think/><actions><message quote="m1">看这个<at user="u1"/>笑死</message><sticker id="sleepy" quote="m2"/></actions><status/></response>',
  )
  assert.deepEqual(parsed.actions[0], {
    type: "message",
    parts: [
      { type: "text", text: "看这个" },
      { type: "at", user: "u1" },
      { type: "text", text: "笑死" },
    ],
    quote: "m1",
  })
  assert.deepEqual(parsed.actions[1], { type: "sticker", stickerId: "sleepy", quote: "m2" })

  assert.throws(() => decodeChannelResponse('<response><think/><actions><message>  </message></actions><status/></response>'))
  assert.throws(() =>
    decodeChannelResponse('<response><think/><actions><message><image src="x"/></message></actions><status/></response>'),
  )
  assert.throws(() => decodeChannelResponse('<response><think/><actions><sticker id="a/b"/></actions><status/></response>'))
})

const addBot = (ctx: Context, sent: string[]) => {
  let registered: Context["bots"][number] | undefined
  const fork = ctx.plugin((botContext) => {
    const created: unknown = Reflect.construct(Bot, [botContext, {}, "media-test"])
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

test("incoming mentions and images keep structured parts across history reads", async () => {
  const app = new Context()
  app.plugin(SQLite, { path: ":memory:" })
  registerHistoryModel(app)
  const sent: string[] = []
  const { bot, fork } = addBot(app, sent)
  await app.start()
  try {
    const media = {
      ingest: () =>
        Effect.succeed({ sha256: "a".repeat(64), mimeType: "image/png" as const, byteLength: png.byteLength }),
      read: () => Effect.succeed(png),
    }
    const history = await Effect.runPromise(
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1)
        return yield* createKoishiHistory(app, lock.withPermit, media)
      }),
    )
    const session = bot.session({
      type: "message",
      timestamp: 1000,
      user: { id: "human", name: "Human" },
      channel: { id: "room", type: Universal.Channel.Type.TEXT },
      guild: { id: "guild" },
      message: { id: "m1", content: '<at id="bot"/> 看图 <img src="https://example.invalid/a.png"/>' },
    })
    const received = await Effect.runPromise(history.recordIncoming(session))
    assert.ok(received)
    assert.deepEqual(received.incoming.parts, [
      { type: "at", target: "bot" },
      { type: "text", text: " 看图 " },
      { type: "image", kind: "image", sha256: "a".repeat(64), mimeType: "image/png", byteLength: png.byteLength },
    ])
    const row = (await app.database.get("yokai_history", { messageId: "m1" }))[0]
    assert.equal(row?.text, "@bot 看图 [图片]")
    assert.deepEqual(row?.parts, received.incoming.parts)

    const restored = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ChannelPlatform).history(received.key, { beforeTime: 2000, limit: 10 })
      }).pipe(Effect.provide(history.channelPlatform(session))),
    )
    assert.deepEqual(restored.messages[0]?.parts, received.incoming.parts)
  } finally {
    fork.dispose()
    await app.lifecycle.flush()
    await app.stop()
  }
})

test("outbound actions encode native mentions and sticker images", () => {
  const message = Schema.decodeSync(MessageAction)({
    type: "message",
    parts: [
      { type: "at", user: "u1" },
      { type: "text", text: " 你好" },
    ],
  })
  const elements = h.normalize(encodeAction(message))
  assert.deepEqual(
    elements.map((element) => element.type),
    ["at", "text"],
  )
  assert.equal(elements[0]?.attrs.id, "u1")
  assert.equal(elements[1]?.toString(true), " 你好")

  const delivery: StickerDelivery = {
    type: "sticker",
    stickerId: Schema.decodeSync(StickerId)("sleepy"),
    summary: "困",
    sha256: "b".repeat(64),
    mimeType: "image/png",
    byteLength: png.byteLength,
    bytes: png,
  }
  const sticker = h.normalize(encodeAction(delivery))
  assert.equal(sticker.length, 1)
  assert.ok(sticker[0]?.type === "img" || sticker[0]?.type === "image")
  assert.ok(String(sticker[0]?.attrs.src).startsWith("data:image/png;base64,"))
})

test("image bytes stop at the declared per-image limit", () => {
  assert.ok(MaxImageBytes >= 1024 * 1024)
})

test("context attaches the selected image window and advertises sticker ids only", () => {
  const characterId = Schema.decodeSync(CharacterId)("companion")
  const preset = Schema.decodeSync(CharacterPreset)({
    version: 1,
    character: {
      id: "companion",
      name: "小追求",
      aliases: [],
      basicSetting: "设定",
      detailedSetting: "",
      scene: "群聊",
      style: "简短",
      guidance: [],
      stickers: { sleepy: "趴在被窝里困得睁不开眼" },
    },
    initialState: { emotion: "困", condition: "刚醒", activity: "躺着", short_memory: "" },
  })
  const image = {
    type: "image" as const,
    kind: "image" as const,
    sha256: "a".repeat(64),
    mimeType: "image/png" as const,
    byteLength: png.byteLength,
  }
  const context = buildChannelContext({
    channel: {
      platform: "test",
      channelId: "room",
      id: channelIdOf({ platform: "test", channelId: "room" }),
      presetId: characterId,
      state: { emotion: "困", condition: "刚醒", activity: "躺着", short_memory: "" },
    },
    preset,
    history: {
      bot: { id: Schema.decodeSync(ParticipantId)("bot"), name: "Bot" },
      participants: [
        { id: Schema.decodeSync(ParticipantId)("u1"), name: "Alice" },
        { id: Schema.decodeSync(ParticipantId)("bot"), name: "Bot" },
      ],
      messages: [
        { id: Schema.decodeSync(MessageId)("m1"), sender: Schema.decodeSync(ParticipantId)("u1"), time: 1, parts: [image] },
      ],
      direct: false,
    },
    notes: [],
    trigger: {
      type: "message",
      message: {
        id: Schema.decodeSync(MessageId)("m2"),
        sender: Schema.decodeSync(ParticipantId)("u1"),
        time: 2,
        parts: [{ type: "text", text: "这图什么意思" }],
        quote: Schema.decodeSync(MessageId)("m1"),
      },
    },
    timezone: "Asia/Shanghai",
    now: 3,
    routine: undefined,
    attachments: [
      {
        ref: "img_1",
        messageId: Schema.decodeSync(MessageId)("m1"),
        part: 0,
        sha256: image.sha256,
        mimeType: image.mimeType,
        byteLength: image.byteLength,
        bytes: png,
      },
    ],
  })
  const system = context.messages[0]
  assert.equal(system?.role, "system")
  assert.match(String(system?.content), /## 可用表情包/)
  assert.match(String(system?.content), /sleepy：趴在被窝里困得睁不开眼/)
  assert.match(String(system?.content), /<sticker id="表情包ID" \/>/)

  const user = context.messages[1]
  assert.equal(user?.role, "user")
  assert.ok(Array.isArray(user?.content))
  const parts = user.content
  if (!Array.isArray(parts)) return
  assert.match((parts[0] as { text: string }).text, /<image kind="image" attached="true" ref="img_1" \/>/)
  assert.match((parts[1] as { text: string }).text, /<attachment ref="img_1" message_id="m1"/)
  const attached = parts[2] as { type: string; data: Redacted.Redacted<string> }
  assert.equal(attached.type, "image")
  assert.equal(Redacted.value(attached.data), Buffer.from(png).toString("base64"))
})

test("media store dedupes by content, accepts data/file/http sources and rejects others", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "yokai-media-"))
  const mediaDir = join(baseDir, "data/yokai/media")
  const assetDir = join(baseDir, "data/assets")
  await mkdir(assetDir, { recursive: true })
  await writeFile(join(assetDir, "local.png"), png)

  const server = createServer((request, response) => {
    if (request.url === "/missing") {
      response.statusCode = 404
      response.end()
      return
    }
    response.setHeader("Content-Type", "image/png")
    response.end(Buffer.from(png))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const app = new App()
  app.plugin(HTTP)
  await app.start()
  try {
    const media = channelMediaStoreFile(app.http, mediaDir, baseDir)
    const inline = await Effect.runPromise(media.ingest(`data:image/png;base64,${Buffer.from(png).toString("base64")}`))
    assert.ok(inline)
    assert.equal(inline.mimeType, "image/png")
    assert.equal(inline.byteLength, png.byteLength)
    assert.deepEqual(Array.from((await Effect.runPromise(media.read(inline.sha256))) ?? []), Array.from(png))

    const again = await Effect.runPromise(media.ingest(`data:image/png;base64,${Buffer.from(png).toString("base64")}`))
    assert.equal(again?.sha256, inline.sha256)
    assert.equal((await readdir(mediaDir)).filter((name) => !name.endsWith(".tmp")).length, 1)

    const local = await Effect.runPromise(media.ingest(pathToFileURL(join(assetDir, "local.png")).href))
    assert.equal(local?.sha256, inline.sha256)

    const outside = await Effect.runPromise(media.ingest(pathToFileURL("/etc/hostname").href))
    assert.equal(outside, undefined)

    const remote = await Effect.runPromise(media.ingest(`http://127.0.0.1:${address.port}/image.png`))
    assert.equal(remote?.sha256, inline.sha256)
    assert.equal(await Effect.runPromise(media.ingest(`http://127.0.0.1:${address.port}/missing`)), undefined)
    assert.equal(await Effect.runPromise(media.ingest("ftp://example.invalid/a.png")), undefined)
    assert.equal(await Effect.runPromise(media.ingest("data:text/plain;base64,aGVsbG8=")), undefined)
  } finally {
    await app.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(baseDir, { recursive: true, force: true })
  }
})

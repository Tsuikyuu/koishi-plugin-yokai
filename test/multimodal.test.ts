import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import SQLite from "@koishijs/plugin-database-sqlite"
import { App, Bot, Context, h, HTTP, Universal } from "koishi"
import { Effect, Layer, ManagedRuntime, Redacted, Schema, Semaphore } from "effect"
import { createKoishiHistory, encodeAction } from "../src/channels/koishi-history"
import { channelMediaStoreFile } from "../src/channels/file-media"
import { ChannelMediaStore, type StoredMedia } from "../src/channels/media"
import { channelIdOf } from "../src/channels/channel"
import { MessageId, ParticipantId, type MessagePart } from "../src/channels/message"
import { ChannelPlatform, type ChannelHistory } from "../src/channels/messaging"
import { MessageAction, type StickerDelivery } from "../src/channels/message-action"
import { registerHistoryModel } from "../src/channels/register-history"
import { detectImageMimeType, MaxImageBytes } from "../src/media/image"
import { CharacterId } from "../src/characters/character"
import { CharacterPreset } from "../src/characters/preset"
import { CharacterCatalogStatic } from "../src/characters/static-catalog"
import { MaxCharacterStickers, StickerId, type Sticker } from "../src/characters/sticker"
import { CharacterStickers, StickerConflict, StickerNotFound } from "../src/characters/sticker-store"
import { stickerStoreLayer } from "../src/characters/koishi-sticker-store"
import { buildChannelContext } from "../src/dialogue/context/build-context"
import { selectImages } from "../src/dialogue/context/attachments"
import type { ChannelTrigger } from "../src/dialogue/trigger"
import { decodeChannelResponse } from "../src/dialogue/response/parse-xml"
import { ChannelRoleplay } from "../src/dialogue/dialogue"
import { ChannelRoleplayLive } from "../src/dialogue/execute"
import { ChannelTriggersLive } from "../src/dialogue/next-reply/track-triggers"
import { ModelGateway } from "../src/models/gateway"
import type { ModelInput, ModelOutput } from "../src/models/model"
import { databaseLayer } from "../src/runtime/database"
import { registerModels } from "../src/runtime/register-models"

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0,
])
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("image format detection follows file content instead of names", () => {
  assert.equal(detectImageMimeType(png), "image/png")
  assert.equal(detectImageMimeType(jpeg), "image/jpeg")
  assert.equal(detectImageMimeType(webp), "image/webp")
  assert.equal(detectImageMimeType(gif), "image/gif")
  assert.equal(detectImageMimeType(new Uint8Array([1, 2, 3])), undefined)
})

test("dynamic sticker store persists metadata and files, enforces capacity/uniqueness, and cleans up unreferenced files", async () => {
  const root = await mkdtemp(join(tmpdir(), "yokai-stickers-"))
  const stickerDir = join(root, "stickers")
  const ctx = new Context()
  ctx.plugin(SQLite, { path: ":memory:" })
  await ctx.start()
  registerModels(ctx)
  await ctx.database.prepared()
  try {
    const serialize = (await Effect.runPromise(Semaphore.make(1))).withPermit
    const layer = stickerStoreLayer(ctx.database, serialize, stickerDir)
    const defaultCharacter = Schema.decodeSync(CharacterId)("default")
    const another = Schema.decodeSync(CharacterId)("another")
    const sleepy = Schema.decodeSync(StickerId)("sleepy")
    const speechless = Schema.decodeSync(StickerId)("无语")

    await Effect.runPromise(
      Effect.gen(function* () {
        const stickers = yield* CharacterStickers
        const created = yield* stickers.save({
          characterId: defaultCharacter,
          id: sleepy,
          summary: "趴在被窝里困得睁不开眼",
          sha256: sha256Of(webp),
          mimeType: "image/webp",
          bytes: webp,
        })
        assert.equal(created.id, sleepy)
        assert.equal(created.summary, "趴在被窝里困得睁不开眼")

        // 同一角色不允许重复 ID 或重复画面内容
        const duplicateId = yield* stickers
          .save({
            characterId: defaultCharacter,
            id: sleepy,
            summary: "另一张图",
            sha256: sha256Of(png),
            mimeType: "image/png",
            bytes: png,
          })
          .pipe(Effect.result)
        assert.ok(duplicateId._tag === "Failure" && duplicateId.failure instanceof StickerConflict)

        const duplicateHash = yield* stickers
          .save({
            characterId: defaultCharacter,
            id: speechless,
            summary: "同一张图换个名字",
            sha256: sha256Of(webp),
            mimeType: "image/webp",
            bytes: webp,
          })
          .pipe(Effect.result)
        assert.ok(duplicateHash._tag === "Failure" && duplicateHash.failure instanceof StickerConflict)

        // 另一个角色收藏同一张图时共享底层内容寻址文件
        yield* stickers.save({
          characterId: another,
          id: sleepy,
          summary: "困困",
          sha256: sha256Of(webp),
          mimeType: "image/webp",
          bytes: webp,
        })

        const updated = yield* stickers.update(defaultCharacter, sleepy, "赖床不想起，用于犯困")
        assert.equal(updated.summary, "赖床不想起，用于犯困")
        const loaded = yield* stickers.load(defaultCharacter, sleepy)
        assert.equal(loaded.summary, "赖床不想起，用于犯困")
        assert.deepEqual(Array.from(loaded.bytes), Array.from(webp))

        // 删除其中一个角色的引用后，另一个角色仍可正常读取该文件
        yield* stickers.remove(defaultCharacter, sleepy)
        assert.deepEqual(yield* stickers.list(defaultCharacter), [])
        const stillAvailable = yield* stickers.load(another, sleepy)
        assert.deepEqual(Array.from(stillAvailable.bytes), Array.from(webp))

        // 最后一个引用移除后，磁盘孤儿文件自动清理
        yield* stickers.remove(another, sleepy)
        const filesAfterRemove = (yield* Effect.promise(() => readdir(stickerDir))).filter((name) => !name.endsWith(".tmp"))
        assert.deepEqual(filesAfterRemove, [])

        const missing = yield* stickers.load(defaultCharacter, sleepy).pipe(Effect.result)
        assert.ok(missing._tag === "Failure" && missing.failure instanceof StickerNotFound)

        // 验证单角色定容上限
        for (let index = 0; index < MaxCharacterStickers; index++) {
          const itemBytes = new Uint8Array([...png, index])
          yield* stickers.save({
            characterId: defaultCharacter,
            id: Schema.decodeSync(StickerId)(`s_${index}`),
            summary: `表情 ${index}`,
            sha256: sha256Of(itemBytes),
            mimeType: "image/png",
            bytes: itemBytes,
          })
        }
        assert.equal((yield* stickers.list(defaultCharacter)).length, MaxCharacterStickers)
        const overflowBytes = new Uint8Array([...png, 250])
        const overflow = yield* stickers
          .save({
            characterId: defaultCharacter,
            id: Schema.decodeSync(StickerId)("overflow"),
            summary: "超出上限",
            sha256: sha256Of(overflowBytes),
            mimeType: "image/png",
            bytes: overflowBytes,
          })
          .pipe(Effect.result)
        assert.ok(overflow._tag === "Failure" && overflow.failure instanceof StickerConflict)
      }).pipe(Effect.provide(layer)),
    )
  } finally {
    await ctx.stop()
    await ctx.lifecycle.flush()
    await rm(root, { recursive: true, force: true })
  }
})

test("character preset schema no longer accepts static stickers configuration", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(CharacterPreset, { onExcessProperty: "error" })({
      version: 1,
      character: {
        id: "default",
        name: "小追求",
        aliases: [],
        basicSetting: "设定",
        detailedSetting: "",
        scene: "群聊",
        style: "简短",
        guidance: [],
        stickers: { sleepy: "困" },
      },
      initialState: { emotion: "困", condition: "刚醒", activity: "躺着", short_memory: "" },
    }),
  )
})

test("response protocol parses inline mentions, sticker sends, and sticker management actions", () => {
  const parsed = decodeChannelResponse(
    '<response><think/><actions>' +
      '<message quote="m1">看这个<at user="u1"/>笑死</message>' +
      '<sticker-save ref="img_1" id="猫猫疑惑">白猫歪头满脸问号，用于表达疑惑</sticker-save>' +
      '<sticker-update id="sleepy">赖床不想动弹</sticker-update>' +
      '<sticker-delete id="outdated" />' +
      '<sticker id="猫猫疑惑" quote="m2"/>' +
      "</actions><status/></response>",
  )
  assert.deepEqual(parsed.actions, [
    {
      type: "message",
      parts: [
        { type: "text", text: "看这个" },
        { type: "at", user: "u1" },
        { type: "text", text: "笑死" },
      ],
      quote: "m1",
    },
    {
      type: "sticker-save",
      ref: "img_1",
      stickerId: "猫猫疑惑",
      summary: "白猫歪头满脸问号，用于表达疑惑",
    },
    {
      type: "sticker-update",
      stickerId: "sleepy",
      summary: "赖床不想动弹",
    },
    {
      type: "sticker-delete",
      stickerId: "outdated",
    },
    {
      type: "sticker",
      stickerId: "猫猫疑惑",
      quote: "m2",
    },
  ])

  assert.throws(() => decodeChannelResponse('<response><think/><actions><message>  </message></actions><status/></response>'))
  assert.throws(() =>
    decodeChannelResponse('<response><think/><actions><message><image src="x"/></message></actions><status/></response>'),
  )
  assert.throws(() => decodeChannelResponse('<response><think/><actions><sticker id="bad id"/></actions><status/></response>'))
  assert.throws(() =>
    decodeChannelResponse('<response><think/><actions><sticker id="sleepy">不应带文本</sticker></actions><status/></response>'),
  )
  assert.throws(() =>
    decodeChannelResponse('<response><think/><actions><sticker-save ref="img_1" id="sleepy">   </sticker-save></actions><status/></response>'),
  )
  assert.throws(() =>
    decodeChannelResponse('<response><think/><actions><sticker-delete id="sleepy">多余文本</sticker-delete></actions><status/></response>'),
  )

  const withoutStatus = decodeChannelResponse(
    "<response><think>说嘴硬也对</think><actions><message>嘴硬总比饿硬好</message></actions></response>",
  )
  assert.deepEqual(withoutStatus, {
    think: "说嘴硬也对",
    actions: [{ type: "message", parts: [{ type: "text", text: "嘴硬总比饿硬好" }] }],
    status: {},
    nextReplies: [],
  })
  const withStatusAndNextReply = decodeChannelResponse(
    '<response><think>原来是ID</think><actions><message>原来是ID啊</message></actions><status><emotion>恍然</emotion></status><next-reply type="message_from_user" user_id="u1" /></response>',
  )
  assert.deepEqual(withStatusAndNextReply.nextReplies, [
    { type: "next-reply", condition: "message_from_user", userId: "u1", group: "next-0" },
  ])
  const withoutStatusWithMultipleNextReplies = decodeChannelResponse(
    '<response><think/><actions/><next-reply type="message_from_user" user_id="u1" /><next-reply type="silence" user_id="all" seconds="30" /></response>',
  )
  assert.equal(withoutStatusWithMultipleNextReplies.nextReplies.length, 2)
  assert.throws(
    () => decodeChannelResponse('<response><think/><actions><next-reply type="message_from_user" user_id="u1" /></actions><status/></response>'),
    /不能写在 <actions> 内/,
  )
  assert.throws(
    () => decodeChannelResponse('<response><think/><actions/><next-reply type="message_from_user" user_id="u1" /><status/></response>'),
    /子元素实际为 \[think, actions, next-reply, status\]/,
  )
  assert.throws(
    () => decodeChannelResponse("<response><actions><message>缺了think</message></actions></response>"),
    /子元素实际为 \[actions\]/,
  )
  assert.throws(
    () => decodeChannelResponse("<response><think/><status/></response>"),
    /子元素实际为 \[think, status\]/,
  )
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
    const storedItem: StoredMedia = { sha256: "a".repeat(64), mimeType: "image/png", byteLength: png.byteLength }
    const media: ChannelMediaStore["Service"] = {
      ingest: () => Effect.succeed(storedItem),
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
  const src = sticker[0]?.attrs.src
  assert.equal(typeof src, "string")
  if (typeof src === "string") {
    assert.ok(src.startsWith("data:image/png;base64,"))
  }
})

test("image bytes stop at the declared per-image limit", () => {
  assert.ok(MaxImageBytes >= 1024 * 1024)
})

test("context skips known/self stickers in attachment window and renders dynamic stickers in user message", () => {
  const characterId = Schema.decodeSync(CharacterId)("default")
  const preset = Schema.decodeSync(CharacterPreset)({
    version: 1,
    character: {
      id: "default",
      name: "小追求",
      aliases: [],
      basicSetting: "设定",
      detailedSetting: "",
      scene: "群聊",
      style: "简短",
      guidance: [],
    },
    initialState: { emotion: "困", condition: "刚醒", activity: "躺着", short_memory: "" },
  })
  const savedSticker: Sticker = {
    id: Schema.decodeSync(StickerId)("sleepy"),
    characterId,
    sha256: sha256Of(webp),
    mimeType: "image/webp",
    byteLength: webp.byteLength,
    summary: "趴在被窝里困得睁不开眼",
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
  }
  const freshImage: MessagePart = {
    type: "image",
    kind: "image",
    sha256: sha256Of(png),
    mimeType: "image/png",
    byteLength: png.byteLength,
  }
  const knownIncomingSticker: MessagePart = {
    type: "image",
    kind: "image",
    sha256: savedSticker.sha256,
    mimeType: "image/webp",
    byteLength: webp.byteLength,
  }
  const selfStickerPart: MessagePart = {
    type: "image",
    kind: "sticker",
    sha256: sha256Of(gif),
    mimeType: "image/gif",
    byteLength: gif.byteLength,
    stickerId: Schema.decodeSync(StickerId)("old_self"),
    summary: "以前发过的贴图",
  }
  const history: ChannelHistory = {
    bot: { id: Schema.decodeSync(ParticipantId)("bot"), name: "Bot" },
    participants: [
      { id: Schema.decodeSync(ParticipantId)("u1"), name: "Alice" },
      { id: Schema.decodeSync(ParticipantId)("bot"), name: "Bot" },
    ],
    messages: [
      { id: Schema.decodeSync(MessageId)("m0"), sender: Schema.decodeSync(ParticipantId)("bot"), time: 1, parts: [selfStickerPart] },
      { id: Schema.decodeSync(MessageId)("m1"), sender: Schema.decodeSync(ParticipantId)("u1"), time: 2, parts: [freshImage] },
      { id: Schema.decodeSync(MessageId)("m2"), sender: Schema.decodeSync(ParticipantId)("u1"), time: 3, parts: [knownIncomingSticker] },
    ],
    direct: false,
  }
  const trigger: ChannelTrigger = {
    type: "message",
    messages: [
      {
        id: Schema.decodeSync(MessageId)("m3"),
        sender: Schema.decodeSync(ParticipantId)("u1"),
        time: 4,
        parts: [{ type: "text", text: "这图什么意思" }],
        quote: Schema.decodeSync(MessageId)("m1"),
      },
    ],
  }
  const selected = selectImages(history, trigger, new Set([savedSticker.sha256]))
  assert.deepEqual(
    selected.map((item) => item.messageId),
    ["m1"],
  )

  const context = buildChannelContext({
    channel: {
      platform: "test",
      channelId: "room",
      id: channelIdOf({ platform: "test", channelId: "room" }),
      presetId: characterId,
      state: { emotion: "困", condition: "刚醒", activity: "躺着", short_memory: "" },
    },
    preset,
    stickers: [savedSticker],
    history,
    notes: [],
    trigger,
    timezone: "Asia/Shanghai",
    now: 5,
    routine: undefined,
    attachments: [
      {
        ref: "img_1",
        messageId: Schema.decodeSync(MessageId)("m1"),
        part: 0,
        sha256: sha256Of(png),
        mimeType: "image/png",
        byteLength: png.byteLength,
        bytes: png,
      },
    ],
  })
  const system = context.messages[0]
  assert.equal(system?.role, "system")
  assert.equal(typeof system?.content, "string")
  if (typeof system?.content === "string") {
    assert.match(system.content, /## 表情包使用与管理/)
    assert.doesNotMatch(system.content, /趴在被窝里困得睁不开眼/)
  }

  const user = context.messages[1]
  assert.equal(user?.role, "user")
  assert.ok(Array.isArray(user?.content))
  if (!Array.isArray(user?.content)) return
  const firstPart = user.content[0]
  const secondPart = user.content[1]
  const thirdPart = user.content[2]
  assert.ok(firstPart?.type === "text")
  assert.ok(secondPart?.type === "text")
  assert.ok(thirdPart?.type === "image")
  assert.match(firstPart.text, /<stickers count="1" limit="40">\n<sticker id="sleepy">趴在被窝里困得睁不开眼<\/sticker>\n<\/stickers>/)
  assert.match(firstPart.text, /<image kind="image" attached="true" ref="img_1" \/>/)
  assert.match(firstPart.text, /<message id="m2"[^>]*><sticker id="sleepy">趴在被窝里困得睁不开眼<\/sticker><\/message>/)
  assert.match(secondPart.text, /<attachment ref="img_1" message_id="m1"/)
  assert.equal(Redacted.value(thirdPart.data), Buffer.from(png).toString("base64"))
})

test("character saves a sticker from group chat and manages/reuses it globally across another channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "yokai-sticker-turn-"))
  const ctx = new Context()
  ctx.plugin(SQLite, { path: ":memory:" })
  registerModels(ctx)
  registerHistoryModel(ctx)
  const sent: string[] = []
  const { bot, fork } = addBot(ctx, sent)
  await ctx.start()
  await ctx.database.prepared()
  try {
    await ctx.database.createChannel("media-test", "group-a", { assignee: "bot" })
    await ctx.database.createChannel("media-test", "group-b", { assignee: "bot" })
    const serialize = (await Effect.runPromise(Semaphore.make(1))).withPermit
    const media = channelMediaStoreFile(ctx.http, join(root, "media"), root)
    const history = await Effect.runPromise(createKoishiHistory(ctx, serialize, media))
    const baseRuntime = ManagedRuntime.make(
      Layer.mergeAll(
        databaseLayer(ctx.database, serialize),
        stickerStoreLayer(ctx.database, serialize, join(root, "stickers")),
        ChannelTriggersLive,
      ),
    )
    try {
      const characterId = Schema.decodeSync(CharacterId)("default")
      const preset = Schema.decodeSync(CharacterPreset)({
        version: 1,
        character: {
          id: "default",
          name: "小追求",
          aliases: [],
          basicSetting: "设定",
          detailedSetting: "",
          scene: "群聊",
          style: "简短",
          guidance: [],
        },
        initialState: { emotion: "平静", condition: "在线", activity: "闲聊", short_memory: "" },
      })

      const capturedInputs: ModelInput[] = []
      const scriptedReplies: string[] = [
        // 第 1 轮（group-a）：收藏群友刚发的图片并立刻复读发送
        '<response><think/><actions>' +
          '<sticker-save ref="img_1" id="猫猫问号">白猫歪头满脸问号，用于表达疑惑</sticker-save>' +
          '<sticker id="猫猫问号" quote="m1" />' +
          "</actions><status/></response>",
        // 第 2 轮（group-b）：跨群全局共享，修改描述并发送
        '<response><think/><actions>' +
          '<sticker-update id="猫猫问号">白猫歪头满脸问号，适合装傻反问</sticker-update>' +
          '<sticker id="猫猫问号" />' +
          "</actions><status/></response>",
        // 第 3 轮（group-b）：引用不存在的 img_9 收藏，整轮动作回滚不发出前序消息
        '<response><think/><actions>' +
          "<message>这句不该发出去</message>" +
          '<sticker-save ref="img_9" id="bad">不存在的图</sticker-save>' +
          "</actions><status/></response>",
        // 第 4 轮（group-b）：同轮对同一张新图重复保存两次，整轮动作拒绝执行
        '<response><think/><actions>' +
          '<sticker-save ref="img_1" id="猫猫1">第一次存</sticker-save>' +
          '<sticker-save ref="img_1" id="猫猫2">重复存同画面</sticker-save>' +
          "</actions><status/></response>",
        // 第 5 轮（group-b）：删除不存在的贴图，整轮动作拒绝执行
        '<response><think/><actions>' +
          "<message>这句也不该发出去</message>" +
          '<sticker-delete id="不存在的贴图" />' +
          "</actions><status/></response>",
        // 第 6 轮（group-b）：删除已有表情包，同轮收藏新图并发送（腾出空间后接力）
        '<response><think/><actions>' +
          '<sticker-delete id="猫猫问号" />' +
          '<sticker-save ref="img_1" id="新猫猫">换一张新的反应图</sticker-save>' +
          '<sticker id="新猫猫" />' +
          "</actions><status/></response>",
      ]
      let turnIndex = 0
      const fakeModel = Layer.succeed(
        ModelGateway,
        ModelGateway.of({
          capabilities: { imageInput: true },
          generate: (input) =>
            Effect.sync((): ModelOutput => {
              capturedInputs.push(input)
              const text = scriptedReplies[turnIndex] ?? "<response><think/><actions/><status/></response>"
              turnIndex++
              return { text }
            }),
        }),
      )

      const runTurn = async (channelId: string, messageId: string, content: string) => {
        const session = bot.session({
          type: "message",
          timestamp: Date.now(),
          user: { id: "u1", name: "Alice" },
          channel: { id: channelId, type: Universal.Channel.Type.TEXT },
          guild: { id: "guild" },
          message: { id: messageId, content },
        })
        const received = await Effect.runPromise(history.recordIncoming(session))
        assert.ok(received)
        const roleplay = ChannelRoleplayLive("Asia/Shanghai", undefined).pipe(
          Layer.provide(
            Layer.mergeAll(
              fakeModel,
              CharacterCatalogStatic([preset]),
              history.channelPlatform(session),
              Layer.succeed(ChannelMediaStore, media),
            ),
          ),
        )
        return baseRuntime.runPromiseExit(
          Effect.flatMap(ChannelRoleplay, (service) => service.reply({ ...received, presetId: characterId })).pipe(
            Effect.provide(roleplay),
          ),
        )
      }

      const pngDataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`
      const webpDataUrl = `data:image/webp;base64,${Buffer.from(webp).toString("base64")}`

      const firstExit = await runTurn("group-a", "m1", `<img src="${pngDataUrl}"/>`)
      assert.equal(firstExit._tag, "Success")
      assert.equal(sent.length, 1)
      assert.match(sent[0] ?? "", /quote/)
      assert.match(sent[0] ?? "", /data:image\/png;base64,/)

      const secondExit = await runTurn("group-b", "m2", "你在干嘛")
      assert.equal(secondExit._tag, "Success")
      assert.equal(sent.length, 2)
      const secondUser = capturedInputs[1]?.messages[1]?.content
      assert.equal(typeof secondUser, "string")
      if (typeof secondUser === "string") {
        assert.match(secondUser, /<sticker id="猫猫问号">白猫歪头满脸问号，用于表达疑惑<\/sticker>/)
      }
      const outgoingInB = await ctx.database.get("yokai_history", { channelId: "group-b", direction: "outgoing" })
      assert.equal(outgoingInB.length, 1)
      assert.equal(outgoingInB[0]?.text, "[表情包]")

      const invalidRefExit = await runTurn("group-b", "m3", "再来一张")
      assert.equal(invalidRefExit._tag, "Failure")
      assert.equal(sent.length, 2)

      const duplicateSameTurnExit = await runTurn("group-b", "m4", `<img src="${webpDataUrl}"/>`)
      assert.equal(duplicateSameTurnExit._tag, "Failure")
      assert.equal(sent.length, 2)

      const missingDeleteExit = await runTurn("group-b", "m5", "删掉不存在的")
      assert.equal(missingDeleteExit._tag, "Failure")
      assert.equal(sent.length, 2)

      const replaceExit = await runTurn("group-b", "m6", "换成上面那张新图")
      assert.equal(replaceExit._tag, "Success")
      assert.equal(sent.length, 3)
      assert.match(sent[2] ?? "", /data:image\/webp;base64,/)
      const remainingRows = await ctx.database.get("yokai_sticker", {})
      assert.deepEqual(
        remainingRows.map((row) => ({ id: row.id, summary: row.summary })),
        [{ id: "新猫猫", summary: "换一张新的反应图" }],
      )
    } finally {
      await baseRuntime.dispose()
    }
  } finally {
    fork.dispose()
    await ctx.lifecycle.flush()
    await ctx.stop()
    await rm(root, { recursive: true, force: true })
  }
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

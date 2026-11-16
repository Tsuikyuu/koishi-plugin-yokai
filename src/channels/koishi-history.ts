import { Effect, Layer, Schema, type Semaphore } from "effect"
import { h, Universal, type Context, type Session } from "koishi"
import { Message, Participant, messageText, type MessagePart } from "./message"
import { type ChannelKey } from "./channel"
import { type ChannelOutboundAction } from "./message-action"
import type { ChannelMediaStore } from "./media"
import { ChannelPlatform, ChannelPlatformError } from "./messaging"
import { KoishiHistoryError, type KoishiHistory } from "./history"
import type { HistoryRow } from "./history-table"
import type {} from "./table"

export const keyOf = (session: Session): ChannelKey | undefined =>
  session.platform && session.channelId ? { platform: session.platform, channelId: session.channelId } : undefined

// 业务调用方也会传入 Channel，其 id/state 不是历史表字段。
const keyFields = ({ platform, channelId }: ChannelKey) => ({ platform, channelId })

export const encodeAction = (action: ChannelOutboundAction): h.Fragment => [
  ...(action.quote ? [h.quote(action.quote)] : []),
  ...(action.type === "sticker"
    ? [h.image(action.bytes, action.mimeType)]
    : action.parts.map((part) => (part.type === "text" ? h.text(part.text) : h.at(part.user)))),
]

// 把 Koishi 消息元素解析为有序片段；图片立即落盘并只保留元数据。
const contentParts = (media: ChannelMediaStore["Service"], session: Session) =>
  Effect.gen(function* () {
    const parts: MessagePart[] = []
    // 单条消息最多处理固定数量的图片；先占位，再并发落盘，保持原有顺序。
    const pending: Array<{ readonly index: number; readonly source: string }> = []
    let images = 0
    const walk = (elements: readonly h[]): Effect.Effect<void> =>
      Effect.forEach(
        elements,
        (element) =>
          Effect.gen(function* () {
            if (element.type === "quote") return
            if (element.type === "text") {
              const value = element.toString(true)
              if (value !== "") parts.push({ type: "text", text: value })
              return
            }
            if (element.type === "at") {
              const target = element.attrs.id
              if (typeof target !== "string" || target === "") return
              const name = element.attrs.name
              parts.push({
                type: "at",
                target,
                ...(typeof name === "string" && name !== "" ? { name } : {}),
              })
              return
            }
            if (element.type === "img" || element.type === "image") {
              const source = element.attrs.src ?? element.attrs.url
              const index = parts.length
              parts.push({ type: "image", kind: "image", unavailable: true })
              if (typeof source === "string" && source !== "" && images < 9) pending.push({ index, source })
              images++
              return
            }
            if (element.children.length > 0) yield* walk(element.children)
          }),
        { discard: true },
      )
    const elements = session.elements ?? h.parse(session.content ?? session.event.message?.content ?? "")
    yield* walk(elements)
    const stored = yield* Effect.forEach(
      pending,
      (item) => media.ingest(item.source).pipe(Effect.map((value) => ({ index: item.index, value }))),
      { concurrency: 3 },
    )
    for (const { index, value } of stored) {
      if (value !== undefined) parts[index] = { type: "image", kind: "image", ...value }
    }
    return parts
  })

const isBlank = (parts: ReadonlyArray<MessagePart>) =>
  parts.length === 0 || parts.every((part) => part.type === "text" && part.text.trim() === "")

const messageFromRow = (row: HistoryRow) =>
  Schema.decodeUnknownEffect(Message)({
    id: row.messageId,
    sender: row.senderId,
    time: row.time.getTime(),
    parts: row.parts ?? [{ type: "text", text: row.text }],
    ...(row.quote ? { quote: row.quote } : {}),
  })

// 只抽取错误类型、系统错误码、HTTP 状态与平台说明；不写回包含 token 的请求 URL。
const describePlatformError = (error: unknown): string => {
  const parts: string[] = []
  if (error instanceof Error) parts.push(error.name)
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === "string") {
      parts.push(code)
      break
    }
    current = (current as { cause?: unknown }).cause
  }
  const response = (error as { response?: { status?: unknown; data?: unknown } }).response
  if (typeof response?.status === "number") parts.push(`HTTP ${response.status}`)
  if (response?.data !== undefined) parts.push(JSON.stringify(response.data).slice(0, 300))
  return parts.join(" ") || "未知错误"
}

export const createKoishiHistory = (
  ctx: Context,
  serialize: Semaphore.Semaphore["withPermit"],
  media: ChannelMediaStore["Service"],
): Effect.Effect<KoishiHistory> =>
  Effect.sync(() => {
    const record = Effect.fn("KoishiHistory.record")(
      (session: Session, message: Message, participant: Participant, direction: HistoryRow["direction"]) =>
        Effect.tryPromise({
          try: () => {
            if (!session.channelId || !session.userId) throw new Error("missing channel identity")
            return ctx.database.create("yokai_history", {
              platform: session.platform,
              channelId: session.channelId,
              direct: session.isDirect,
              guildId: session.guildId || null,
              userId: session.userId,
              referrer: session.event.referrer == null ? null : (JSON.stringify(session.event.referrer) ?? null),
              direction,
              messageId: message.id,
              senderId: participant.id,
              senderName: participant.name,
              time: new Date(message.time),
              text: messageText(message),
              parts: message.parts,
              quote: message.quote ?? null,
            })
          },
          catch: () => new KoishiHistoryError({ operation: "record" }),
        }).pipe(Effect.asVoid, Effect.uninterruptible, serialize),
    )

    const recordIncoming: KoishiHistory["recordIncoming"] = Effect.fn("KoishiHistory.recordIncoming")(
      function* (session) {
        const parts = yield* contentParts(media, session)
        if (isBlank(parts)) {
          yield* Effect.logDebug("消息无可识别内容，不写入历史")
          return
        }
        const key = keyOf(session)
        if (!key || !session.userId) return yield* Effect.fail(new KoishiHistoryError({ operation: "record" }))
        const incoming = yield* Schema.decodeUnknownEffect(Message)({
          id: session.messageId,
          sender: session.userId,
          time: session.timestamp,
          parts,
          ...(session.quote?.id ? { quote: session.quote.id } : {}),
        }).pipe(Effect.mapError(() => new KoishiHistoryError({ operation: "record" })))
        const participant = yield* Schema.decodeUnknownEffect(Participant)({
          id: session.userId,
          name: session.event.member?.nick || session.event.user?.name || session.userId,
        }).pipe(Effect.mapError(() => new KoishiHistoryError({ operation: "record" })))
        const duplicate = yield* Effect.tryPromise({
          try: () =>
            ctx.database.get("yokai_history", { ...key, messageId: incoming.id }, { fields: ["id"], limit: 1 }),
          catch: () => new KoishiHistoryError({ operation: "record" }),
        }).pipe(Effect.uninterruptible, serialize)
        if (duplicate.length) {
          yield* Effect.logDebug(`消息 ${incoming.id} 已在历史中，视为重复事件`)
          return
        }
        yield* record(session, incoming, participant, "incoming")
        yield* Effect.logDebug(
          `已记录入站消息 ${incoming.id}，发送者 ${participant.name}(${participant.id})${incoming.quote ? `，引用 ${incoming.quote}` : ""}：${messageText(incoming)}`,
        )
        return { key, incoming }
      },
    )

    // 与 Koishi 广播一致：由频道受理人选择机器人，再由插件过滤器决定是否参与。
    const sessionFor: KoishiHistory["sessionFor"] = Effect.fn("KoishiHistory.sessionFor")(function* (key) {
      const { channel, row } = yield* Effect.tryPromise({
        try: async () => {
          const channel = await ctx.database.getChannel(key.platform, key.channelId, ["assignee"])
          const [row] = await ctx.database.get(
            "yokai_history",
            { ...keyFields(key), direction: "incoming" },
            { sort: { id: "desc" }, limit: 1 },
          )
          return { channel, row }
        },
        catch: () => new KoishiHistoryError({ operation: "session" }),
      }).pipe(Effect.uninterruptible, serialize)
      const bot = channel?.assignee ? ctx.bots[`${key.platform}:${channel.assignee}`] : undefined
      if (!bot || !row) return
      const referrer = yield* Effect.try({
        try: (): unknown => (row.referrer === null ? undefined : JSON.parse(row.referrer)),
        catch: () => new KoishiHistoryError({ operation: "session" }),
      })
      const session = bot.session({
        type: "message",
        timestamp: Date.now(),
        channel: { id: row.channelId, type: row.direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
        user: { id: row.userId },
        ...(row.guildId ? { guild: { id: row.guildId } } : {}),
        referrer,
      })
      return ctx.filter(session) ? session : undefined
    })

    const channelPlatform: KoishiHistory["channelPlatform"] = (session) =>
      Layer.succeed(
        ChannelPlatform,
        ChannelPlatform.of({
          history: Effect.fn("KoishiHistory.history")(function* (key, query) {
            const where = keyFields(key)
            const { rows, incoming } = yield* Effect.tryPromise({
              try: async () => {
                if ("beforeMessageId" in query) {
                  const [incoming] = await ctx.database.get(
                    "yokai_history",
                    { ...where, messageId: query.beforeMessageId },
                    { limit: 1 },
                  )
                  if (!incoming) throw new Error("missing incoming message")
                  const rows = await ctx.database.get(
                    "yokai_history",
                    { ...where, id: { $lt: incoming.id } },
                    { sort: { id: "desc" }, limit: Math.min(query.limit, 50) },
                  )
                  return { rows, incoming }
                }
                const rows = await ctx.database.get(
                  "yokai_history",
                  { ...where, time: { $lt: new Date(query.beforeTime) } },
                  { sort: { id: "desc" }, limit: Math.min(query.limit, 50) },
                )
                return { rows, incoming: undefined }
              },
              catch: () => new ChannelPlatformError({ operation: "history" }),
            }).pipe(Effect.uninterruptible, serialize)
            const messages = yield* Effect.forEach([...rows].reverse(), (row) =>
              messageFromRow(row).pipe(Effect.mapError(() => new ChannelPlatformError({ operation: "history" }))),
            )
            const bot = yield* Schema.decodeUnknownEffect(Participant)({
              id: session.selfId,
              name: session.bot.user?.name || session.selfId,
            }).pipe(Effect.mapError(() => new ChannelPlatformError({ operation: "history" })))
            const participants = yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(Participant)({
                id: row.senderId,
                name: row.senderName,
              }).pipe(Effect.mapError(() => new ChannelPlatformError({ operation: "history" }))),
            )
            const incomingParticipant =
              incoming !== undefined
                ? yield* Schema.decodeUnknownEffect(Participant)({
                    id: incoming.senderId,
                    name: incoming.senderName,
                  }).pipe(Effect.mapError(() => new ChannelPlatformError({ operation: "history" })))
                : undefined
            return {
              bot,
              participants: [
                ...new Map(
                  [...participants, ...(incomingParticipant ? [incomingParticipant] : []), bot].map((p) => [p.id, p]),
                ).values(),
              ],
              messages,
              direct: session.isDirect,
            }
          }),
          // Native sends cannot be aborted. Finish delivery and its history record
          // before honoring cancellation; the caller's next action remains interruptible.
          send: Effect.fn("KoishiHistory.send")(function* (_key, action) {
            yield* Effect.logDebug(
              `发送${action.type === "sticker" ? `表情包 ${action.stickerId}` : "消息"}${action.quote ? `（引用 ${action.quote}）` : ""}`,
            )
            const ids = yield* Effect.tryPromise({
              try: () =>
                session.bot.sendMessage(session.channelId!, encodeAction(action), session.event.referrer, { session }),
              catch: (error) => new ChannelPlatformError({ operation: "send", detail: describePlatformError(error) }),
            }).pipe(
              Effect.tapError((error) => Effect.logWarning(`平台发送失败：${error.detail ?? "未知错误"}`)),
            )
            const message = yield* Schema.decodeUnknownEffect(Message)(
              action.type === "sticker"
                ? {
                    id: ids[0],
                    sender: session.selfId,
                    time: Date.now(),
                    parts: [
                      {
                        type: "image",
                        kind: "sticker",
                        sha256: action.sha256,
                        mimeType: action.mimeType,
                        byteLength: action.byteLength,
                        summary: action.summary,
                        stickerId: action.stickerId,
                      },
                    ],
                    ...(action.quote ? { quote: action.quote } : {}),
                  }
                : {
                    id: ids[0],
                    sender: session.selfId,
                    time: Date.now(),
                    parts: action.parts,
                    ...(action.quote ? { quote: action.quote } : {}),
                  },
            ).pipe(Effect.mapError(() => new ChannelPlatformError({ operation: "send" })))
            const participant = yield* Schema.decodeUnknownEffect(Participant)({
              id: session.selfId,
              name: session.bot.user?.name || session.selfId,
            }).pipe(Effect.mapError(() => new ChannelPlatformError({ operation: "send" })))
            yield* record(session, message, participant, "outgoing").pipe(
              Effect.mapError(() => new ChannelPlatformError({ operation: "send" })),
            )
            yield* Effect.logDebug(`消息已发送并记录，平台消息 ID ${ids.join(", ")}`)
          }, Effect.uninterruptible),
        }),
      )
    return { recordIncoming, sessionFor, channelPlatform }
  })

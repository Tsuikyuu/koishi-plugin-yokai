import { Effect, Layer, Ref, Result, Schema, Semaphore } from "effect"
import { h, Universal, type Context, type Session } from "koishi"
import { Message, Participant, ParticipantId, messageText, type MessagePart } from "./message"
import { channelIdOf, type ChannelId, type ChannelKey } from "./channel"
import { type ChannelOutboundAction } from "./message-action"
import type { ChannelMediaStore } from "./media"
import { ChannelPlatform, ChannelPlatformError } from "./messaging"
import { KoishiHistoryError, type KoishiHistory } from "./history"
import type { HistoryRow } from "./history-table"
import type {} from "./table"

type BotInstance = Context["bots"][number]

interface ChannelSyncEntry {
  readonly lock: Semaphore.Semaphore
  readonly syncedSid: string | undefined
}

interface SyncHints {
  readonly beforeMessageId?: string | undefined
  readonly direct?: boolean | undefined
  readonly guildId?: string | undefined
  readonly referrer?: string | null | undefined
}

interface PreparedHistoryEntry {
  readonly messageId: string
  readonly direct: boolean
  readonly guildId: string | null
  readonly userId: string
  readonly referrer: string | null
  readonly direction: HistoryRow["direction"]
  readonly senderId: Participant["id"]
  readonly senderName: string
  readonly time: Date
  readonly text: string
  readonly parts: Message["parts"]
  readonly quote: string | null
}

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
const contentParts = (media: ChannelMediaStore["Service"], elements: readonly h[]) =>
  Effect.gen(function* () {
    const parts: MessagePart[] = []
    // 单条消息最多处理固定数量的图片；先占位，再并发落盘，保持原有顺序。
    const pending: Array<{ readonly index: number; readonly source: string }> = []
    let images = 0
    const walk = (nodes: readonly h[]): Effect.Effect<void> =>
      Effect.forEach(
        nodes,
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

const sessionElements = (session: Session): readonly h[] =>
  session.elements ?? h.parse(session.content ?? session.event.message?.content ?? "")

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

const getProp = (target: unknown, key: string): unknown =>
  typeof target === "object" && target !== null ? Reflect.get(target, key) : undefined

// 只抽取错误类型、系统错误码、HTTP 状态与平台说明；不写回包含 token 的请求 URL。
const describePlatformError = (error: unknown): string => {
  const parts: string[] = []
  if (error instanceof Error) parts.push(error.name)
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const code = getProp(current, "code")
    if (typeof code === "string") {
      parts.push(code)
      break
    }
    current = getProp(current, "cause")
  }
  const response = getProp(error, "response")
  const status = getProp(response, "status")
  const data = getProp(response, "data")
  if (typeof status === "number") parts.push(`HTTP ${status}`)
  if (data !== undefined) parts.push(JSON.stringify(data).slice(0, 300))
  return parts.join(" ") || "未知错误"
}

const idOf = (item: Universal.Message): string | undefined => {
  const raw = item.id ?? item.messageId
  return typeof raw === "string" && raw !== "" ? raw : undefined
}

const timeOf = (item: Universal.Message): number | undefined => {
  const raw = item.timestamp ?? item.createdAt
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined
}

const quoteOf = (item: Universal.Message, elements: readonly h[]): string | undefined => {
  if (typeof item.quote?.id === "string" && item.quote.id !== "") return item.quote.id
  const quoteElement = elements.find((element) => element.type === "quote")
  const attrId = quoteElement?.attrs.id
  return typeof attrId === "string" && attrId !== "" ? attrId : undefined
}

// Satori 规定 getMessageList 返回旧到新升序；若个别适配器按新到旧返回则翻转为正序。
const normalizeChronological = (items: ReadonlyArray<Universal.Message>): ReadonlyArray<Universal.Message> => {
  if (items.length < 2) return items
  const first = items[0]
  const last = items[items.length - 1]
  const firstTime = first === undefined ? undefined : timeOf(first)
  const lastTime = last === undefined ? undefined : timeOf(last)
  return firstTime !== undefined && lastTime !== undefined && firstTime > lastTime ? [...items].reverse() : items
}

// 遇到当前正在实时入站处理的消息立即截断，交由实时流程入库与触发判断。
const truncateBeforeRealtime = (
  items: ReadonlyArray<Universal.Message>,
  channelId: ChannelId,
  beforeMessageId: string | undefined,
  realtimeKeys: ReadonlySet<string>,
): ReadonlyArray<Universal.Message> => {
  const result: Universal.Message[] = []
  for (const item of items) {
    const id = idOf(item)
    if (id !== undefined && (id === beforeMessageId || realtimeKeys.has(`${channelId}:${id}`))) {
      break
    }
    result.push(item)
  }
  return result
}

// 仅选取数据库最新记录之后的新增消息（或空频道的全部近期消息），保持自增主键与时间正序一致。
const selectMissingMessages = (
  candidates: ReadonlyArray<Universal.Message>,
  latest: HistoryRow | undefined,
  existingIds: ReadonlySet<string>,
): ReadonlyArray<Universal.Message> => {
  let slice = candidates
  if (latest !== undefined) {
    let lastKnownIndex = -1
    for (let index = candidates.length - 1; index >= 0; index--) {
      const item = candidates[index]
      const id = item === undefined ? undefined : idOf(item)
      if (id !== undefined && existingIds.has(id)) {
        lastKnownIndex = index
        break
      }
    }
    if (lastKnownIndex >= 0) {
      slice = candidates.slice(lastKnownIndex + 1)
    } else {
      const floorMs = Math.floor(latest.time.getTime() / 1000) * 1000
      slice = candidates.filter((item) => {
        const timestamp = timeOf(item)
        return timestamp !== undefined && timestamp >= floorMs
      })
    }
  }
  const seen = new Set<string>(existingIds)
  const deduplicated: Universal.Message[] = []
  for (const item of slice) {
    const id = idOf(item)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    deduplicated.push(item)
  }
  return deduplicated
}

const fetchRecentMessages = (bot: BotInstance, channelId: string) => {
  const method: unknown = Reflect.get(bot, "getMessageList")
  if (typeof method !== "function") return undefined
  return () => bot.getMessageList(channelId)
}

export const createKoishiHistory = (
  ctx: Context,
  serialize: Semaphore.Semaphore["withPermit"],
  media: ChannelMediaStore["Service"],
): Effect.Effect<KoishiHistory> =>
  Effect.gen(function* () {
    const syncStates = yield* Ref.make<ReadonlyMap<ChannelId, ChannelSyncEntry>>(new Map())
    const pendingRealtime = yield* Ref.make<ReadonlySet<string>>(new Set())

    const markSynced = (channelId: ChannelId, entry: ChannelSyncEntry, sid: string) =>
      Ref.update(syncStates, (all) => new Map(all).set(channelId, { lock: entry.lock, syncedSid: sid }))

    const ensureSynced = Effect.fn("KoishiHistory.ensureSynced")(function* (
      bot: BotInstance,
      key: ChannelKey,
      hints?: SyncHints,
    ) {
      if (bot.status !== Universal.Status.ONLINE || !bot.sid) return
      const id = channelIdOf(key)
      const entry = yield* Ref.modify(
        syncStates,
        (all): readonly [ChannelSyncEntry, ReadonlyMap<ChannelId, ChannelSyncEntry>] => {
          const existing = all.get(id)
          if (existing !== undefined) return [existing, all]
          const created: ChannelSyncEntry = { lock: Semaphore.makeUnsafe(1), syncedSid: undefined }
          return [created, new Map(all).set(id, created)]
        },
      )
      if (entry.syncedSid === bot.sid) return

      yield* entry.lock.withPermits(1)(
        Effect.gen(function* () {
          const latestState = (yield* Ref.get(syncStates)).get(id) ?? entry
          if (latestState.syncedSid === bot.sid || bot.status !== Universal.Status.ONLINE) return
          const loadList = fetchRecentMessages(bot, key.channelId)
          if (loadList === undefined) {
            yield* markSynced(id, latestState, bot.sid)
            return
          }
          const fetched = yield* Effect.result(
            Effect.tryPromise({
              try: loadList,
              catch: (error) => describePlatformError(error),
            }),
          )
          if (Result.isFailure(fetched)) {
            yield* Effect.logWarning(`拉取近期历史消息失败（${fetched.failure}），跳过本次补齐`)
            yield* markSynced(id, latestState, bot.sid)
            return
          }
          const rawItems = fetched.success?.data ?? []
          if (rawItems.length === 0) {
            yield* markSynced(id, latestState, bot.sid)
            return
          }
          const ordered = normalizeChronological(rawItems)
          const realtimeBeforeFetch = yield* Ref.get(pendingRealtime)
          const candidates = truncateBeforeRealtime(ordered, id, hints?.beforeMessageId, realtimeBeforeFetch)
          if (candidates.length === 0) {
            yield* markSynced(id, latestState, bot.sid)
            return
          }
          const candidateIds = candidates.flatMap((item) => {
            const messageId = idOf(item)
            return messageId === undefined ? [] : [messageId]
          })
          const { channelRow, latest, recentBoundaryRows, existingIds } = yield* Effect.tryPromise({
            try: async () => {
              const channelRow = await ctx.database.getChannel(key.platform, key.channelId, ["assignee", "guildId"])
              const recentRows = await ctx.database.get(
                "yokai_history",
                keyFields(key),
                { sort: { id: "desc" }, limit: 10 },
              )
              const latest = recentRows[0]
              const floorMs = latest === undefined ? undefined : Math.floor(latest.time.getTime() / 1000) * 1000
              const recentBoundaryRows =
                floorMs === undefined
                  ? []
                  : recentRows.filter((row) => Math.floor(row.time.getTime() / 1000) * 1000 >= floorMs)
              const existingRows =
                candidateIds.length === 0
                  ? []
                  : await ctx.database.get(
                      "yokai_history",
                      { ...keyFields(key), messageId: { $in: candidateIds } },
                      { fields: ["messageId"] },
                    )
              return {
                channelRow,
                latest,
                recentBoundaryRows,
                existingIds: new Set(existingRows.map((row) => row.messageId)),
              }
            },
            catch: () => new KoishiHistoryError({ operation: "sync" }),
          }).pipe(Effect.uninterruptible, serialize)

          const matchedKnownId = candidates.some((item) => {
            const candidateId = idOf(item)
            return candidateId !== undefined && existingIds.has(candidateId)
          })
          const boundarySignatures = matchedKnownId
            ? new Set<string>()
            : new Set(
                recentBoundaryRows.map(
                  (row) => `${Math.floor(row.time.getTime() / 1000) * 1000}\n${row.senderId}\n${row.text}`,
                ),
              )
          const missing = selectMissingMessages(candidates, latest, existingIds)
          if (missing.length === 0) {
            yield* markSynced(id, latestState, bot.sid)
            return
          }

          // 在数据库锁外解析元素与缓存图片，避免网络 I/O 阻塞其他频道读写。
          const prepared: PreparedHistoryEntry[] = []
          for (const item of missing) {
            const rawId = idOf(item)
            const senderRaw = item.user?.id
            const timestamp = timeOf(item)
            if (rawId === undefined || senderRaw === undefined || senderRaw === "" || timestamp === undefined) {
              continue
            }
            const elements = item.elements ?? h.parse(item.content ?? "")
            const parts = yield* contentParts(media, elements)
            if (isBlank(parts)) continue
            const quoteRaw = quoteOf(item, elements)
            const decodedMessage = yield* Effect.result(
              Schema.decodeUnknownEffect(Message)({
                id: rawId,
                sender: senderRaw,
                time: timestamp,
                parts,
                ...(quoteRaw !== undefined ? { quote: quoteRaw } : {}),
              }),
            )
            if (Result.isFailure(decodedMessage)) continue
            const fromSelf = bot.selfId !== undefined && bot.selfId !== "" && senderRaw === bot.selfId
            const displayName =
              item.member?.nick ||
              item.member?.name ||
              item.user?.nick ||
              item.user?.name ||
              (fromSelf ? bot.user?.name : undefined) ||
              senderRaw
            const decodedParticipant = yield* Effect.result(
              Schema.decodeUnknownEffect(Participant)({
                id: senderRaw,
                name: displayName,
              }),
            )
            if (Result.isFailure(decodedParticipant)) continue
            const fallbackDirect = latest !== undefined ? latest.direct : (channelRow?.guildId ?? "") === ""
            const direct =
              hints?.direct ??
              (item.channel !== undefined ? item.channel.type === Universal.Channel.Type.DIRECT : fallbackDirect)
            const guildCandidate =
              item.guild?.id || hints?.guildId || channelRow?.guildId || latest?.guildId || undefined
            const guildId = direct ? null : (guildCandidate ?? null)
            const referrer = hints?.referrer !== undefined ? hints.referrer : (latest?.referrer ?? null)
            const text = messageText(decodedMessage.success)
            const secFloorMs = Math.floor(decodedMessage.success.time / 1000) * 1000
            if (boundarySignatures.has(`${secFloorMs}\n${decodedParticipant.success.id}\n${text}`)) {
              continue
            }
            prepared.push({
              messageId: decodedMessage.success.id,
              direct,
              guildId,
              userId: decodedParticipant.success.id,
              referrer,
              direction: fromSelf ? "outgoing" : "incoming",
              senderId: decodedParticipant.success.id,
              senderName: decodedParticipant.success.name,
              time: new Date(decodedMessage.success.time),
              text,
              parts: decodedMessage.success.parts,
              quote: decodedMessage.success.quote ?? null,
            })
          }

          if (prepared.length === 0) {
            yield* markSynced(id, latestState, bot.sid)
            return
          }

          const realtimeBeforeWrite = yield* Ref.get(pendingRealtime)
          const inserted = yield* Effect.tryPromise({
            try: async () => {
              const stopAt = prepared.findIndex((entry) => realtimeBeforeWrite.has(`${id}:${entry.messageId}`))
              const allowed = stopAt >= 0 ? prepared.slice(0, stopAt) : prepared
              if (allowed.length === 0) return 0
              const existing = await ctx.database.get(
                "yokai_history",
                { ...keyFields(key), messageId: { $in: allowed.map((entry) => entry.messageId) } },
                { fields: ["messageId"] },
              )
              const seen = new Set(existing.map((row) => row.messageId))
              let count = 0
              for (const entry of allowed) {
                if (seen.has(entry.messageId)) continue
                await ctx.database.create("yokai_history", {
                  platform: key.platform,
                  channelId: key.channelId,
                  direct: entry.direct,
                  guildId: entry.guildId,
                  userId: entry.userId,
                  referrer: entry.referrer,
                  direction: entry.direction,
                  messageId: entry.messageId,
                  senderId: entry.senderId,
                  senderName: entry.senderName,
                  time: entry.time,
                  text: entry.text,
                  parts: entry.parts,
                  quote: entry.quote,
                })
                count++
              }
              return count
            },
            catch: () => new KoishiHistoryError({ operation: "sync" }),
          }).pipe(Effect.uninterruptible, serialize)

          if (inserted > 0) {
            yield* Effect.logDebug(`已从平台补齐近期历史消息 ${inserted} 条`)
          }
          yield* markSynced(id, latestState, bot.sid)
        }),
      )
    })

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
        const key = keyOf(session)
        const realtimeTag =
          key !== undefined && session.messageId ? `${channelIdOf(key)}:${session.messageId}` : undefined
        if (realtimeTag !== undefined) {
          yield* Ref.update(pendingRealtime, (current) => new Set([...current, realtimeTag]))
        }
        return yield* Effect.gen(function* () {
          const parts = yield* contentParts(media, sessionElements(session))
          if (isBlank(parts)) {
            yield* Effect.logDebug("消息无可识别内容，不写入历史")
            return
          }
          if (!key || !session.userId) return yield* Effect.fail(new KoishiHistoryError({ operation: "record" }))
          yield* ensureSynced(session.bot, key, {
            ...(session.messageId ? { beforeMessageId: session.messageId } : {}),
            direct: session.isDirect,
            ...(session.guildId ? { guildId: session.guildId } : {}),
            referrer: session.event.referrer == null ? null : (JSON.stringify(session.event.referrer) ?? null),
          })
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
          const botId = yield* Schema.decodeUnknownEffect(ParticipantId)(session.selfId).pipe(
            Effect.mapError(() => new KoishiHistoryError({ operation: "record" })),
          )
          const { isDuplicate, quotedSenderId } = yield* Effect.tryPromise({
            try: async () => {
              const existing = await ctx.database.get(
                "yokai_history",
                { ...key, messageId: incoming.id },
                { fields: ["id"], limit: 1 },
              )
              if (existing.length > 0) return { isDuplicate: true, quotedSenderId: undefined }
              if (incoming.quote === undefined) return { isDuplicate: false, quotedSenderId: undefined }
              if (session.quote?.user?.id !== undefined) {
                return { isDuplicate: false, quotedSenderId: session.quote.user.id }
              }
              const [quoted] = await ctx.database.get(
                "yokai_history",
                { ...key, messageId: incoming.quote },
                { fields: ["senderId"], limit: 1 },
              )
              return { isDuplicate: false, quotedSenderId: quoted?.senderId }
            },
            catch: () => new KoishiHistoryError({ operation: "record" }),
          }).pipe(Effect.uninterruptible, serialize)
          if (isDuplicate) {
            yield* Effect.logDebug(`消息 ${incoming.id} 已在历史中，视为重复事件`)
            return
          }
          yield* record(session, incoming, participant, "incoming")
          return {
            key,
            incoming,
            senderName: participant.name,
            botId,
            direct: session.isDirect,
            quotedBot: quotedSenderId === session.selfId,
          }
        }).pipe(
          Effect.ensuring(
            realtimeTag === undefined
              ? Effect.void
              : Ref.update(pendingRealtime, (current) => {
                  const next = new Set(current)
                  next.delete(realtimeTag)
                  return next
                }),
          ),
        )
      },
    )

    // 与 Koishi 广播一致：由频道受理人选择机器人，再由插件过滤器决定是否参与。
    const sessionFor: KoishiHistory["sessionFor"] = Effect.fn("KoishiHistory.sessionFor")(function* (key) {
      const channel = yield* Effect.tryPromise({
        try: () => ctx.database.getChannel(key.platform, key.channelId, ["assignee", "guildId"]),
        catch: () => new KoishiHistoryError({ operation: "session" }),
      }).pipe(Effect.uninterruptible, serialize)
      const bot = channel?.assignee ? ctx.bots[`${key.platform}:${channel.assignee}`] : undefined
      if (!bot) return
      if (bot.status === Universal.Status.ONLINE && bot.selfId) {
        const direct = (channel?.guildId ?? "") === ""
        const probe = bot.session({
          type: "message",
          timestamp: Date.now(),
          channel: { id: key.channelId, type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
          ...(channel?.guildId ? { guild: { id: channel.guildId } } : {}),
          user: { id: bot.selfId },
        })
        if (ctx.filter(probe)) {
          yield* ensureSynced(bot, key, {
            direct,
            ...(channel?.guildId ? { guildId: channel.guildId } : {}),
          }).pipe(Effect.mapError(() => new KoishiHistoryError({ operation: "session" })))
        }
      }
      const row = yield* Effect.tryPromise({
        try: async () => {
          const [latestIncoming] = await ctx.database.get(
            "yokai_history",
            { ...keyFields(key), direction: "incoming" },
            { sort: { id: "desc" }, limit: 1 },
          )
          return latestIncoming
        },
        catch: () => new KoishiHistoryError({ operation: "session" }),
      }).pipe(Effect.uninterruptible, serialize)
      if (!row) return
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

    const syncBot: KoishiHistory["syncBot"] = Effect.fn("KoishiHistory.syncBot")(function* (bot) {
      const platform = bot.platform
      const selfId = bot.selfId
      if (bot.status !== Universal.Status.ONLINE || !platform || !selfId) return
      const boundChannels = yield* Effect.tryPromise({
        try: () =>
          ctx.database.get(
            "channel",
            { platform, assignee: selfId, yokaiPreset: { $ne: "" } },
            ["id", "guildId"],
          ),
        catch: () => new KoishiHistoryError({ operation: "sync" }),
      }).pipe(Effect.uninterruptible, serialize)
      for (const row of boundChannels) {
        if (!row.id) continue
        const direct = row.guildId === ""
        const probe = bot.session({
          type: "message",
          timestamp: Date.now(),
          channel: { id: row.id, type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
          ...(row.guildId ? { guild: { id: row.guildId } } : {}),
          user: { id: selfId },
        })
        if (!ctx.filter(probe)) continue
        const key: ChannelKey = { platform, channelId: row.id }
        yield* ensureSynced(bot, key, {
          direct,
          ...(row.guildId ? { guildId: row.guildId } : {}),
        }).pipe(Effect.annotateLogs({ channel: channelIdOf(key), trigger: "sync" }))
      }
    })

    const invalidateBot: KoishiHistory["invalidateBot"] = (bot) =>
      bot.sid
        ? Ref.update(syncStates, (all) => {
            let changed = false
            const next = new Map<ChannelId, ChannelSyncEntry>()
            for (const [id, entry] of all) {
              if (entry.syncedSid === bot.sid) {
                changed = true
                next.set(id, { lock: entry.lock, syncedSid: undefined })
              } else {
                next.set(id, entry)
              }
            }
            return changed ? next : all
          })
        : Effect.void

    const channelPlatform: KoishiHistory["channelPlatform"] = (session) =>
      Layer.succeed(
        ChannelPlatform,
        ChannelPlatform.of({
          history: Effect.fn("KoishiHistory.history")(function* (key, query) {
            const where = keyFields(key)
            const { rows, incomingRows, quotedSenderId } = yield* Effect.tryPromise({
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
                  const batchIds = query.incomingIds ?? [query.beforeMessageId]
                  const incomingRows =
                    batchIds.length <= 1
                      ? [incoming]
                      : await ctx.database.get("yokai_history", { ...where, messageId: { $in: [...batchIds] } })
                  const inWindow =
                    incoming.quote === null ? undefined : rows.find((row) => row.messageId === incoming.quote)
                  const [quoted] =
                    incoming.quote === null || inWindow !== undefined
                      ? []
                      : await ctx.database.get(
                          "yokai_history",
                          { ...where, messageId: incoming.quote },
                          { fields: ["senderId"], limit: 1 },
                        )
                  return {
                    rows,
                    incomingRows,
                    quotedSenderId: inWindow?.senderId ?? quoted?.senderId ?? session.quote?.user?.id,
                  }
                }
                const rows = await ctx.database.get(
                  "yokai_history",
                  { ...where, time: { $lt: new Date(query.beforeTime) } },
                  { sort: { id: "desc" }, limit: Math.min(query.limit, 50) },
                )
                return { rows, incomingRows: [], quotedSenderId: undefined }
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
            const participants = yield* Effect.forEach([...rows, ...incomingRows], (row) =>
              Schema.decodeUnknownEffect(Participant)({
                id: row.senderId,
                name: row.senderName,
              }).pipe(Effect.mapError(() => new ChannelPlatformError({ operation: "history" }))),
            )
            return {
              bot,
              participants: [...new Map([...participants, bot].map((p) => [p.id, p])).values()],
              messages,
              direct: session.isDirect,
              ...(quotedSenderId === undefined ? {} : { quotedBot: quotedSenderId === session.selfId }),
            }
          }),
          // 原生发送无法中途撤销：等待当前发送与历史写入落定后再响应中断，下一动作仍可被取消。
          send: Effect.fn("KoishiHistory.send")(function* (_key, action) {
            const ids = yield* Effect.tryPromise({
              try: () =>
                session.bot.sendMessage(session.channelId!, encodeAction(action), session.event.referrer, { session }),
              catch: (error) => new ChannelPlatformError({ operation: "send", detail: describePlatformError(error) }),
            })
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
            const quoteTag = action.quote ? `（引用 ${action.quote}）` : ""
            yield* Effect.logDebug(
              action.type === "sticker"
                ? `已发送表情包 [${action.stickerId}]${quoteTag} -> ID ${ids.join(", ")}`
                : `已发送消息${quoteTag} -> ID ${ids.join(", ")}：${messageText(message)}`,
            )
          }, Effect.uninterruptible),
        }),
      )
    return { recordIncoming, sessionFor, syncBot, invalidateBot, channelPlatform }
  })

import { Effect, Layer, Schema, type Semaphore } from "effect"
import type { Context } from "koishi"
import { NotebookStore, NotebookStoreError, NoteNotFound } from "./store"
import { ChannelId } from "../channels/channel"
import { NoteId, type Note } from "./note"
import type { NoteRecord } from "./tables"

const Row = Schema.Struct({
  id: NoteId,
  channelId: ChannelId,
  text: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
})
const Relation = Schema.Struct({
  sourceId: NoteId,
  targetId: NoteId,
  kind: Schema.Literals(["supplements", "corrects"]),
})
const decodeRow = Schema.decodeUnknownSync(Row)
const decodeRelations = Schema.decodeUnknownSync(Schema.Array(Relation))
const literalPattern = (text: string) => new RegExp(text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))

const hydrate = async (database: Context["database"], data: NoteRecord): Promise<Note> => {
  const row = decodeRow(data)
  const links = decodeRelations(
    await database.get("yokai_note_relation", {
      channelId: row.channelId,
      $or: [{ sourceId: row.id }, { targetId: row.id }],
    }),
  )
  const relations = await Promise.all(
    links.map(async (link) => {
      const direction = link.sourceId === row.id ? "outgoing" : "incoming"
      const noteId = direction === "outgoing" ? link.targetId : link.sourceId
      const [target] = await database.get("yokai_note", { id: noteId, channelId: row.channelId })
      const note = decodeRow(target)
      return { kind: link.kind, direction, note: { id: note.id, text: note.text, createdAt: note.createdAt } } as const
    }),
  )
  return {
    ...row,
    relations: relations.sort(
      (a, b) => a.note.createdAt.getTime() - b.note.createdAt.getTime() || a.note.id.localeCompare(b.note.id),
    ),
  }
}

export const notebookStoreLayer = (database: Context["database"], serialize: Semaphore.Semaphore["withPermit"]) => {
  const get = async (channelId: ChannelId, noteId: NoteId) => {
    const [row] = await database.get("yokai_note", { id: noteId, channelId })
    if (row === undefined) throw new NoteNotFound({ channelId, noteId })
    return hydrate(database, row)
  }
  return Layer.succeed(
    NotebookStore,
    NotebookStore.of({
      get: Effect.fn("KoishiNotebookStore.get")(
        (channelId, noteId) =>
          Effect.tryPromise({
            try: () => get(channelId, noteId),
            catch: (error) => (error instanceof NoteNotFound ? error : new NotebookStoreError({ operation: "get" })),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      add: Effect.fn("KoishiNotebookStore.add")(
        (channelId, text, links = []) =>
          Effect.tryPromise({
            try: async () => {
              const id = Schema.decodeUnknownSync(NoteId)(crypto.randomUUID())
              const now = new Date()
              await database.withTransaction(async (transaction) => {
                await transaction.create("yokai_note", {
                  id,
                  channelId,
                  text,
                  searchText: text.toLowerCase(),
                  createdAt: now,
                  updatedAt: now,
                })
                for (const link of links) {
                  const [target] = await transaction.get("yokai_note", { id: link.noteId, channelId })
                  if (!target) throw new NoteNotFound({ channelId, noteId: link.noteId })
                  await transaction.create("yokai_note_relation", {
                    channelId,
                    sourceId: id,
                    targetId: link.noteId,
                    kind: link.kind,
                  })
                }
              })
              return get(channelId, id)
            },
            catch: (error) => (error instanceof NoteNotFound ? error : new NotebookStoreError({ operation: "add" })),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      query: Effect.fn("KoishiNotebookStore.query")(
        (channelId, query) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await database.get(
                "yokai_note",
                {
                  channelId,
                  ...(query.id === undefined ? {} : { id: query.id }),
                  ...(query.keyword ? { searchText: { $regex: literalPattern(query.keyword) } } : {}),
                },
                { sort: { createdAt: "desc", id: "desc" }, offset: query.offset, limit: query.limit + 1 },
              )
              return {
                notes: await Promise.all(rows.slice(0, query.limit).map((row) => hydrate(database, row))),
                hasMore: rows.length > query.limit,
              }
            },
            catch: () => new NotebookStoreError({ operation: "query" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
    }),
  )
}

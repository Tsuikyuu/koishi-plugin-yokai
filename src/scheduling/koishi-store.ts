import { Effect, Layer, Schema, type Semaphore } from "effect"
import { $, type Context } from "koishi"
import { ScheduleNotFound, ScheduleStore, ScheduleStoreError } from "./store"
import { ScheduleId, ScheduleKind, ScheduleState, type ScheduleRun } from "./schedule"
import type {} from "./tables"

const Row = Schema.Struct({
  id: ScheduleId,
  kind: ScheduleKind,
  cron: Schema.String,
  at: Schema.NullOr(Schema.Date),
  timezone: Schema.String,
  payload: Schema.JsonObject,
  nextAt: Schema.NullOr(Schema.Date),
  state: ScheduleState,
  revision: Schema.Int,
})
const decode = Schema.decodeUnknownSync(Row)
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row))

export const scheduleStoreLayer = (database: Context["database"], serialize: Semaphore.Semaphore["withPermit"]) =>
  Layer.succeed(
    ScheduleStore,
    ScheduleStore.of({
      create: Effect.fn("KoishiScheduleStore.create")(
        (input, nextAt) =>
          Effect.tryPromise({
            try: async () =>
              decode(
                await database.create("yokai_schedule", {
                  ...input,
                  id: crypto.randomUUID(),
                  nextAt,
                  state: "enabled",
                  revision: 0,
                }),
              ),
            catch: () => new ScheduleStoreError({ operation: "create" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      update: Effect.fn("KoishiScheduleStore.update")(
        (id, input, nextAt, state) =>
          Effect.tryPromise({
            try: async () => {
              let updated: unknown
              await database.withTransaction(async (transaction) => {
                const result = await transaction.set("yokai_schedule", { id }, (row) => ({
                  ...input,
                  nextAt,
                  state,
                  revision: $.add(row.revision, 1),
                }))
                if (result.matched === 0) throw new ScheduleNotFound({ scheduleId: id })
                const [row] = await transaction.get("yokai_schedule", { id })
                updated = row
              })
              return decode(updated)
            },
            catch: (error) =>
              error instanceof ScheduleNotFound ? error : new ScheduleStoreError({ operation: "update" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      delete: Effect.fn("KoishiScheduleStore.delete")(
        (id) =>
          Effect.tryPromise({
            try: () =>
              database.withTransaction(async (transaction) => {
                const result = await transaction.remove("yokai_schedule", { id })
                if (result.matched === 0) throw new ScheduleNotFound({ scheduleId: id })
                await transaction.set("yokai_schedule_run", { scheduleId: id }, { scheduleId: null })
              }),
            catch: (error) =>
              error instanceof ScheduleNotFound ? error : new ScheduleStoreError({ operation: "delete" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      cancel: Effect.fn("KoishiScheduleStore.cancel")(
        (id) =>
          Effect.tryPromise({
            try: () =>
              database.withTransaction(async (transaction) => {
                const result = await transaction.set("yokai_schedule", { id }, (row) => ({
                  nextAt: null,
                  state: "paused",
                  revision: $.add(row.revision, 1),
                }))
                if (result.matched === 0) throw new ScheduleNotFound({ scheduleId: id })
              }),
            catch: (error) =>
              error instanceof ScheduleNotFound ? error : new ScheduleStoreError({ operation: "cancel" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      get: Effect.fn("KoishiScheduleStore.get")(
        (id) =>
          Effect.tryPromise({
            try: async () => {
              const [row] = await database.get("yokai_schedule", { id })
              return row === undefined ? undefined : decode(row)
            },
            catch: () => new ScheduleStoreError({ operation: "get" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      query: Effect.fn("KoishiScheduleStore.query")(
        (query) =>
          Effect.tryPromise({
            try: async () => {
              const rows = decodeRows(
                await database.get(
                  "yokai_schedule",
                  {
                    payload: query.payload,
                    ...(query.id === undefined ? {} : { id: query.id }),
                  },
                  { sort: { id: "asc" } },
                ),
              )
              const matching = rows.filter((row) =>
                JSON.stringify(row.payload)
                  .toLowerCase()
                  .includes((query.keyword ?? "").toLowerCase()),
              )
              return {
                tasks: matching.slice(query.offset, query.offset + query.limit),
                hasMore: matching.length > query.offset + query.limit,
              }
            },
            catch: () => new ScheduleStoreError({ operation: "query" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      listDue: Effect.fn("KoishiScheduleStore.listDue")(
        (now) =>
          Effect.tryPromise({
            try: async () =>
              decodeRows(
                await database.get(
                  "yokai_schedule",
                  { nextAt: { $lte: now, $exists: true } },
                  { sort: { nextAt: "asc", id: "asc" } },
                ),
              ),
            catch: () => new ScheduleStoreError({ operation: "listDue" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      claim: Effect.fn("KoishiScheduleStore.claim")(
        (snapshot, nextAt, now) =>
          Effect.tryPromise({
            try: async () => {
              const scheduledAt = snapshot.nextAt
              if (scheduledAt === null) return undefined
              const run: ScheduleRun = {
                id: crypto.randomUUID(),
                scheduleId: snapshot.id,
                payload: snapshot.payload,
                kind: snapshot.kind,
                cron: snapshot.cron,
                scheduledAt,
              }
              let claimed = false
              await database.withTransaction(async (transaction) => {
                const result = await transaction.set(
                  "yokai_schedule",
                  {
                    id: snapshot.id,
                    revision: snapshot.revision,
                    nextAt: { $lte: now, $exists: true },
                  },
                  { nextAt, state: nextAt === null ? "completed" : "enabled", revision: snapshot.revision + 1 },
                )
                if (result.matched === 0) return
                await transaction.create("yokai_schedule_run", {
                  id: run.id,
                  scheduleId: run.scheduleId,
                  payload: run.payload,
                  scheduledAt,
                  startedAt: now,
                  finishedAt: null,
                  status: "running",
                  outcome: null,
                })
                claimed = true
              })
              return claimed ? run : undefined
            },
            catch: () => new ScheduleStoreError({ operation: "claim" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      finish: Effect.fn("KoishiScheduleStore.finish")(
        (id, outcome, now) =>
          Effect.tryPromise({
            try: async () => {
              await database.set("yokai_schedule_run", { id }, { status: outcome.status, outcome, finishedAt: now })
            },
            catch: () => new ScheduleStoreError({ operation: "finish" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
    }),
  )

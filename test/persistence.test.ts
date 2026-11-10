import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import SQLite from "@koishijs/plugin-database-sqlite"
import { Context } from "koishi"
import { Effect, Schema, Semaphore } from "effect"
import { ChannelNotFound, ChannelStore } from "../src/channels/store"
import { channelIdOf } from "../src/channels/channel"
import { NotebookStore, NoteNotFound } from "../src/notebook/store"
import { ScheduleStore } from "../src/scheduling/store"
import { CharacterId } from "../src/characters/character"
import { NoteId } from "../src/notebook/note"
import { databaseLayer } from "../src/runtime/database"
import { registerModels } from "../src/runtime/register-models"

const open = async (path: string) => {
  const ctx = new Context()
  ctx.plugin(SQLite, { path })
  await ctx.start()
  registerModels(ctx)
  await ctx.database.prepared()
  return ctx
}
const close = async (ctx: Context) => {
  await ctx.stop()
  await ctx.lifecycle.flush()
}
const preset = Schema.decodeSync(CharacterId)("companion")
const key = { platform: "test", channelId: "room" }
const otherKey = { platform: "test", channelId: "other-room" }
const state = { emotion: "calm", condition: "well", activity: "reading", short_memory: "hello" }

test("Koishi channel table persists character binding and atomic note relations across reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yokai-koishi-db-"))
  const path = join(directory, "koishi.db")
  let ctx = await open(path)
  try {
    const serialize = (await Effect.runPromise(Semaphore.make(1))).withPermit
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const channels = yield* ChannelStore
        const notes = yield* NotebookStore
        const missing = yield* channels.bind(key, preset, state).pipe(Effect.result)
        assert.ok(missing._tag === "Failure" && missing.failure instanceof ChannelNotFound)
        yield* Effect.promise(() => ctx.database.createChannel(key.platform, key.channelId, { assignee: "bot" }))
        yield* Effect.promise(() => ctx.database.createChannel(otherKey.platform, otherKey.channelId, { assignee: "bot" }))
        assert.equal(yield* channels.find(key), undefined)
        const channel = yield* channels.bind(key, preset, state)
        assert.equal(channel.id, channelIdOf(key))
        assert.equal((yield* channels.find(key))?.id, channel.id)
        const other = yield* channels.bind(otherKey, preset, state)
        const original = yield* notes.add(channel.id, "Coffee 100%_literal [special].")
        const supplement = yield* notes.add(channel.id, "With milk", [{ kind: "supplements", noteId: original.id }])
        const foreign = yield* notes.add(other.id, "Other bot's private note")
        const rejected = yield* notes
          .add(channel.id, "Must roll back", [{ kind: "corrects", noteId: foreign.id }])
          .pipe(Effect.result)
        assert.equal(rejected._tag, "Failure")
        if (rejected._tag === "Failure") assert.ok(rejected.failure instanceof NoteNotFound)
        const rejectedMissing = yield* notes
          .add(channel.id, "Also rolled back", [
            { kind: "corrects", noteId: Schema.decodeSync(NoteId)("missing-note") },
          ])
          .pipe(Effect.result)
        assert.equal(rejectedMissing._tag, "Failure")
        assert.equal((yield* notes.query(channel.id, { offset: 0, limit: 20 })).notes.length, 2)
        assert.equal(
          (yield* notes.query(channel.id, { keyword: "[special].", offset: 0, limit: 20 })).notes[0]?.id,
          original.id,
        )
        assert.equal(
          (yield* notes.query(channel.id, { keyword: "%_", offset: 0, limit: 20 })).notes[0]?.id,
          original.id,
        )
        const firstPage = yield* notes.query(channel.id, { offset: 0, limit: 1 })
        assert.equal(firstPage.hasMore, true)
        assert.equal((yield* notes.query(channel.id, { offset: 1, limit: 1 })).hasMore, false)
        yield* channels.setState(key, { ...state, activity: "drinking coffee" })
        return { channel, other, original, supplement }
      }).pipe(Effect.provide(databaseLayer(ctx.database, serialize))),
    )
    assert.equal((await ctx.database.get("yokai_note", {})).length, 3)
    assert.equal((await ctx.database.get("yokai_note_relation", {})).length, 1)
    await close(ctx)
    ctx = await open(path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const channels = yield* ChannelStore
        const channel = yield* channels.find(key)
        assert.equal(channel?.id, saved.channel.id)
        assert.equal(channel?.state.activity, "drinking coffee")
        assert.equal((yield* channels.find(otherKey))?.id, saved.other.id)
        const row = yield* Effect.promise(() => ctx.database.getChannel(key.platform, key.channelId, ["yokaiPreset"]))
        assert.equal(row?.yokaiPreset, preset)
        const notes = yield* NotebookStore
        const original = yield* notes.get(saved.channel.id, saved.original.id)
        assert.equal(original.relations[0]?.direction, "incoming")
        assert.equal(original.relations[0]?.note.id, saved.supplement.id)
        const supplement = yield* notes.get(saved.channel.id, saved.supplement.id)
        assert.equal(supplement.relations[0]?.direction, "outgoing")
        assert.deepEqual(yield* channels.listPresetIds(), [preset])
      }).pipe(Effect.provide(databaseLayer(ctx.database, serialize))),
    )
  } finally {
    await close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

test("Koishi transactions reject stale, duplicate and canceled schedule claims and preserve run history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yokai-koishi-schedule-"))
  const ctx = await open(join(directory, "koishi.db"))
  try {
    const serialize = (await Effect.runPromise(Semaphore.make(1))).withPermit
    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const schedules = yield* ScheduleStore
        const dueAt = new Date("2026-01-01T00:00:00.000Z")
        const input = {
          kind: "at",
          cron: "",
          at: dueAt,
          timezone: "Asia/Shanghai",
          payload: { channelId: "room", text: "Coffee" },
        } as const
        const stale = yield* schedules.create(input, dueAt)
        const current = yield* schedules.update(stale.id, input, dueAt, "enabled")
        assert.equal(yield* schedules.claim(stale, null, dueAt), undefined)
        const results = yield* Effect.all(
          [schedules.claim(current, null, dueAt), schedules.claim(current, null, dueAt)],
          { concurrency: "unbounded" },
        )
        const claims = results.filter((result) => result !== undefined)
        assert.equal(claims.length, 1)
        const claimed = claims[0]
        assert.ok(claimed)
        yield* schedules.finish(claimed.id, { status: "success", result: { sent: true } }, dueAt)
        assert.equal((yield* schedules.get(current.id))?.state, "completed")
        const canceled = yield* schedules.create(input, dueAt)
        yield* schedules.cancel(canceled.id)
        assert.equal(yield* schedules.claim(canceled, null, dueAt), undefined)
        assert.deepEqual(yield* schedules.listDue(dueAt), [])
        const query = yield* schedules.query({ payload: { channelId: "room" }, keyword: "coffee", offset: 0, limit: 1 })
        assert.equal(query.tasks.length, 1)
        assert.equal(query.hasMore, true)
        yield* schedules.delete(current.id)
        assert.equal(yield* schedules.get(current.id), undefined)
        return claimed
      }).pipe(Effect.provide(databaseLayer(ctx.database, serialize))),
    )
    const [run] = await ctx.database.get("yokai_schedule_run", { id: completed.id })
    assert.equal(run?.status, "success")
    assert.equal(run?.scheduleId, null)
    assert.deepEqual(run?.outcome, { status: "success", result: { sent: true } })
  } finally {
    await close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

test("native schedule predicates isolate unrelated malformed rows without hiding matching corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yokai-query-isolation-"))
  const ctx = await open(join(directory, "koishi.db"))
  try {
    const serialize = (await Effect.runPromise(Semaphore.make(1))).withPermit
    const dueAt = new Date("2026-01-01T00:00:00.000Z")
    await ctx.database.create("yokai_schedule", {
      id: "",
      kind: "at",
      cron: "",
      at: dueAt,
      nextAt: dueAt,
      timezone: "Asia/Shanghai",
      payload: { channelId: "other-room", text: "unrelated" },
      state: "enabled",
      revision: 0,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const schedules = yield* ScheduleStore
        const expected = yield* schedules.create(
          {
            kind: "at",
            cron: "",
            at: dueAt,
            timezone: "Asia/Shanghai",
            payload: { channelId: "room", text: "Coffee" },
          },
          dueAt,
        )
        const page = yield* schedules.query({ payload: { channelId: "room" }, offset: 0, limit: 10 })
        assert.deepEqual(
          page.tasks.map((task) => task.id),
          [expected.id],
        )
        assert.equal(page.hasMore, false)
        const matchingCorruption = yield* schedules
          .query({ payload: { channelId: "other-room" }, offset: 0, limit: 10 })
          .pipe(Effect.result)
        assert.equal(matchingCorruption._tag, "Failure")
        const mismatchedId = yield* schedules.query({
          payload: { channelId: "other-room" },
          id: expected.id,
          offset: 0,
          limit: 10,
        })
        assert.deepEqual(mismatchedId.tasks, [])
      }).pipe(Effect.provide(databaseLayer(ctx.database, serialize))),
    )
  } finally {
    await close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

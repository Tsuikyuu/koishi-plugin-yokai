import { Effect } from "effect"
import { NotebookStore } from "./store"
import type { ExecuteNoteAction, LoadRecentNotes } from "./actions"

export const executeNoteAction: ExecuteNoteAction = (channelId, action) =>
  Effect.gen(function* () {
    const notebook = yield* NotebookStore
    return yield* notebook.add(channelId, action.text, action.links)
  })

export const loadRecentNotes: LoadRecentNotes = (channelId) =>
  Effect.gen(function* () {
    const notebook = yield* NotebookStore
    const page = yield* notebook.query(channelId, { offset: 0, limit: 10 })
    return page.notes
  })

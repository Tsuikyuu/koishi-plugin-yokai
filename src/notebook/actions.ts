import type { Effect } from "effect"
import type { ChannelId } from "../channels/channel"
import type { Note, NoteAction } from "./note"
import type { NotebookStore, NotebookStoreError, NoteNotFound } from "./store"

// 动作调度方按 XML 顺序调用；每次只执行一条笔记动作，不触发额外模型生成。
export type ExecuteNoteAction = (
  channelId: ChannelId,
  action: NoteAction,
) => Effect.Effect<Note, NotebookStoreError | NoteNotFound, NotebookStore>

// 调用方将结果作为参考数据放入上下文，而非系统指令。
export type LoadRecentNotes = (
  channelId: ChannelId,
) => Effect.Effect<ReadonlyArray<Note>, NotebookStoreError, NotebookStore>

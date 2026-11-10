import { Context, Data, type Effect } from "effect"
import type { ChannelId } from "../channels/channel"
import type { Note, NoteId, NotePage, NoteQuery, NoteLink } from "./note"

export class NotebookStoreError extends Data.TaggedError("NotebookStoreError")<{
  readonly operation: string
}> {}
export class NoteNotFound extends Data.TaggedError("NoteNotFound")<{
  readonly channelId: ChannelId
  readonly noteId: NoteId
}> {}

export class NotebookStore extends Context.Service<
  NotebookStore,
  {
    readonly get: (channelId: ChannelId, noteId: NoteId) => Effect.Effect<Note, NotebookStoreError | NoteNotFound>
    // 追加正文与关系原子提交；关系只能指向本频道已有笔记，读取时返回双向的一跳关联。
    readonly add: (
      channelId: ChannelId,
      text: string,
      links?: ReadonlyArray<NoteLink>,
    ) => Effect.Effect<Note, NotebookStoreError | NoteNotFound>
    // 最近创建优先；关键词为不区分大小写的字面子串，不是 SQL 模式。
    readonly query: (channelId: ChannelId, query: NoteQuery) => Effect.Effect<NotePage, NotebookStoreError>
  }
>()("yokai/notebook/NotebookStore") {}

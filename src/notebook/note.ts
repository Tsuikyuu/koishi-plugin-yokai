import { Schema } from "effect"
import type { ChannelId } from "../channels/channel"

export const NoteId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("NoteId"))
export type NoteId = typeof NoteId.Type

export const NoteLink = Schema.Struct({ noteId: NoteId, kind: Schema.Literals(["supplements", "corrects"]) })
export interface NoteLink extends Schema.Schema.Type<typeof NoteLink> {}
export const NoteAction = Schema.Struct({
  type: Schema.Literal("note-add"),
  text: Schema.NonEmptyString,
  links: Schema.optionalKey(Schema.Array(NoteLink)),
})
export type NoteAction = typeof NoteAction.Type

export interface NoteRelation {
  readonly kind: NoteLink["kind"]
  readonly direction: "outgoing" | "incoming"
  readonly note: { readonly id: NoteId; readonly text: string; readonly createdAt: Date }
}

export interface Note {
  readonly id: NoteId
  readonly channelId: ChannelId
  readonly text: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly relations: ReadonlyArray<NoteRelation>
}

// 分页参数由外部工具入口解析，存储不重复验证。
export interface NoteQuery {
  readonly keyword?: string
  readonly id?: NoteId
  readonly offset: number
  readonly limit: number
}

export interface NotePage {
  readonly notes: ReadonlyArray<Note>
  readonly hasMore: boolean
}

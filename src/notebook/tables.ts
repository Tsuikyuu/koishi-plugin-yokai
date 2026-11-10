export interface NoteRecord {
  id: string
  channelId: string
  text: string
  searchText: string
  createdAt: Date
  updatedAt: Date
}

export interface NoteRelationRecord {
  channelId: string
  sourceId: string
  targetId: string
  kind: "supplements" | "corrects"
}

declare module "koishi" {
  interface Tables {
    yokai_note: NoteRecord
    yokai_note_relation: NoteRelationRecord
  }
}

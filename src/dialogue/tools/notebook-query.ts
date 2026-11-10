import { Schema } from "effect"
import { NoteId } from "../../notebook/note"
import { type ModelTool } from "../../models/model"

export const NotebookQueryArguments = Schema.Struct({
  queries: Schema.NonEmptyArray(
    Schema.Struct({
      keyword: Schema.optionalKey(Schema.String),
      id: Schema.optionalKey(NoteId),
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
    }),
  ).check(Schema.isMaxLength(10)),
})

export const notebookQueryTool: ModelTool = {
  name: "notebook-query",
  description:
    "查询当前频道的角色记事本，可按 id 或关键词查找。每条笔记带双向一跳 relations（关联正文及时间），包括对它的更正；需要继续追溯时按关联笔记 id 查询。不要把已被更正的旧内容直接当作现状。queries 内并发，结果按原顺序返回 notes 与 hasMore。关键词为不区分大小写的字面子串，按创建时间、ID 倒序分页。每批 1–10 项，每项最多 50 条。",
  parameters: Schema.toJsonSchemaDocument(NotebookQueryArguments).schema,
}

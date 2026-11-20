import { Schema } from "effect"

export class InvalidReply extends Schema.TaggedError<InvalidReply>()("InvalidReply", { reason: Schema.String }) {
  override get message(): string {
    return `无效的模型回复：${this.reason}`
  }
}

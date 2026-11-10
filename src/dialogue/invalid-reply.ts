import { Schema } from "effect"

export class InvalidReply extends Schema.TaggedError<InvalidReply>()("InvalidReply", { reason: Schema.String }) {}

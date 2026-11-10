import { Schema } from "effect"

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  path: Schema.String,
  field: Schema.String,
  reason: Schema.String,
}) {}

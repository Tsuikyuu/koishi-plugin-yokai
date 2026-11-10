import { open } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { parseDocument } from "yaml"

export class YamlFileError extends Schema.TaggedError<YamlFileError>()("YamlFileError", {
  path: Schema.String,
  reason: Schema.String,
}) {}

// 固定边界上限，不提供面向未来的解析器配置。错误不包含原文或解析器异常。
export const readYamlFile = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = await open(path, "r")
      try {
        const buffer = Buffer.alloc(1024 * 1024 + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length)
          if (bytesRead === 0) break
          length += bytesRead
        }
        if (length === buffer.length) throw new Error("size")
        const doc = parseDocument(buffer.subarray(0, length).toString("utf8"), {
          schema: "core",
          uniqueKeys: true,
          strict: true,
        })
        if (doc.errors.length > 0 || doc.warnings.length > 0) throw new Error("yaml")
        return doc.toJS({ maxAliasCount: 50 }) as unknown
      } finally {
        await file.close()
      }
    },
    catch: () =>
      new YamlFileError({ path, reason: "无法读取有效 YAML（上限 1 MiB；禁止重复键、自定义标签及过量别名展开）" }),
  })

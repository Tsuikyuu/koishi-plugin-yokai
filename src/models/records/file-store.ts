import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { ModelTraceError, ModelTraceStore } from "./store"

// 每次调用独立目录，避免并发追加相互覆盖；不保存鉴权头、密钥或原始异常。
export const ModelTraceStoreFile = (directory: string) =>
  Layer.succeed(
    ModelTraceStore,
    ModelTraceStore.of({
      begin: (model, input) =>
        Effect.tryPromise({
          try: async () => {
            const startedAt = new Date().toISOString()
            const id = `${startedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`
            await mkdir(directory, { recursive: true, mode: 0o700 })
            const path = join(directory, id)
            await mkdir(path, { mode: 0o700 })
            await writeFile(
              join(path, "input.json"),
              JSON.stringify({ id, startedAt, model, ...input }, null, 2) + "\n",
              { flag: "wx", mode: 0o600 },
            )
            return id
          },
          catch: () => new ModelTraceError({ operation: "begin" }),
        }),
      finish: (id, outcome) =>
        Effect.tryPromise({
          try: async () => {
            const path = join(directory, id)
            const temporary = join(path, "result.json.tmp")
            await writeFile(
              temporary,
              JSON.stringify({ id, finishedAt: new Date().toISOString(), ...outcome }, null, 2) + "\n",
              { flag: "wx", mode: 0o600 },
            )
            await rename(temporary, join(path, "result.json"))
          },
          catch: () => new ModelTraceError({ operation: "finish" }),
        }),
    }),
  )

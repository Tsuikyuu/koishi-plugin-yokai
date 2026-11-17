import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { HTTP } from "koishi"
import { Effect, Layer, Result } from "effect"
import { ChannelMediaStore, type StoredMedia } from "./media"
import { MaxImageBytes, detectImageMimeType } from "../media/image"

const Sha256 = /^[0-9a-f]{64}$/

const fromDataUrl = (url: string): Uint8Array | undefined => {
  const match = /^data:([^,]*?);base64,(.*)$/s.exec(url)
  if (!match) return undefined
  try {
    return new Uint8Array(Buffer.from(match[2]!, "base64"))
  } catch {
    return undefined
  }
}

// 只接受 http(s)、data:、Satori internal: 与 baseDir 内的 file:；其他协议不抓取。
const fetchBytes = (http: HTTP, url: string) =>
  Effect.tryPromise({
    try: async (signal): Promise<Uint8Array> => {
      const { data } = await http(url, {
        method: "GET",
        signal,
        timeout: 15000,
        validateStatus: () => true,
        responseType: async (raw) => {
          if (!raw.ok) {
            await raw.body?.cancel()
            throw new Error(`HTTP ${raw.status}`)
          }
          const declared = Number(raw.headers.get("content-length") ?? "")
          if (Number.isFinite(declared) && declared > MaxImageBytes) {
            await raw.body?.cancel()
            throw new Error("size")
          }
          const reader = raw.body?.getReader()
          if (reader === undefined) return new Uint8Array(await raw.arrayBuffer())
          const chunks: Uint8Array[] = []
          let total = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > MaxImageBytes) {
              await reader.cancel()
              throw new Error("size")
            }
            chunks.push(value)
          }
          const bytes = new Uint8Array(total)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          return bytes
        },
      })
      return data as Uint8Array
    },
    catch: (error) => (error instanceof Error ? error.message : "transport"),
  })

// Satori 的 internal: 临时资源由框架处理；仅在此处读取字节并检查大小。
const readInternal = (http: HTTP, url: string) =>
  Effect.tryPromise({
    try: async (): Promise<Uint8Array> => {
      const file = await http.file(url, { timeout: 15000 })
      if (file.data.byteLength > MaxImageBytes) throw new Error("size")
      return new Uint8Array(file.data)
    },
    catch: (error) => (error instanceof Error ? error.message : "internal"),
  })

// 本地资源只允许 Koishi baseDir 内的文件，避免把消息中的任意路径读入。
const readLocal = (baseDir: string, url: string) =>
  Effect.tryPromise({
    try: async (): Promise<Uint8Array> => {
      const path = fileURLToPath(new URL(url))
      const root = resolve(baseDir)
      const part = relative(root, path)
      if (part === "" || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("path")
      const info = await stat(path)
      if (!info.isFile() || info.size > MaxImageBytes) throw new Error("size")
      return new Uint8Array(await readFile(path))
    },
    catch: (error) => (error instanceof Error ? error.message : "file"),
  })

export const channelMediaStoreFile = (
  http: HTTP,
  directory: string,
  baseDir: string,
): ChannelMediaStore["Service"] => {
  const persist = (bytes: Uint8Array) =>
    Effect.gen(function* () {
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const path = join(directory, sha256)
      const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
      yield* Effect.tryPromise(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(temporary, bytes, { mode: 0o600 })
        await rename(temporary, path)
      })
      return sha256
    })

  return {
    ingest: (url) =>
      Effect.gen(function* () {
        let bytes = fromDataUrl(url)
        if (bytes === undefined) {
          const source = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? ""
          const load =
            source === "file:"
              ? readLocal(baseDir, url)
              : source === "internal:"
                ? readInternal(http, url)
                : source === "http:" || source === "https:"
                  ? fetchBytes(http, url)
                  : Effect.fail("unsupported")
          const fetched = yield* Effect.result(load)
          if (Result.isSuccess(fetched)) bytes = fetched.success
          else yield* Effect.logDebug(`图片获取失败（${fetched.failure}），本轮标记为不可用`)
        }
        if (bytes === undefined) return undefined
        if (bytes.byteLength === 0 || bytes.byteLength > MaxImageBytes) {
          yield* Effect.logDebug("图片大小超出限制，本轮标记为不可用")
          return undefined
        }
        const mimeType = detectImageMimeType(bytes)
        if (mimeType === undefined) {
          yield* Effect.logDebug("图片格式不受支持，本轮标记为不可用")
          return undefined
        }
        const stored = yield* Effect.result(persist(bytes))
        if (Result.isFailure(stored)) {
          yield* Effect.logWarning("图片写入媒体目录失败，本轮标记为不可用")
          return undefined
        }
        return { sha256: stored.success, mimeType, byteLength: bytes.byteLength } satisfies StoredMedia
      }),
    read: (sha256) => {
      if (!Sha256.test(sha256)) return Effect.succeed(undefined)
      return Effect.gen(function* () {
        const loaded = yield* Effect.result(Effect.tryPromise(() => readFile(join(directory, sha256))))
        if (Result.isFailure(loaded)) {
          yield* Effect.logDebug("媒体文件缺失，跳过附加")
          return undefined
        }
        return new Uint8Array(loaded.success)
      })
    },
  }
}

export const ChannelMediaStoreFile = (http: HTTP, directory: string, baseDir: string) =>
  Layer.succeed(ChannelMediaStore, channelMediaStoreFile(http, directory, baseDir))

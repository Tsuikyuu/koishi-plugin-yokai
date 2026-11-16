import { createHash } from "node:crypto"
import { readdir, readFile, realpath } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Layer } from "effect"
import type { CharacterId, StickerId } from "./character"
import { CharacterLoadError } from "./errors"
import { CharacterStickers, type StickerFile } from "./sticker"
import { MaxImageBytes, detectImageMimeType } from "../media/image"

// 文件路径与扩展名由程序维护；预设只声明 ID，程序按同名主干自动发现后缀。
const Extensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])

const isInside = (root: string, path: string) => {
  const part = relative(root, path)
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

interface StickerEntry {
  readonly stem: string
  readonly path: string
}

const listStickers = (root: string, characterId: CharacterId) =>
  Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<StickerEntry>> => {
      const base = resolve(root)
      const directory = resolve(base, characterId, "stickers")
      if (!isInside(base, directory)) throw new Error("path")
      const [realBase, realDirectory] = await Promise.all([realpath(base), realpath(directory)])
      if (!isInside(realBase, realDirectory)) throw new Error("path")
      const entries = await readdir(realDirectory, { withFileTypes: true })
      return entries.flatMap((entry) => {
        if (!entry.isFile()) return []
        const extension = extname(entry.name)
        if (!Extensions.has(extension.toLowerCase())) return []
        return [{ stem: entry.name.slice(0, entry.name.length - extension.length), path: join(realDirectory, entry.name) }]
      })
    },
    catch: () => new CharacterLoadError({ characterId, path: root, reason: "表情包目录不可访问或越出角色目录" }),
  })

const loadSticker = (
  characterId: CharacterId,
  stickerId: StickerId,
  entries: ReadonlyArray<StickerEntry>,
  root: string,
) =>
  Effect.gen(function* () {
    const matched = entries.filter((entry) => entry.stem === stickerId)
    const fail = (reason: string) => new CharacterLoadError({ characterId, path: root, reason: `${stickerId}: ${reason}` })
    if (matched.length === 0) return yield* Effect.fail(fail("未找到同名表情包文件（支持 png/jpg/webp/gif）"))
    if (matched.length > 1) return yield* Effect.fail(fail("存在多个同名表情包文件，请只保留一种格式"))
    const path = matched[0]!.path
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(path),
      catch: () => fail("无法读取表情包文件"),
    })
    if (bytes.byteLength > MaxImageBytes) return yield* Effect.fail(fail("图片超过单张字节上限"))
    const mimeType = detectImageMimeType(bytes)
    if (mimeType === undefined) return yield* Effect.fail(fail("文件内容不是支持的图片格式（PNG/JPEG/WebP/GIF）"))
    return {
      id: stickerId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType,
      bytes,
    } satisfies StickerFile
  })

export const characterStickersFile = (root: string): CharacterStickers["Service"] => ({
  validate: (characterId, stickerIds) =>
    Effect.gen(function* () {
      if (stickerIds.length === 0) return
      const entries = yield* listStickers(root, characterId)
      yield* Effect.forEach(stickerIds, (stickerId) => loadSticker(characterId, stickerId, entries, root), {
        discard: true,
      })
    }),
  load: (characterId, stickerId) =>
    Effect.gen(function* () {
      const entries = yield* listStickers(root, characterId)
      return yield* loadSticker(characterId, stickerId, entries, root)
    }),
})

export const CharacterStickersFile = (root: string) =>
  Layer.succeed(CharacterStickers, characterStickersFile(root))

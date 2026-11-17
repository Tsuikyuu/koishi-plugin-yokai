import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema, type Semaphore } from "effect"
import type { Context } from "koishi"
import { CharacterId } from "./character"
import { MaxCharacterStickers, StickerId, type Sticker, type StickerAsset } from "./sticker"
import { CharacterStickers, StickerConflict, StickerNotFound, StickerStoreError } from "./sticker-store"
import type { StickerRecord } from "./sticker-tables"
import { ImageMimeType, MaxImageBytes, detectImageMimeType } from "../media/image"

const Sha256Pattern = /^[0-9a-f]{64}$/

const Row = Schema.Struct({
  characterId: CharacterId,
  id: StickerId,
  sha256: Schema.String.check(Schema.isPattern(Sha256Pattern)),
  mimeType: ImageMimeType,
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  summary: Schema.NonEmptyString,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
})
const decodeRow = Schema.decodeUnknownSync(Row)

const toSticker = (record: StickerRecord): Sticker => decodeRow(record)

const persistBytes = async (directory: string, sha256: string, bytes: Uint8Array): Promise<void> => {
  const path = join(directory, sha256)
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, path)
}

export const stickerStoreLayer = (
  database: Context["database"],
  serialize: Semaphore.Semaphore["withPermit"],
  directory: string,
) =>
  Layer.succeed(
    CharacterStickers,
    CharacterStickers.of({
      list: Effect.fn("KoishiStickerStore.list")(
        (characterId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await database.get(
                "yokai_sticker",
                { characterId },
                { sort: { createdAt: "asc", id: "asc" } },
              )
              return rows.map(toSticker)
            },
            catch: () => new StickerStoreError({ operation: "list" }),
          }),
        Effect.uninterruptible,
        serialize,
      ),
      load: Effect.fn("KoishiStickerStore.load")(
        (characterId, stickerId) =>
          Effect.tryPromise({
            try: async (): Promise<StickerAsset> => {
              const [row] = await database.get("yokai_sticker", { characterId, id: stickerId })
              if (row === undefined) throw new StickerNotFound({ characterId, stickerId })
              const sticker = toSticker(row)
              let raw: Buffer
              try {
                raw = await readFile(join(directory, sticker.sha256))
              } catch {
                throw new StickerStoreError({ operation: "load", reason: "表情包图片文件缺失或不可读" })
              }
              return { ...sticker, bytes: new Uint8Array(raw) }
            },
            catch: (error) => {
              if (error instanceof StickerNotFound || error instanceof StickerStoreError) return error
              return new StickerStoreError({ operation: "load" })
            },
          }),
        Effect.uninterruptible,
        serialize,
      ),
      save: Effect.fn("KoishiStickerStore.save")(
        (input) =>
          Effect.tryPromise({
            try: async (): Promise<Sticker> => {
              const summary = input.summary.trim()
              if (summary === "") {
                throw new StickerStoreError({ operation: "save", reason: "表情包描述不能为空" })
              }
              if (input.bytes.byteLength === 0 || input.bytes.byteLength > MaxImageBytes) {
                throw new StickerStoreError({ operation: "save", reason: "图片大小超出限制" })
              }
              const detected = detectImageMimeType(input.bytes)
              if (detected === undefined || detected !== input.mimeType) {
                throw new StickerStoreError({ operation: "save", reason: "图片内容与声明格式不符" })
              }
              const computed = createHash("sha256").update(input.bytes).digest("hex")
              if (computed !== input.sha256) {
                throw new StickerStoreError({ operation: "save", reason: "图片哈希校验不一致" })
              }
              await persistBytes(directory, computed, input.bytes)
              const now = new Date()
              try {
                await database.withTransaction(async (transaction) => {
                  const existing = await transaction.get("yokai_sticker", { characterId: input.characterId })
                  if (existing.some((row) => row.id === input.id)) {
                    throw new StickerConflict({ characterId: input.characterId, reason: `表情包 ID ${input.id} 已存在` })
                  }
                  if (existing.some((row) => row.sha256 === computed)) {
                    throw new StickerConflict({ characterId: input.characterId, reason: "相同画面的表情包已存在" })
                  }
                  if (existing.length >= MaxCharacterStickers) {
                    throw new StickerConflict({
                      characterId: input.characterId,
                      reason: `角色表情包数量已达上限 ${MaxCharacterStickers}`,
                    })
                  }
                  await transaction.create("yokai_sticker", {
                    characterId: input.characterId,
                    id: input.id,
                    sha256: computed,
                    mimeType: detected,
                    byteLength: input.bytes.byteLength,
                    summary,
                    createdAt: now,
                    updatedAt: now,
                  })
                })
              } catch (error) {
                const referenced = await database
                  .get("yokai_sticker", { sha256: computed }, { fields: ["id"], limit: 1 })
                  .catch(() => [{ id: "keep" }])
                if (referenced.length === 0) {
                  await rm(join(directory, computed), { force: true }).catch(() => undefined)
                }
                throw error
              }
              const [created] = await database.get("yokai_sticker", { characterId: input.characterId, id: input.id })
              if (created === undefined) throw new StickerStoreError({ operation: "save" })
              return toSticker(created)
            },
            catch: (error) => {
              if (error instanceof StickerConflict || error instanceof StickerStoreError) return error
              return new StickerStoreError({ operation: "save" })
            },
          }),
        Effect.uninterruptible,
        serialize,
      ),
      update: Effect.fn("KoishiStickerStore.update")(
        (characterId, stickerId, summary) =>
          Effect.tryPromise({
            try: async (): Promise<Sticker> => {
              const trimmed = summary.trim()
              if (trimmed === "") throw new StickerStoreError({ operation: "update", reason: "表情包描述不能为空" })
              const now = new Date()
              await database.withTransaction(async (transaction) => {
                const [existing] = await transaction.get("yokai_sticker", { characterId, id: stickerId })
                if (existing === undefined) throw new StickerNotFound({ characterId, stickerId })
                await transaction.set("yokai_sticker", { characterId, id: stickerId }, { summary: trimmed, updatedAt: now })
              })
              const [updated] = await database.get("yokai_sticker", { characterId, id: stickerId })
              if (updated === undefined) throw new StickerStoreError({ operation: "update" })
              return toSticker(updated)
            },
            catch: (error) => {
              if (error instanceof StickerNotFound || error instanceof StickerStoreError) return error
              return new StickerStoreError({ operation: "update" })
            },
          }),
        Effect.uninterruptible,
        serialize,
      ),
      remove: Effect.fn("KoishiStickerStore.remove")(
        (characterId, stickerId) =>
          Effect.tryPromise({
            try: async (): Promise<void> => {
              let orphanSha256: string | undefined
              await database.withTransaction(async (transaction) => {
                const [existing] = await transaction.get("yokai_sticker", { characterId, id: stickerId })
                if (existing === undefined) throw new StickerNotFound({ characterId, stickerId })
                await transaction.remove("yokai_sticker", { characterId, id: stickerId })
                const remaining = await transaction.get(
                  "yokai_sticker",
                  { sha256: existing.sha256 },
                  { fields: ["id"], limit: 1 },
                )
                if (remaining.length === 0) orphanSha256 = existing.sha256
              })
              if (orphanSha256 !== undefined) {
                await rm(join(directory, orphanSha256), { force: true }).catch(() => undefined)
              }
            },
            catch: (error) => {
              if (error instanceof StickerNotFound) return error
              return new StickerStoreError({ operation: "remove" })
            },
          }),
        Effect.uninterruptible,
        serialize,
      ),
    }),
  )

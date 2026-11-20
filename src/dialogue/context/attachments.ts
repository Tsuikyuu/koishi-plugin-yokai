import { Effect } from "effect"
import type { ChannelHistory } from "../../channels/messaging"
import type { Message, MessageId } from "../../channels/message"
import type { ChannelMediaStore } from "../../channels/media"
import { MaxAttachedBytes, MaxAttachedImages, type ImageMimeType } from "../../media/image"
import type { ChannelTrigger } from "../trigger"

export interface ImageCandidate {
  readonly messageId: MessageId
  readonly part: number
  readonly sha256: string
  readonly mimeType: ImageMimeType
  readonly byteLength: number
}

export interface ImageAttachment extends ImageCandidate {
  readonly ref: string
  readonly bytes: Uint8Array
}

// 确定性窗口：本次触发消息、被引用消息，再由新到旧补齐历史尾部；同一内容与已知角色贴图不重复附带。
export const selectImages = (
  history: ChannelHistory,
  trigger: ChannelTrigger,
  knownStickerHashes: ReadonlySet<string> = new Set(),
  limit: number = MaxAttachedImages,
): ReadonlyArray<ImageCandidate> => {
  const queue: Message[] = []
  if (trigger.type === "message") {
    const incomingById = new Map(trigger.messages.map((message) => [message.id, message]))
    for (const message of [...trigger.messages].reverse()) {
      queue.push(message)
      const quote = message.quote
      const quoted =
        quote === undefined
          ? undefined
          : (incomingById.get(quote) ?? history.messages.find((message) => message.id === quote))
      if (quoted !== undefined) queue.push(quoted)
    }
  }
  queue.push(...[...history.messages].reverse())

  const seen = new Set<string>(knownStickerHashes)
  const selected: ImageCandidate[] = []
  let bytes = 0
  for (const message of queue) {
    for (const [part, item] of message.parts.entries()) {
      if (selected.length === limit) return selected
      if (item.type !== "image" || !("sha256" in item)) continue
      if (item.stickerId !== undefined) continue
      if (seen.has(item.sha256)) continue
      if (bytes + item.byteLength > MaxAttachedBytes) continue
      seen.add(item.sha256)
      bytes += item.byteLength
      selected.push({
        messageId: message.id,
        part,
        sha256: item.sha256,
        mimeType: item.mimeType,
        byteLength: item.byteLength,
      })
    }
  }
  return selected
}

export const countAvailableImages = (
  history: ChannelHistory,
  trigger: ChannelTrigger,
  knownStickerHashes: ReadonlySet<string> = new Set(),
): number => {
  const seen = new Set<string>(knownStickerHashes)
  let count = 0
  const messages = [
    ...(trigger.type === "message" ? trigger.messages : []),
    ...history.messages,
  ]
  for (const message of messages) {
    for (const item of message.parts) {
      if (item.type !== "image" || !("sha256" in item) || item.stickerId !== undefined) continue
      if (seen.has(item.sha256)) continue
      seen.add(item.sha256)
      count++
    }
  }
  return count
}

// 读取窗口内图片字节；媒体缺失时跳过，上下文以 attached="false" 表示未附带。
export const loadImageAttachments = (
  media: ChannelMediaStore["Service"],
  history: ChannelHistory,
  trigger: ChannelTrigger,
  knownStickerHashes: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const selected = selectImages(history, trigger, knownStickerHashes)
    const attachments: ImageAttachment[] = []
    for (const candidate of selected) {
      const bytes = yield* media.read(candidate.sha256)
      if (bytes === undefined) continue
      attachments.push({ ...candidate, ref: `img_${attachments.length + 1}`, bytes })
    }
    return attachments
  })

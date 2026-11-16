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

// 确定性窗口：本次触发消息、被引用消息，再由新到旧补齐历史尾部；同一内容只附带一次。
export const selectImages = (
  history: ChannelHistory,
  trigger: ChannelTrigger,
  limit: number = MaxAttachedImages,
): ReadonlyArray<ImageCandidate> => {
  const queue: Message[] = []
  if (trigger.type === "message") {
    queue.push(trigger.message)
    const quote = trigger.message.quote
    const quoted = quote === undefined ? undefined : history.messages.find((message) => message.id === quote)
    if (quoted !== undefined) queue.push(quoted)
  }
  queue.push(...[...history.messages].reverse())

  const seen = new Set<string>()
  const selected: ImageCandidate[] = []
  let bytes = 0
  for (const message of queue) {
    for (const [part, item] of message.parts.entries()) {
      if (selected.length === limit) return selected
      if (item.type !== "image" || !("sha256" in item)) continue
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

// 读取窗口内图片字节；媒体缺失时跳过，上下文以 attached="false" 表示未附带。
export const loadImageAttachments = (
  media: ChannelMediaStore["Service"],
  history: ChannelHistory,
  trigger: ChannelTrigger,
) =>
  Effect.gen(function* () {
    const attachments: ImageAttachment[] = []
    for (const candidate of selectImages(history, trigger)) {
      const bytes = yield* media.read(candidate.sha256)
      if (bytes === undefined) continue
      attachments.push({ ...candidate, ref: `img_${attachments.length + 1}`, bytes })
    }
    return attachments
  })

import { Context, type Effect } from "effect"
import type { ImageMimeType } from "../media/image"

// 内容寻址的媒体元数据；字节不在数据库中重复保存。
export interface StoredMedia {
  readonly sha256: string
  readonly mimeType: ImageMimeType
  readonly byteLength: number
}

export class ChannelMediaStore extends Context.Service<
  ChannelMediaStore,
  {
    // 下载并落盘入站图片；失败或格式不受支持时返回 undefined，由调用方标为不可用。
    readonly ingest: (url: string) => Effect.Effect<StoredMedia | undefined>
    readonly read: (sha256: string) => Effect.Effect<Uint8Array | undefined>
  }
>()("yokai/channels/ChannelMediaStore") {}

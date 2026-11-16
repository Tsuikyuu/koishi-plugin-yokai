import { Schema } from "effect"

// 三家常选供应商都按真实文件内容识别格式；这里保持同一集合，避免声明与实际不符。
export const ImageMimeType = Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"])
export type ImageMimeType = typeof ImageMimeType.Type

// 单张图片的字节上限；DeepSeek 与 OpenAI 远高于此，Gemini 单请求 20MB，按张数分摊仍有余量。
export const MaxImageBytes = 10 * 1024 * 1024
// 单轮随上下文附带的图片总字节上限，避免一次请求携带过多二进制。
export const MaxAttachedBytes = 12 * 1024 * 1024
// 单轮随上下文附带的图片数量上限。
export const MaxAttachedImages = 4

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>) => {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

export const detectImageMimeType = (bytes: Uint8Array): ImageMimeType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp"
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif"
  return undefined
}

import { Schema } from "effect"

// 三家常选供应商都按真实文件内容识别格式；这里保持同一集合，避免声明与实际不符。
export const ImageMimeType = Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"])
export type ImageMimeType = typeof ImageMimeType.Type

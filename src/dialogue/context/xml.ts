import type { Message } from "../../channels/message"

export const escapeXml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  )
export const element = (tag: string, text: string) => `<${tag}>${escapeXml(text)}</${tag}>`

// refs 的键为 `${messageId}:${partIndex}`；只有本轮实际附带画面的图片带 ref。
export const messageXml = (message: Message, refs: ReadonlyMap<string, string> = new Map()) => {
  const content = message.parts
    .map((part, index) => {
      if (part.type === "text") return `<text>${escapeXml(part.text)}</text>`
      if (part.type === "at")
        return `<at user="${escapeXml(part.target)}"${part.name === undefined ? "" : ` name="${escapeXml(part.name)}"`} />`
      const stickerId = "stickerId" in part ? part.stickerId : undefined
      const summary = "summary" in part ? part.summary : undefined
      if (stickerId !== undefined)
        return `<sticker id="${escapeXml(stickerId)}">${summary === undefined ? "" : escapeXml(summary)}</sticker>`
      const ref = refs.get(`${message.id}:${index}`)
      return `<image kind="${part.kind}"${ref === undefined ? ' attached="false"' : ` attached="true" ref="${escapeXml(ref)}"`} />`
    })
    .join("")
  return `<message id="${escapeXml(message.id)}" sender="${escapeXml(message.sender)}" time="${message.time}"${
    message.quote === undefined ? "" : ` quote="${escapeXml(message.quote)}"`
  }>${content}</message>`
}

export const localTime = (time: number, timezone: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(time)

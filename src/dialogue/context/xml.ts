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
export const messageXml = (message: Message) =>
  `<message id="${escapeXml(message.id)}" sender="${escapeXml(message.sender)}" time="${message.time}"${
    message.quote === undefined ? "" : ` quote="${escapeXml(message.quote)}"`
  }>${element("text", message.text)}</message>`

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

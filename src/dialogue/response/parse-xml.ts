import { Effect, Schema } from "effect"
import { ChannelResponse } from "./response"
import { ResponseParseError, type ChannelResponseParser } from "./parser"
import { attributes, container, invalid, responseSections, text } from "./xml-reader"

// 纯解析供提示词中的预设示例复用；运行时入口将解析失败映射为类型化错误。
export const decodeChannelResponse = (xml: string): ChannelResponse => {
  const [think, actions, status] = responseSections(xml)
  attributes(think)
  const parsedActions = container(actions).map((node, index) => {
    switch (node.name) {
      case "message":
        attributes(node, [], ["quote"])
        return { type: "message", text: text(node), ...node.attributes }
      case "note-add":
        attributes(node, [], ["supplements", "corrects"])
        const links = (["supplements", "corrects"] as const).flatMap((kind) => {
          const ids = node.attributes[kind]
          if (ids === undefined) return []
          if (ids.trim() === "") return invalid()
          return ids
            .trim()
            .split(/\s+/)
            .map((noteId) => ({ kind, noteId }))
        })
        if (new Set(links.map((link) => link.noteId)).size !== links.length) return invalid()
        return { type: "note-add", text: text(node), ...(links.length === 0 ? {} : { links }) }
      case "routine": {
        attributes(node, ["start", "end"])
        const start = node.attributes.start
        const end = node.attributes.end
        if (start === undefined || end === undefined) return invalid()
        return { type: "routine", start, end, activity: text(node) }
      }
      case "next-reply": {
        attributes(node, ["type", "user_id"], ["seconds", "max_wait_seconds", "group"])
        const condition = node.attributes.type
        const userId = node.attributes.user_id
        if (condition !== "message_from_user" && condition !== "silence") return invalid()
        if (userId === undefined) return invalid()
        text(node)
        const seconds = node.attributes.seconds
        const maxWaitSeconds = node.attributes.max_wait_seconds
        if (seconds !== undefined && !/^\d+$/.test(seconds)) return invalid()
        if (maxWaitSeconds !== undefined && !/^\d+$/.test(maxWaitSeconds)) return invalid()
        return {
          type: "next-reply",
          condition,
          userId,
          ...(seconds === undefined ? {} : { seconds: Number.parseInt(seconds, 10) }),
          ...(maxWaitSeconds === undefined ? {} : { maxWaitSeconds: Number.parseInt(maxWaitSeconds, 10) }),
          group: node.attributes.group ?? `next-${index}`,
        }
      }
      default:
        throw new ResponseParseError({
          reason: `actions 包含不支持的元素 <${node.name}>；仅允许 message、note-add、routine 和 next-reply`,
        })
    }
  })
  const patch: Record<string, string> = {}
  for (const node of container(status)) {
    if (Object.hasOwn(patch, node.name)) invalid()
    attributes(node)
    patch[node.name] = text(node)
  }
  return Schema.decodeUnknownSync(ChannelResponse, { onExcessProperty: "error" })({
    think: text(think),
    actions: parsedActions,
    status: patch,
  })
}

export const parseChannelResponse: ChannelResponseParser = (xml) =>
  Effect.try({
    try: () => decodeChannelResponse(xml),
    catch: (error) =>
      error instanceof ResponseParseError
        ? error
        : new ResponseParseError({
            reason:
              "频道响应 XML 结构或字段无效：response 应依次包含 think、actions、status；message/note-add/routine 正文须为纯文本，笔记关联使用 supplements/corrects 属性，routine 使用 start/end 属性，next-reply 使用 type/user_id 属性",
          }),
  })

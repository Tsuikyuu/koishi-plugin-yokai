import { Effect, Schema, SchemaIssue } from "effect"
import { ChannelResponse } from "./response"
import { ResponseParseError, type ChannelResponseParser } from "./parser"
import { attributes, container, invalid, messageSegments, responseSections, text } from "./xml-reader"

type MessageSegment = { readonly text: string } | { readonly at: string }
type OutboundPart = { readonly type: "text"; readonly text: string } | { readonly type: "at"; readonly user: string }
const LinkKinds: ReadonlyArray<"supplements" | "corrects"> = ["supplements", "corrects"]

const formatPathPart = (part: unknown): string => {
  if (typeof part === "string") return part
  if (typeof part === "number") return `${part}`
  if (typeof part === "object" && part !== null && "key" in part) return formatPathPart(part.key)
  return ""
}

// 去掉首尾标注用的空白与空文本片段；正文内部的空白保持原样。
const trimParts = (segments: ReadonlyArray<MessageSegment>): ReadonlyArray<OutboundPart> => {
  const first = segments.findIndex((segment) => "text" in segment)
  let last = -1
  for (let index = segments.length - 1; index >= 0; index--) {
    if ("text" in segments[index]!) {
      last = index
      break
    }
  }
  const parts: OutboundPart[] = []
  for (const [index, segment] of segments.entries()) {
    if ("at" in segment) {
      parts.push({ type: "at", user: segment.at })
      continue
    }
    const start = index === first ? segment.text.trimStart() : segment.text
    const value = index === last ? start.trimEnd() : start
    if (value !== "") parts.push({ type: "text", text: value })
  }
  return parts
}

// 纯解析供提示词中的预设示例复用；运行时入口将解析失败映射为类型化错误。
export const decodeChannelResponse = (xml: string): ChannelResponse => {
  const { think, actions, status, nextReplies } = responseSections(xml)
  attributes(think)
  const parsedActions = container(actions).map((node) => {
    switch (node.name) {
      case "message": {
        attributes(node, [], ["quote"])
        const parts = trimParts(messageSegments(node))
        if (parts.length === 0) return invalid("<message> 正文不能为空")
        const quote = node.attributes.quote
        return { type: "message", parts, ...(quote === undefined ? {} : { quote }) }
      }
      case "sticker": {
        attributes(node, ["id"], ["quote"])
        if (text(node).trim() !== "") return invalid("<sticker /> 必须是空元素")
        const quote = node.attributes.quote
        return { type: "sticker", stickerId: node.attributes.id, ...(quote === undefined ? {} : { quote }) }
      }
      case "sticker-save": {
        attributes(node, ["ref", "id"])
        const summary = text(node).trim()
        if (summary === "") return invalid("<sticker-save> 必须填写非空画面与场合描述")
        return { type: "sticker-save", ref: node.attributes.ref, stickerId: node.attributes.id, summary }
      }
      case "sticker-update": {
        attributes(node, ["id"])
        const summary = text(node).trim()
        if (summary === "") return invalid("<sticker-update> 必须填写非空描述文本")
        return { type: "sticker-update", stickerId: node.attributes.id, summary }
      }
      case "sticker-delete": {
        attributes(node, ["id"])
        if (text(node).trim() !== "") return invalid("<sticker-delete /> 必须是空元素")
        return { type: "sticker-delete", stickerId: node.attributes.id }
      }
      case "note-add": {
        attributes(node, [], ["supplements", "corrects"])
        const links = LinkKinds.flatMap((kind) => {
          const ids = node.attributes[kind]
          if (ids === undefined) return []
          if (ids.trim() === "") return invalid(`<note-add> 的 ${kind} 属性不能为空`)
          return ids
            .trim()
            .split(/\s+/)
            .map((noteId) => ({ kind, noteId }))
        })
        if (new Set(links.map((link) => link.noteId)).size !== links.length) {
          return invalid("<note-add> 同一关联笔记 ID 不能重复出现")
        }
        return { type: "note-add", text: text(node), ...(links.length === 0 ? {} : { links }) }
      }
      case "routine": {
        attributes(node, ["start", "end"])
        const start = node.attributes.start
        const end = node.attributes.end
        if (start === undefined || end === undefined) return invalid("<routine> 缺少 start 或 end 属性")
        return { type: "routine", start, end, activity: text(node) }
      }
      case "next-reply":
        return invalid("<next-reply /> 应放在 <response> 末尾（</actions> 或 </status> 之后），不能写在 <actions> 内")
      default:
        return invalid(`actions 包含不支持的元素 <${node.name}>`)
    }
  })
  const parsedNextReplies = nextReplies.map((node, index) => {
    attributes(node, ["type", "user_id"], ["seconds", "max_wait_seconds", "group"])
    const condition = node.attributes.type
    const userId = node.attributes.user_id
    if (condition !== "message_from_user" && condition !== "silence") {
      return invalid("<next-reply> 的 type 必须为 message_from_user 或 silence")
    }
    if (userId === undefined) return invalid("<next-reply> 缺少必填属性 user_id")
    if (text(node).trim() !== "") return invalid("<next-reply /> 必须是空元素")
    const seconds = node.attributes.seconds
    const maxWaitSeconds = node.attributes.max_wait_seconds
    if (seconds !== undefined && !/^\d+$/.test(seconds)) {
      return invalid("<next-reply> 的 seconds 必须为整数")
    }
    if (maxWaitSeconds !== undefined && !/^\d+$/.test(maxWaitSeconds)) {
      return invalid("<next-reply> 的 max_wait_seconds 必须为整数")
    }
    return {
      type: "next-reply",
      condition,
      userId,
      ...(seconds === undefined ? {} : { seconds: Number.parseInt(seconds, 10) }),
      ...(maxWaitSeconds === undefined ? {} : { maxWaitSeconds: Number.parseInt(maxWaitSeconds, 10) }),
      group: node.attributes.group ?? `next-${index}`,
    }
  })
  const patch: Record<string, string> = {}
  if (status !== undefined) {
    for (const node of container(status)) {
      if (Object.hasOwn(patch, node.name)) invalid(`<status> 中字段 <${node.name}> 重复出现`)
      attributes(node)
      patch[node.name] = text(node)
    }
  }
  try {
    return Schema.decodeUnknownSync(ChannelResponse, { onExcessProperty: "error" })({
      think: text(think),
      actions: parsedActions,
      status: patch,
      nextReplies: parsedNextReplies,
    })
  } catch (error) {
    if (Schema.isSchemaError(error)) {
      const issue = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0]
      const path = issue?.path?.map(formatPathPart).filter((item) => item !== "").join(".")
      return invalid(`字段值不符合协议约束${path ? `（${path}）` : ""}`)
    }
    return invalid("频道响应字段校验不通过")
  }
}

export const parseChannelResponse: ChannelResponseParser = (xml) =>
  Effect.try({
    try: () => decodeChannelResponse(xml),
    catch: (error) =>
      error instanceof ResponseParseError
        ? error
        : new ResponseParseError({ reason: "频道响应 XML 解析异常" }),
  })

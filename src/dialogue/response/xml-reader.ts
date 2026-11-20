import { SaxesParser } from "saxes"
import { ResponseParseError } from "./parser"

type Segment = { readonly kind: "text"; readonly value: string } | { readonly kind: "element"; readonly node: Node }

interface Node {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: Node[]
  // 文本与子元素的交错顺序；message 内联 <at /> 依赖该顺序。
  readonly segments: Segment[]
  text: string
}
export const invalid = (reason: string): never => {
  throw new ResponseParseError({ reason })
}

export const attributes = (node: Node, required: ReadonlyArray<string> = [], optional: ReadonlyArray<string> = []) => {
  const unsupported = Object.keys(node.attributes).find((name) => !required.includes(name) && !optional.includes(name))
  if (unsupported !== undefined) {
    invalid(`<${node.name}> 包含不支持的属性 ${unsupported}`)
  }
  const missing = required.find((name) => !Object.hasOwn(node.attributes, name))
  if (missing !== undefined) {
    invalid(`<${node.name}> 缺少必填属性 ${missing}`)
  }
}
export const container = (node: Node) => {
  attributes(node)
  if (node.text.trim() !== "") invalid(`<${node.name}> 内不允许直接包含裸文本`)
  return node.children
}
export const text = (node: Node) => {
  if (node.children.length !== 0) invalid(`<${node.name}> 内不允许嵌套子元素 <${node.children[0]!.name}>`)
  return node.text
}

// message 仅允许文本与空元素 <at user="..." /> 交错出现。
export const messageSegments = (
  node: Node,
): ReadonlyArray<{ readonly text: string } | { readonly at: string }> => {
  const result: Array<{ readonly text: string } | { readonly at: string }> = []
  for (const segment of node.segments) {
    if (segment.kind === "text") {
      result.push({ text: segment.value })
      continue
    }
    const child = segment.node
    if (child.name !== "at") invalid(`<message> 内仅允许内联 <at user="ID" />，不支持 <${child.name}>`)
    if (child.children.length !== 0 || child.text.trim() !== "") invalid("<at /> 必须是空元素")
    attributes(child, ["user"])
    const user = child.attributes.user
    if (user === undefined) return invalid("<at /> 缺少必填属性 user")
    result.push({ at: user })
  }
  return result
}

export interface ResponseSections {
  readonly think: Node
  readonly actions: Node
  readonly status: Node | undefined
  readonly nextReplies: ReadonlyArray<Node>
}

// 读取响应 XML 顶层段落；think 与 actions 必填，status 及末尾零至多条 next-reply 可选。
export const responseSections = (xml: string): ResponseSections => {
  if (new TextEncoder().encode(xml).length > 1024 * 1024) invalid("响应 XML 体积超出上限")
  const stack: Node[] = []
  const roots: Node[] = []
  const parser = new SaxesParser({ xmlns: false })
  parser.on("error", () => invalid("XML 语法无效（标签未闭合或包含未转义的特殊字符）"))
  parser.on("doctype", () => invalid("响应 XML 不允许包含 DOCTYPE"))
  parser.on("processinginstruction", () => invalid("响应 XML 不允许包含处理指令"))
  parser.on("comment", () => invalid("响应 XML 不允许包含注释"))
  parser.on("xmldecl", (declaration) => {
    if (declaration.version !== "1.0") invalid("仅支持 XML 1.0 声明")
  })
  parser.on("opentag", (tag) => {
    if (stack.length === 0 && roots.length === 0 && tag.name !== "response") {
      invalid(`缺少 <response> 根元素（实际根元素为 <${tag.name}>）`)
    }
    if (stack.length >= 16) invalid("XML 标签嵌套层级过深")
    const node: Node = { name: tag.name, attributes: tag.attributes, children: [], segments: [], text: "" }
    const parent = stack.at(-1)
    if (parent === undefined) roots.push(node)
    else {
      parent.children.push(node)
      parent.segments.push({ kind: "element", node })
    }
    stack.push(node)
  })
  const addText = (value: string) => {
    const node = stack.at(-1)
    if (node === undefined) {
      if (value.trim() !== "") invalid("不能在 <response> 外输出正文或 Markdown 围栏")
    } else {
      node.text += value
      node.segments.push({ kind: "text", value })
    }
  }
  parser.on("text", addText)
  parser.on("cdata", addText)
  parser.on("closetag", () => {
    stack.pop()
  })
  parser.write(xml).close()
  const root = roots[0]
  if (roots.length === 0 || root === undefined) return invalid("响应内容为空，缺少 <response> 根元素")
  if (roots.length > 1 || root.name !== "response") return invalid("只允许单个 <response> 根元素")
  const sections = container(root)
  const first = sections[0]
  const second = sections[1]
  if (first?.name === "think" && second?.name === "actions") {
    const hasStatus = sections[2]?.name === "status"
    const status = hasStatus ? sections[2] : undefined
    const tail = sections.slice(hasStatus ? 3 : 2)
    if (tail.every((node) => node.name === "next-reply")) {
      return { think: first, actions: second, status, nextReplies: tail }
    }
  }
  const actual = sections.map((node) => node.name).join(", ")
  return invalid(`<response> 子元素实际为 [${actual || "空"}]，应依次为 <think>、<actions>、可选的 <status> 及末尾可选的 <next-reply>`)
}

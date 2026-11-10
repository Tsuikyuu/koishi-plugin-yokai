import { SaxesParser } from "saxes"
import { ResponseParseError } from "./parser"

interface Node {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: Node[]
  text: string
}
export const invalid = (): never => {
  throw new Error("invalid response")
}

export const attributes = (node: Node, required: ReadonlyArray<string> = [], optional: ReadonlyArray<string> = []) => {
  if (
    Object.keys(node.attributes).some((name) => !required.includes(name) && !optional.includes(name)) ||
    required.some((name) => !Object.hasOwn(node.attributes, name))
  )
    invalid()
}
export const container = (node: Node) => {
  attributes(node)
  if (node.text.trim() !== "") invalid()
  return node.children
}
export const text = (node: Node) => {
  if (node.children.length !== 0) invalid()
  return node.text
}

// 两个阶段的响应共用 XML 读取；动作与状态语义分别由各自解析器处理。
export const responseSections = (xml: string): readonly [Node, Node, Node] => {
  if (new TextEncoder().encode(xml).length > 1024 * 1024) invalid()
  const stack: Node[] = []
  const roots: Node[] = []
  const parser = new SaxesParser({ xmlns: false })
  parser.on("error", invalid)
  parser.on("doctype", invalid)
  parser.on("processinginstruction", invalid)
  parser.on("comment", invalid)
  parser.on("xmldecl", (declaration) => {
    if (declaration.version !== "1.0") invalid()
  })
  parser.on("opentag", (tag) => {
    if (stack.length === 0 && roots.length === 0 && tag.name !== "response") {
      throw new ResponseParseError({
        reason: "频道响应缺少 <response> 根元素：think、actions、status 必须放在同一个 <response>...</response> 内",
      })
    }
    if (stack.length >= 16) invalid()
    const node: Node = { name: tag.name, attributes: tag.attributes, children: [], text: "" }
    const parent = stack.at(-1)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
    stack.push(node)
  })
  const addText = (value: string) => {
    const node = stack.at(-1)
    if (node === undefined) {
      if (value.trim() !== "") invalid()
    } else node.text += value
  }
  parser.on("text", addText)
  parser.on("cdata", addText)
  parser.on("closetag", () => {
    stack.pop()
  })
  parser.write(xml).close()
  const root = roots[0]
  if (roots.length !== 1 || root === undefined || root.name !== "response") return invalid()
  const sections = container(root)
  if (sections.length !== 3 || sections.map((node) => node.name).join(",") !== "think,actions,status") return invalid()
  return sections as [Node, Node, Node]
}

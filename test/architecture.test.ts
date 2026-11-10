import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import test from "node:test"
import ts from "typescript"

const root = resolve(__dirname, "../src")
const portable = (path: string) => path.split(sep).join("/")
const moduleOf = (path: string) => (path.includes("/") ? path.split("/")[0] : undefined)
const architecture = (async () => {
  const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".ts")).map(portable)
  return Promise.all(
    files.map(async (path) => {
      const filename = join(root, path)
      const source = ts.createSourceFile(filename, await readFile(filename, "utf8"), ts.ScriptTarget.Latest, true)
      const imports = source.statements.flatMap((node) => {
        if (
          (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) ||
          !node.moduleSpecifier ||
          !ts.isStringLiteral(node.moduleSpecifier)
        )
          return []
        const specifier = node.moduleSpecifier.text
        const target = specifier.startsWith(".")
          ? portable(relative(root, `${resolve(dirname(filename), specifier)}.ts`))
          : undefined
        if (specifier.startsWith("."))
          assert.ok(target && files.includes(target), `${path}: unresolved local import ${specifier}`)
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined
        const runtimeNames =
          clause?.isTypeOnly || (ts.isExportDeclaration(node) && node.isTypeOnly)
            ? []
            : clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
              ? clause.namedBindings.elements
                  .filter((item) => !item.isTypeOnly)
                  .map((item) => (item.propertyName ?? item.name).text)
              : ["*"]
        return [{ specifier, target, runtimeNames }]
      })
      const barrel = source.statements.some((node) => ts.isExportDeclaration(node) && !node.exportClause)
      return { path, imports, barrel }
    }),
  )
})()

test("feature modules form a DAG, including type dependencies", async () => {
  const sources = await architecture
  const graph = new Map<string, Set<string>>()
  for (const source of sources) {
    const from = moduleOf(source.path)
    if (!from) continue // src/index.ts is the Koishi entry, not a feature.
    const dependencies = graph.get(from) ?? new Set<string>()
    graph.set(from, dependencies)
    for (const reference of source.imports) {
      const to = reference.target && moduleOf(reference.target)
      if (to && to !== from) dependencies.add(to)
    }
  }
  const visited = new Set<string>()
  const visit = (current: string, path: readonly string[]) => {
    assert.ok(!path.includes(current), `Module cycle: ${[...path, current].join(" -> ")}`)
    if (visited.has(current)) return
    for (const dependency of graph.get(current) ?? []) visit(dependency, [...path, current])
    visited.add(current)
  }
  for (const module of graph.keys()) visit(module, [])
})

test("features use direct imports and never depend on runtime or configuration", async () => {
  const sources = await architecture
  const oldLayers = new Set(["domain", "application", "infrastructure"])
  assert.deepEqual(
    sources.filter((source) => !source.path.includes("/")).map((source) => source.path),
    ["index.ts"],
  )
  for (const source of sources) {
    assert.ok(!source.path.split("/").some((part) => oldLayers.has(part)), `Horizontal layer restored: ${source.path}`)
    if (source.path === "index.ts")
      assert.equal(source.barrel, false, "The Koishi entry must not re-export all features")
    const from = moduleOf(source.path)
    for (const reference of source.imports) {
      if (!reference.target) continue
      assert.ok(
        reference.target !== "index.ts" && !reference.target.endsWith("/index.ts"),
        `${source.path}: import the owning file, not ${reference.target}`,
      )
      const to = moduleOf(reference.target)
      if (from && from !== "runtime" && from !== "config") {
        assert.ok(to !== "runtime" && to !== "config", `${source.path}: feature depends on ${reference.target}`)
      }
    }
  }
})

test("replaceable service protocols only import contract constructors at runtime", async () => {
  const sources = await architecture
  const constructors = new Set(["Context", "Data", "Schema"])
  // Representative public ports keep adapters out of the contracts they implement.
  for (const path of [
    "characters/catalog.ts",
    "channels/store.ts",
    "models/gateway.ts",
    "notebook/store.ts",
    "scheduling/store.ts",
  ]) {
    const source = sources.find((source) => source.path === path)
    assert.ok(source, `Missing service protocol: ${path}`)
    for (const reference of source.imports) {
      if (!reference.runtimeNames.length) continue
      assert.ok(
        reference.specifier === "effect" && reference.runtimeNames.every((name) => constructors.has(name)),
        `${path}: implementation import ${reference.specifier}`,
      )
    }
  }
})

import { constants } from "node:fs"
import { access, copyFile, lstat, mkdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect } from "effect"
import type { CharacterId } from "./character"
import { CharacterLoadError } from "./errors"

export const DefaultCharacterId = "default"
export const DefaultCharacterFilename = "default.yml"

const isInsideOrSame = (root: string, target: string) => {
  const part = relative(root, target)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

const isNodeCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code

// 兼容编译后产物（lib/index.js）与源码直跑（src/characters/default-preset.ts）两种目录层级定位内置 YAML。
const locateBuiltInPresetFile = async (): Promise<string> => {
  const candidates = [
    resolve(__dirname, "../presets", DefaultCharacterFilename),
    resolve(__dirname, "../../presets", DefaultCharacterFilename),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error("missing built-in preset file")
}

// 当配置包含默认预设映射（default -> default.yml）且目标文件尚不存在时，复制内置 YAML 文件；已有文件保持不变。
export const ensureDefaultPresetFile = (
  dataDirectory: string,
  directory: string,
  presets: ReadonlyArray<readonly [CharacterId, string]>,
) => {
  const match = presets.find(([id, file]) => id === DefaultCharacterId && file === DefaultCharacterFilename)
  if (match === undefined) {
    return Effect.void
  }
  const [characterId] = match
  return Effect.tryPromise({
    try: async () => {
      const target = join(resolve(directory), DefaultCharacterFilename)
      try {
        await lstat(target)
        return
      } catch (error) {
        if (!isNodeCode(error, "ENOENT")) throw error
      }
      const source = await locateBuiltInPresetFile()
      await mkdir(dataDirectory, { recursive: true })
      await mkdir(directory, { recursive: true })
      const [realData, realDir] = await Promise.all([realpath(dataDirectory), realpath(directory)])
      if (!isInsideOrSame(realData, realDir)) {
        throw new Error("outside data/yokai")
      }
      try {
        await copyFile(source, join(realDir, DefaultCharacterFilename), constants.COPYFILE_EXCL)
      } catch (error) {
        if (!isNodeCode(error, "EEXIST")) throw error
      }
    },
    catch: () =>
      new CharacterLoadError({
        characterId,
        path: directory,
        reason: "无法复制内置默认角色预设文件 default.yml",
      }),
  })
}

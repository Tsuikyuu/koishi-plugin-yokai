import { Effect, Layer, Logger, References } from "effect"
import type { Context } from "koishi"
import type { Config } from "../config/schema"

const formatPart = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value)

// Effect 日志作为唯一业务日志入口，最终交给当前插件的 Koishi logger。
// 仅在开启 debug 配置时放行调试日志并提升 Koishi logger 等级；关闭或卸载时恢复原等级。
export const loggerLayer = (ctx: Context, raw: Config): Layer.Layer<never> => {
  const logger = ctx.logger("yokai")
  const initialLevel = logger.level
  let debugEnabled = raw.debug === true
  const syncDebugLevel = (enabled: boolean) => {
    debugEnabled = enabled
    logger.level = enabled ? Math.max(initialLevel, 3) : initialLevel
  }
  return Layer.mergeAll(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          syncDebugLevel(raw.debug === true)
          return ctx.accept(["debug"], (updated: Config) => {
            syncDebugLevel(updated.debug === true)
          })
        }),
        (dispose) =>
          Effect.sync(() => {
            dispose()
            logger.level = initialLevel
          }),
      ),
    ),
    Logger.layer([
      Logger.make(({ message, logLevel, fiber, date }) => {
        if ((logLevel === "Debug" || logLevel === "Trace") && !debugEnabled) return
        const annotations = Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(
          ([key, value]) => `${key}=${formatPart(value)}`,
        )
        const spans = fiber
          .getRef(References.CurrentLogSpans)
          .map(([label, start]) => `${label}=${date.getTime() - start}ms`)
        const tags = [...annotations, ...spans]
        const items: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message]
        const parts = items.map(formatPart)
        const text = `${tags.length ? `[${tags.join(" ")}] ` : ""}${parts.join(" ")}`
        if (logLevel === "Error" || logLevel === "Fatal") logger.error("%s", text)
        else if (logLevel === "Warn") logger.warn("%s", text)
        else if (logLevel === "Debug" || logLevel === "Trace") logger.debug("%s", text)
        else if (logLevel !== "None") logger.info("%s", text)
      }),
    ]),
    Layer.succeed(References.MinimumLogLevel, "Debug"),
  )
}

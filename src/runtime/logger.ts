import { Layer, Logger, References } from "effect"
import type { Context } from "koishi"

// Effect 日志作为唯一业务日志入口，最终交给当前插件的 Koishi logger。
// Effect 侧放行 Debug，是否输出由 Koishi 日志等级决定（logger.levels.yokai: 3 开启调试日志）。
export const loggerLayer = (ctx: Context): Layer.Layer<never> => {
  const logger = ctx.logger("yokai")
  return Layer.merge(
    Logger.layer([
      Logger.make(({ message, logLevel, fiber, date }) => {
        const annotations = Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(
          ([key, value]) => `${key}=${String(value)}`,
        )
        const spans = fiber
          .getRef(References.CurrentLogSpans)
          .map(([label, start]) => `${label}=${date.getTime() - start}ms`)
        const tags = [...annotations, ...spans]
        const parts = (message as ReadonlyArray<unknown>).map((part) =>
          typeof part === "string" ? part : JSON.stringify(part),
        )
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

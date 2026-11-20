import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import type { Context } from "koishi"
import type { Config } from "./config/schema"
import { registerModels } from "./runtime/register-models"
import { registerHistoryModel } from "./channels/register-history"
import { pluginLayer } from "./runtime/plugin-layer"

export { Config } from "./config/schema"
export const name = "yokai"
export const inject = ["database", "http"]
export const reactive = true
export const usage =
  "角色 YAML 文件放在 data/yokai/characters；开启 debug 模式后输出调试日志并将模型调用记录保存在 data/yokai/logs。使用 Koishi 过滤器选择参与的账号与频道。模型密钥在所选供应商的 apiKey 中配置。"

export async function apply(ctx: Context, config: Config) {
  ctx.decline(["version", "timezone", "characters", "roleplay"])
  registerModels(ctx)
  registerHistoryModel(ctx)
  const runtime = ManagedRuntime.make(pluginLayer(ctx, config))
  ctx.on("dispose", () => runtime.dispose())
  const startup = await runtime.runPromiseExit(Effect.void)
  if (Exit.isFailure(startup) && !Cause.hasInterruptsOnly(startup.cause)) throw Cause.squash(startup.cause)
}

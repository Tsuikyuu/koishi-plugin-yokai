import { Schema } from "koishi"
import { ReasoningEfforts } from "../models/openai/config"
import type { Config as PluginConfig } from "./config"

export type Config = PluginConfig

// 控制台通过该名字取用运行时自动获取的模型列表。
export const ModelSchemaName = "yokai-model"

const provider = {
  baseUrl: Schema.string().role("link").description("API 根地址，不含接口路径；省略使用供应商默认值"),
  apiKey: Schema.string().role("secret").description("API 密钥；所选模型的供应商必须填写"),
  timeoutMs: Schema.natural()
    .min(1)
    .default(60000)
    .description("单次模型调用总超时（毫秒），同时遵守 Koishi HTTP 超时设置"),
}

const sampling = {
  temperature: Schema.number().min(0).max(2).description("可选 Temperature"),
  topP: Schema.number().min(0).max(1).description("可选 Top P"),
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    version: Schema.const(1).default(1).hidden(),
    timezone: Schema.string().default("Asia/Shanghai").description("角色日程和新建定时任务的 IANA 时区"),
    models: Schema.object({
      default: Schema.dynamic(ModelSchemaName)
        .default("deepseek/deepseek-chat")
        .description("当前模型，格式为 provider/model；列表由供应商自动获取"),
      deepseek: Schema.object({ ...provider, ...sampling }).description("DeepSeek"),
      openai: Schema.object({
        ...provider,
        api: Schema.union(["chat-completions", "responses"]).default("chat-completions").description("OpenAI API 类型"),
        reasoningEffort: Schema.union(ReasoningEfforts).description("可选推理强度，仅用于支持的模型"),
      }).description("OpenAI"),
    }).description("模型"),
  }),
  Schema.object({
    characters: Schema.object({
      directory: Schema.string()
        .default("characters")
        .description("角色文件目录，相对于 Koishi 的 data/yokai；必须位于该目录内"),
      presets: Schema.dict(String)
        .default({ companion: "companion.yml" })
        .description("角色 ID 到 YAML 文件相对路径的映射；预设正文保存在文件中"),
    }),
    roleplay: Schema.object({
      character: Schema.string().default("companion").description("新频道绑定的默认角色 ID"),
    }),
  }).description("角色文件"),
])

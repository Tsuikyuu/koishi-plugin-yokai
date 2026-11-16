import { Schema } from "koishi"
import { ReasoningEfforts } from "../models/openai/config"
import { ReasoningEfforts as DeepSeekReasoningEfforts } from "../models/deepseek/config"
import { SafetyCategories, SafetyThresholds, ThinkingLevels } from "../models/gemini/config"
import { DefaultBaseUrl } from "../models/provider"
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

export const Config: Schema<any, Config> = Schema.intersect([
  Schema.object({
    version: Schema.const(1).default(1).hidden(),
    timezone: Schema.string().default("Asia/Shanghai").description("角色日程和新建定时任务的 IANA 时区"),
    models: Schema.object({
      default: Schema.dynamic(ModelSchemaName)
        .default("deepseek/deepseek-chat")
        .description("当前模型，格式为 provider/model；列表由供应商自动获取"),
      deepseek: Schema.object({
        ...provider,
        reasoningEffort: Schema.union(DeepSeekReasoningEfforts)
          .description("可选推理强度；none 关闭思考，low/high/max 开启思考；留空使用供应商默认值（当前为 high）"),
        maxOutputTokens: Schema.natural().min(1).max(393216)
          .description("可选生成 token 上限（1–393216），包含思考与回答；留空使用供应商默认值"),
        stopSequences: Schema.array(Schema.string().min(1)).max(16)
          .description("可选停止序列，最多 16 个非空字符串；匹配的序列不包含在输出中；留空或空列表不发送"),
        temperature: Schema.number().min(0).max(2)
          .description("可选 Temperature（0–2）；仅非思考模式生效，思考模式忽略；留空使用供应商默认值"),
        // Schemastery 的 min 是闭区间，以最小正数表达大于 0。
        topP: Schema.number().min(Number.MIN_VALUE).max(1)
          .description("可选 Top P（大于 0 且不超过 1）；deepseek-flash 仅思考模式生效，低于 0.95 按 0.95 处理；deepseek-v4-pro 仅非思考模式生效；留空使用供应商默认值"),
      }).description("DeepSeek"),
      openai: Schema.object({
        ...provider,
        // 接受已保存的 Responses 配置，控制台不再提供接口选择。
        api: Schema.const("responses").default("responses").hidden(),
        reasoningEffort: Schema.union(ReasoningEfforts).description("可选推理强度，仅用于支持的模型"),
      }).description("OpenAI"),
      gemini: Schema.object({
        ...provider,
        baseUrl: Schema.string()
          .role("link")
          .default(DefaultBaseUrl.gemini)
          .description("API 根地址，包含 API 版本，不含 /models"),
        thinkingLevel: Schema.union(ThinkingLevels)
          .description("可选推理强度，支持的档位取决于模型；留空使用模型默认值"),
        maxOutputTokens: Schema.natural().min(1).max(2147483647)
          .description("可选生成 token 上限，包含思考与回答；留空使用模型默认值"),
        stopSequences: Schema.array(Schema.string().min(1)).max(5)
          .description("可选停止序列，最多 5 个；匹配的序列不会包含在输出中"),
        seed: Schema.number().step(1).min(-2147483648).max(2147483647)
          .description("可选随机种子，整数；固定种子不保证输出完全一致"),
        presencePenalty: Schema.number()
          .description("可选存在惩罚；正值抑制已出现的词，负值鼓励重复"),
        frequencyPenalty: Schema.number()
          .description("可选频率惩罚；按词的出现次数调整重复倾向"),
        safetySettings: Schema.array(Schema.object({
          category: Schema.union(SafetyCategories).required().description("过滤类别"),
          threshold: Schema.union(SafetyThresholds).required().description("过滤阈值"),
        })).max(SafetyCategories.length)
          .description("可选内容过滤设置，每个类别最多一项；未设置的类别使用供应商默认值"),
      }).description("Gemini"),
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

import { Schema } from "koishi"
import { ReasoningContexts, ReasoningEfforts, ReasoningModes, VerbosityLevels } from "../models/openai/config"
import { ReasoningEfforts as DeepSeekReasoningEfforts } from "../models/deepseek/config"
import { SafetyCategories, SafetyThresholds, ThinkingLevels } from "../models/gemini/config"
import { DefaultCharacterFilename, DefaultCharacterId } from "../characters/default-preset"
import { DefaultAmbientProbeConfig } from "../dialogue/ambient/probe"
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
    debug: Schema.boolean()
      .default(false)
      .description("启用调试模式：输出调试日志，并将每次模型调用记录保存到 data/yokai/logs"),
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
        maxOutputTokens: Schema.natural().min(16)
          .description("可选生成 token 上限，至少 16，包含推理与回答；实际最大值取决于模型"),
        verbosity: Schema.union(VerbosityLevels)
          .description("可选回答详细程度：low 简短、medium 适中、high 详细；留空使用模型默认值"),
        reasoningMode: Schema.union(ReasoningModes)
          .description("可选推理执行模式：standard 或 pro；仅用于支持的模型，与推理强度独立"),
        reasoningContext: Schema.union(ReasoningContexts)
          .description("可选推理上下文范围：auto 自动、current_turn 当前轮、all_turns 所有轮；作用于实际回传的推理项"),
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
      presets: Schema.dict(
        Schema.string().min(1).description("YAML 文件相对路径"),
        Schema.string().min(1).description("角色 ID"),
      )
        .role("table")
        .default({ [DefaultCharacterId]: DefaultCharacterFilename })
        .description("角色 ID 到 YAML 文件相对路径的映射；预设正文保存在文件中"),
    }),
    roleplay: Schema.object({
      character: Schema.string().default(DefaultCharacterId).description("新频道绑定的默认角色 ID"),
      routineEnabled: Schema.boolean()
        .default(true)
        .description("启用角色日程：启动时生成日常时间表，并在对话中拼装日程上下文和提供日程调整动作"),
      triggerOnAt: Schema.boolean()
        .default(true)
        .description("群聊中 @ 机器人时触发生成"),
      triggerOnQuote: Schema.boolean()
        .default(true)
        .description("群聊中引用机器人消息时触发生成"),
      triggerOnName: Schema.boolean()
        .default(true)
        .description("群聊消息中包含角色名称或别名时触发生成"),
      triggerOnNamePrefix: Schema.boolean()
        .default(true)
        .description("群聊消息以角色名称或别名开头时触发生成"),
      debounceMs: Schema.natural()
        .default(2000)
        .description("被提及或对话跟进时等待目标群友把话说完的防抖时间（毫秒），0 表示关闭防抖"),
      maxDebounceMs: Schema.natural()
        .default(8000)
        .description("单轮防抖合并的最长等待时间（毫秒）"),
      proactive: Schema.object({
        enabled: Schema.boolean()
          .default(DefaultAmbientProbeConfig.enabled)
          .description("启用群聊潜水主动探头：当群内多人互动升温、斗图或复读起哄时，按非线性激活概率顺手旁听并自主决定是否插话"),
        cooldownSeconds: Schema.natural()
          .default(DefaultAmbientProbeConfig.cooldownSeconds)
          .description("基础冷却时间（秒）；显式对话或探头后进入冷却，冷却期内不累积热度"),
        maxBackoffShift: Schema.natural()
          .max(16)
          .default(DefaultAmbientProbeConfig.maxBackoffShift)
          .description("连续探头沉默时的指数退避最大翻倍阶数（实际冷却 = 基础冷却 × 2^min(连续沉默次数, 该值)）"),
        halfLifeSeconds: Schema.number()
          .min(0.1)
          .step(0.1)
          .default(DefaultAmbientProbeConfig.halfLifeSeconds)
          .description("热度指数衰减半衰期（秒）；每隔该时长历史余温衰减一半"),
        activeWindowSeconds: Schema.number()
          .min(0.1)
          .step(0.1)
          .default(DefaultAmbientProbeConfig.activeWindowSeconds)
          .description("统计当前活跃发言人数的滑动时间窗口（秒）"),
        idleResetSeconds: Schema.number()
          .min(0)
          .step(0.1)
          .default(DefaultAmbientProbeConfig.idleResetSeconds)
          .description("群内静默超过该时长（秒）后自动清零连续探头沉默计数"),
        midpointHeat: Schema.number()
          .min(0.01)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.midpointHeat)
          .description("非线性激活的半激活热度（h50）：热度达到该值时单条触发概率等于 maxProbability 的一半"),
        steepness: Schema.number()
          .min(0.1)
          .step(0.1)
          .default(DefaultAmbientProbeConfig.steepness)
          .description("非线性激活陡峭指数（k）：大于 1 时呈 S 型曲线，值越大对零星冷清发言抑制越强、热闹爆发时爬升越陡"),
        maxProbability: Schema.number()
          .min(0.01)
          .max(1)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.maxProbability)
          .description("单条旁听消息触发探头的概率上限（大于 0 且不超过 1）"),
        soloDelta: Schema.number()
          .min(0)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.soloDelta)
          .description("单人连续发言或窗口内仅 1 人活跃时的基础热度增量"),
        duoDelta: Schema.number()
          .min(0)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.duoDelta)
          .description("切换发言人且窗口内有 2 名活跃群友时的基础热度增量"),
        crowdDelta: Schema.number()
          .min(0)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.crowdDelta)
          .description("切换发言人且窗口内有 3 名及以上活跃群友时的基础热度增量"),
        soloImageBonus: Schema.number()
          .min(0)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.soloImageBonus)
          .description("窗口内仅 1 人活跃时发送图片的附加热度增量"),
        groupImageBonus: Schema.number()
          .min(0)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.groupImageBonus)
          .description("窗口内至少 2 人活跃时发送图片的附加热度增量"),
        echoBonus: Schema.number()
          .min(0)
          .step(0.01)
          .default(DefaultAmbientProbeConfig.echoBonus)
          .description("切换发言人且复读上一条文本或同图接龙时的附加热度增量"),
      }).description("群聊主动探头"),
    }),
  }).description("角色文件"),
])

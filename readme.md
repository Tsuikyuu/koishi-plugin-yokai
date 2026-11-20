# koishi-plugin-yokai

Koishi AI 角色扮演插件。

## 快速开始

1. **启用依赖服务**：确保 Koishi 已启用 `http` 插件和任一 `database` 插件（如 `database-sqlite`）。
2. **放置角色文件**：在 `data/yokai/characters/` 下创建角色预设文件（如 `companion.yml`，格式见下方模板）。

### 基础配置项

| 配置项                    | 默认值                         | 说明                                                    |
| ------------------------- | ------------------------------ | ------------------------------------------------------- |
| `debug`                   | `false`                        | 是否开启调试模式（开启后打印调试日志并将模型调用记录写入 `data/yokai/logs`） |
| `timezone`                | `Asia/Shanghai`                | 角色日程与定时任务使用的 IANA 时区                      |
| `models.default`          | `deepseek/deepseek-chat`       | 当前使用的模型（`provider/model`）                      |
| `characters.directory`    | `characters`                   | 角色预设目录（相对于 `data/yokai/`）                    |
| `characters.presets`      | `{ companion: companion.yml }` | 角色 ID 到 YAML 文件相对路径的映射                      |
| `roleplay.character`           | `companion`                    | 新频道首次触发时绑定的默认角色 ID（已有频道保持原绑定） |
| `roleplay.routineEnabled`      | `true`                         | 是否在启动时生成角色日常作息并在对话中启用日程          |
| `roleplay.triggerOnAt`         | `true`                         | 群聊中 `@` 机器人时是否触发生成                         |
| `roleplay.triggerOnQuote`      | `true`                         | 群聊中引用机器人消息时是否触发生成                      |
| `roleplay.triggerOnName`       | `true`                         | 群聊消息中包含角色名称或别名时是否触发生成              |
| `roleplay.triggerOnNamePrefix` | `true`                         | 群聊消息以角色名称或别名开头时是否触发生成              |
| `roleplay.debounceMs`               | `2000`                         | 定向对话时等待提及者把话说完的防抖时间（毫秒，0 关闭）  |
| `roleplay.maxDebounceMs`            | `8000`                         | 单轮防抖合并的最长等待时间（毫秒）                      |
| `roleplay.proactiveEnabled`         | `true`                         | 是否开启群聊潜水态热度探头（多人热聊/斗图/复读时顺手看一眼） |
| `roleplay.proactiveCooldownSeconds` | `180`                          | 群聊主动探头的基础冷却时间（秒，探头后沉默会自动指数退避） |

### 模型供应商可选参数

每个供应商均支持 `apiKey`、`baseUrl`（留空使用官方默认地址）和 `timeoutMs`（默认 `60000` 毫秒）。未选用的供应商可留空。

- **DeepSeek（`models.deepseek`）**
  - `reasoningEffort`：`none`（关闭思考）或 `low / high / max`
  - `maxOutputTokens`：`1–393216` 的整数
  - `stopSequences`：最多 16 个停止字符串
  - `temperature`（`0–2`）、`topP`（`(0, 1]`）：采样参数，实际生效范围取决于具体模型与思考模式
- **OpenAI（`models.openai`）**
  - `reasoningEffort`：`none / minimal / low / medium / high / xhigh / max`
  - `reasoningMode`：`standard / pro`
  - `reasoningContext`：`auto / current_turn / all_turns`
  - `verbosity`：`low / medium / high`（回答详细程度）
  - `maxOutputTokens`：至少 `16` 的整数
- **Gemini（`models.gemini`）**
  - `thinkingLevel`：`minimal / low / medium / high / xhigh`
  - `maxOutputTokens`：正整数
  - `stopSequences`：最多 5 个停止字符串
  - `seed`、`presencePenalty`、`frequencyPenalty`、`safetySettings`

## 角色预设文件

角色设定保存在独立的 YAML 文件中（默认位于 `data/yokai/characters/`），修改正文后下一轮对话自动生效；若开启了日程且修改了作息相关设定，重载插件即可重新生成日程。

```yaml
version: 1

character:
  id: companion # 需与 characters.presets 中的键名一致
  name: 小追求
  aliases:
    - 小追求
    - "@小追求"
  basicSetting: |
    基本身份与聊天背景设定。
  detailedSetting: |
    性格、喜好、生活习惯等详细设定。
  scene: |
    当前所处的交流场景说明。
  style: |
    说话口吻、用词习惯与对话示例。
  guidance:
    - 何时回应、何时保持沉默等行为准则。

initialState:
  emotion: 平静
  condition: 在线闲聊
  activity: 看群友聊天
  short_memory: ""
```

## 数据目录与使用提示

```text
data/yokai/
  characters/   # 角色预设 YAML 文件
  stickers/     # 角色自主收藏的表情包图片（单角色上限 40 张，跨频道互通）
  media/        # 聊天接收的图片缓存（支持 PNG/JPEG/WebP/GIF，单张上限 10 MiB）
  logs/         # 开启 debug 模式时保存每次模型调用的输入与输出记录
```

- **图片与表情包**：选用支持图片输入的模型时，角色会自动查看近期聊天图片，并按自身喜好收藏、管理与发送表情包；切换到纯文本模型时自动只读文字，仍可发送已收藏的表情包。
- **指令共存**：匹配到其他 Koishi 指令的消息不会触发角色回复。
- **Telegram 图片注意**：使用官方 Bot API 时，请保持 Telegram 适配器的 `files.local` 为关闭状态。

# koishi-plugin-yokai

基于 Effect 与 Koishi 原生服务的 AI 角色扮演插件。使用 `yarn new yokai --no-git` 创建，沿用模板的 Yakumo 构建。角色对话、笔记、状态、日常时间表、XML 动作和唤醒任务沿用原设计。

## 使用

插件依赖 Koishi 的 `database` 和 `http` 服务；数据库类型、连接、HTTP 代理及全局超时由对应 Koishi 插件配置。Yokai 不创建独立数据库连接或网络客户端。

```sh
# 在 Koishi 模板根目录执行
yarn install
yarn workspace koishi-plugin-yokai check
yarn build yokai
yarn start
```

开发模式使用模板原有的 `yarn dev`。插件配置已加入 `koishi.yml` 的 `~yokai`，暂未启用。先在控制台设置 Koishi 过滤器，选择要参与的账号和频道，再启用插件。

默认在启用时为默认角色和已有频道绑定的角色调用模型生成日常时间表，可通过 `roleplay.routineEnabled` 关闭；参与者消息和到期唤醒也会调用模型。启动校验或模型生成失败只进入后台日志。

## 配置与文件

Config Schema 管理模型选择、供应商参数、时区、角色文件映射、默认角色和日程开关；角色预设正文不放入配置。

```yaml
version: 1
timezone: Asia/Shanghai
models:
  default: deepseek/deepseek-chat
  deepseek:
    apiKey: sk-...
    timeoutMs: 60000
  openai:
    apiKey: sk-...
  gemini:
    apiKey: AIza...
    timeoutMs: 60000
characters:
  directory: characters
  presets:
    companion: companion.yml
roleplay:
  character: companion
  routineEnabled: true
```

这段配置属于 Koishi 的插件配置，不再另行读取原型 `config.yml`。供应商设置保留 `baseUrl`；DeepSeek 提供 `reasoningEffort`、`maxOutputTokens`、`stopSequences`、`temperature` 和 `topP`；OpenAI 提供 `reasoningEffort`、`maxOutputTokens`、`verbosity`、`reasoningMode` 和 `reasoningContext`。API 密钥直接填写在所选供应商的 `apiKey` 中，控制台以密码框显示；未选用的供应商可以留空。密钥不会写入模型记录或终端日志。

`models.default` 不再手动输入：插件启动时用已填写密钥的供应商请求 `{baseUrl}/models`，把返回的 `provider/model` 注册为控制台下拉选项，当前配置值始终保留在选项中。保存模型配置后自动刷新列表，包含供应商密钥和地址的修改；新一轮刷新会中断过时请求。请求失败只影响可选项，不阻断启动，并在后台日志显示供应商及脱敏错误类别。插件未运行时（例如尚未启用）没有列表可注册，控制台显示回退输入框。

DeepSeek 的 `models.deepseek.reasoningEffort` 可选 `none`、`low`、`high`、`max`，对应请求中的 `reasoning_effort`。`none` 关闭思考，其他档位开启思考；留空不发送该参数，使用供应商默认值（当前官方模型默认开启思考，强度为 `high`）。思考模式工具循环保留原始 `reasoning_content` 用于续接，推理正文不会进入角色回复或调用记录。

以下可选参数也位于 `models.deepseek`：

| 参数 | API 字段 | 说明 |
| --- | --- | --- |
| `maxOutputTokens` | `max_tokens` | `1–393216` 的整数，限制思考与回答的总 token 数；留空使用供应商默认值，默认上限随思考模式和强度变化 |
| `stopSequences` | `stop` | 最多 16 个非空停止字符串，原样发送；匹配的字符串不包含在输出中；留空或空列表不发送该参数 |

达到 token 上限而返回 `finish_reason: length` 时按未完成响应处理，截断内容不会作为角色回复交付。

`temperature` 的合法范围为 `[0, 2]`，`topP` 为 `(0, 1]`（不能为 `0`）；留空使用供应商默认值。根据 [DeepSeek 官方接口文档](https://api-docs.deepseek.com/api/create-chat-completion)，采样参数的实际效果取决于模型和模式：

| 模型 / 模式 | `temperature` | `topP` |
| --- | --- | --- |
| `deepseek-flash` 思考模式 | 忽略 | 生效，默认 `1`；低于 `0.95` 按 `0.95` 处理 |
| `deepseek-flash` 非思考模式 | 生效，默认 `1` | 忽略，固定为 `1` |
| `deepseek-v4-pro` 思考模式 | 忽略 | 忽略；启用工具调用时固定为 `0.95`，否则为 `1` |
| `deepseek-v4-pro` 非思考模式 | 生效，默认 `1` | 生效，默认 `1` |

适配器原样发送显式配置的合法采样值，由供应商按模型和模式处理。使用 `deepseek-v4-pro` 非思考模式时，官方建议只调整 `temperature` 或 `topP` 中的一项。

OpenAI 统一使用 Responses API。以下参数均位于 `models.openai`，留空时不发送，使用供应商默认值：

| 参数 | API 字段 | 说明 |
| --- | --- | --- |
| `reasoningEffort` | `reasoning.effort` | `none / minimal / low / medium / high / xhigh / max`，支持的档位取决于模型 |
| `maxOutputTokens` | `max_output_tokens` | 推理与回答的总 token 上限，至少 16 的整数，实际最大值取决于模型 |
| `verbosity` | `text.verbosity` | `low / medium / high`，控制回答详细程度 |
| `reasoningMode` | `reasoning.mode` | `standard / pro`，推理执行模式，与 `reasoningEffort` 独立 |
| `reasoningContext` | `reasoning.context` | `auto / current_turn / all_turns`，控制已回传推理项的使用范围 |

已有配置中的 `api: responses` 仍可读取，控制台不再显示接口选择；`api: chat-completions` 会在配置校验时失败，需删除该项以使用 Responses。模型级支持情况由供应商校验，例如 GPT-6 Astra 不支持 `reasoningEffort: none`。参考 [Responses 接口文档](https://developers.openai.com/api/reference/resources/responses/methods/create)。

Responses 使用 `store: false`，在当前工具循环中显式回传加密推理上下文；`reasoningContext` 不会额外持久化跨轮推理或重建历史推理项。token 上限导致的未完成响应按模型调用失败处理，不交付截断正文。

使用 Gemini 时填写 `models.gemini.apiKey`，并选择 `gemini/<模型 ID>`。原生 API 默认根地址为 `https://generativelanguage.googleapis.com/v1beta`；自定义 `baseUrl` 需包含 API 版本，不包含 `/models`。通过 `x-goog-api-key` 请求头认证，使用非流式 `generateContent`，支持系统指令、文本和多轮工具调用。模型列表自动翻页，仅显示支持 `generateContent` 的模型。工具循环保留原始 `thoughtSignature`；推理正文和签名不会进入角色回复或调用记录。

Gemini 配置面向新模型，不再提供或发送 `temperature`、`topP`、`topK`。已有配置中的这些字段需删除。以下选项均位于 `models.gemini`，留空时使用供应商默认值：

| 参数 | 说明 |
| --- | --- |
| `thinkingLevel` | `minimal`、`low`、`medium`、`high`、`xhigh`；实际支持的档位取决于模型，例如 Gemini 4 Hydrogen 支持 `xhigh`，不支持 `minimal` |
| `maxOutputTokens` | 正整数，限制思考与回答的总 token 数；上限取决于模型，达到上限的未完成回复按调用失败处理 |
| `stopSequences` | 最多 5 个非空停止字符串；匹配的字符串不包含在输出中 |
| `seed` | 32 位有符号整数随机种子，固定值不保证完全可复现 |
| `presencePenalty` | 存在惩罚，正值抑制已出现的词，负值鼓励重复 |
| `frequencyPenalty` | 频率惩罚，按词的出现次数调整重复倾向 |
| `safetySettings` | `{ category, threshold }` 列表，每个类别最多一项；未配置的类别使用供应商默认值 |

`safetySettings.category` 可选 `HARM_CATEGORY_HARASSMENT`、`HARM_CATEGORY_HATE_SPEECH`、`HARM_CATEGORY_SEXUALLY_EXPLICIT`、`HARM_CATEGORY_DANGEROUS_CONTENT`、`HARM_CATEGORY_JAILBREAK`；`threshold` 可选 `OFF`、`BLOCK_NONE`、`BLOCK_ONLY_HIGH`、`BLOCK_MEDIUM_AND_ABOVE`、`BLOCK_LOW_AND_ABOVE`。参数支持情况由所选模型决定，供应商返回的不支持错误按模型调用失败处理。

`roleplay.routineEnabled` 默认为 `true`，统一控制日程生成与日程上下文拼装。设为 `false` 后，启动时不生成日常时间表，对话中不附加 `daily_routine`、`current_activity` 和日程调整提示，也不执行 `routine` 动作。`wake-up` 定时任务和 `next-reply` 短期唤醒仍可使用。

`models` 使用 Koishi 响应式配置，每轮取得频道锁后读取一次，该轮工具循环固定使用同一快照。其他配置（包括日程开关）改变由 Koishi 重载插件。每轮重新读取角色预设文件；日程开启时，修改日常生活设定后重载插件以重新生成日程。

```text
Koishi 项目/
  data/yokai/
    characters/companion.yml   # 原格式的角色预设
    logs/<调用 ID>/
      input.json              # 模型输入与上下文
      result.json             # 输出或脱敏错误
```

`characters.directory` 相对于 `data/yokai`，必须位于该目录内；预设路径相对于角色目录。缺失、格式错误、ID 不匹配和路径越界都会明确报错，不自动替换为默认角色。

本次迁移复制了原角色文件和 281 个模型记录文件，并核对内容一致；原型数据库保留原位，按用户选择不导入。当前模型所需的 API 密钥已写入 `koishi.yml` 的插件配置。插件运行不依赖原型仓库路径。

模型记录包含角色设定、聊天内容、角色独白和工具结果，与参与者历史分开。记录保持原输入/输出文件格式，新建记录目录权限为 `0700`，文件为 `0600`；没有自动清理。

## Koishi 原生能力

- 使用 `Session`、`Bot` 和 Koishi 过滤器处理消息及定时交付，没有自有平台连接或适配器注册体系。
- 消息经 Koishi 中间件进入：自身消息、频道建档、`flag` 忽略和受理人（`assignee`）判断都由 Koishi 完成；匹配到指令的消息不触发角色扮演。
- 频道就是 Koishi 的 `channel` 表：角色绑定和角色状态作为扩展字段 `yokaiPreset`、`yokaiState` 存在其中。群聊由 Koishi 中间件建档，私聊按 Koishi 的 `autoAssign` 规则补建；关闭 `autoAssign` 时未建档的频道不参与。定时与短期唤醒由频道受理人对应的机器人发送。
- 通过 `ctx.model` 扩展 `channel`，并声明 `yokai_note`、`yokai_note_relation`、`yokai_schedule`、`yokai_schedule_run` 和 `yokai_history`；读写和事务全部交给 `ctx.database`。
- 模型请求通过 Effect 包裹注入的 `ctx.http`，沿用全局请求配置和代理钩子，支持总超时及取消。
- 业务日志使用 Effect 日志入口，由当前插件的 Koishi logger 输出。
- 消息监听、定时器和依赖关系由 Koishi 管理，Effect scope 管理进行中的业务任务与请求。

频道历史仅保存插件接收的参与者消息和确认发送的角色消息，与 Koishi 频道相同按平台和频道 ID 隔离；上下文读取最近 50 条并排除触发消息。历史存在 Koishi 数据库中，不回填插件启用前的远端历史。图片、语音等仅提供内容类型标记，暂不分析附件内容。

错误、执行进度、模型调用记录和工具结果不会作为消息发送，也不会混入参与者历史。模型输出使用纯文本及显式引用发送，不能注入 Koishi 消息元素。

## 可逆生命周期

模块全局没有可变运行状态。依赖服务缺失时插件等待；服务移除、插件停用或重载时移除监听与定时器，并中断模型请求和未完成回合。恢复依赖后重新初始化，不保留旧任务或重复监听。

已交给平台适配器的发送没有统一取消 API；卸载会等待发送及确认后的历史写入结算，再阻止后续动作。已发送消息不会撤回。不可取消的数据库事务也等待结算后释放资源；业务数据在操作时持久化，不依赖卸载时保存。

日常时间表与短期 `next-reply` 条件保存在当前插件实例中，重载后重新生成或清空。频道状态、笔记、长期 `wake-up` 任务和参与者历史由数据库保留。已有频道保留角色绑定，修改默认角色只影响新频道。

## 代码边界

目录按功能组织，同一功能的数据、契约、实现和数据库表定义放在一起。契约与实现保持独立文件，通过显式依赖组装；业务语义与持久化格式保持不变。

```text
src/
  index.ts           # Koishi 插件入口
  config/            # 配置契约、Schema、校验与解析
  characters/        # 角色、预设、角色状态、文件加载与日常生成
  channels/          # Koishi 频道上的角色绑定、参与者消息、历史与发送
  dialogue/          # 对话编排、上下文、响应协议、模型工具与短期唤醒
    context/
    response/
    tools/
    next-reply/
  notebook/          # 笔记、关联、查询与 Koishi 存储
  scheduling/        # 通用长期任务、时间计算、领取与执行
  models/            # 模型协议、供应商、HTTP 与调用记录
    records/
  runtime/           # 服务组装、日志及 Koishi 生命周期
```

例如，笔记功能的 `note.ts` 定义数据，`store.ts` 定义存储契约，`koishi-store.ts` 实现存储，`tables.ts` 与 `register-tables.ts` 声明和注册对应数据库表。修改笔记功能可以在同一目录完成。

跨模块直接导入所属文件，不经过全局聚合导出。角色状态属于 `characters`，频道仅引用它；频道历史只接受消息 ID 或时间截止条件，不依赖对话触发原因；日常生成提示词属于角色模块，日常在对话中的展示属于上下文模块。长期调度保持通用，具体唤醒角色的工具和载荷属于 `dialogue/tools`。

`runtime` 负责选择实现和组装；功能模块不能反向依赖 `runtime` 或 `config`。架构测试检查功能依赖无环、契约不依赖具体实现，避免目录调整后重新形成隐式耦合。

测试使用真实 Koishi Context、SQLite 插件、模拟 Bot 和本地 HTTP 服务，不调用付费模型或真实聊天平台。

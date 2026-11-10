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

启用时会为默认角色和已有频道绑定的角色调用模型生成日常时间表；参与者消息和到期唤醒也会调用模型。启动校验或模型生成失败只进入后台日志。

## 配置与文件

Config Schema 只管理原运行配置中的模型选择、供应商参数、时区、角色文件映射和默认角色；角色预设正文不放入配置。

```yaml
version: 1
timezone: Asia/Shanghai
models:
  default: deepseek/deepseek-chat
  deepseek:
    apiKey: sk-...
    timeoutMs: 60000
  openai:
    api: responses
    apiKey: sk-...
characters:
  directory: characters
  presets:
    companion: companion.yml
roleplay:
  character: companion
```

这段配置属于 Koishi 的插件配置，不再另行读取原型 `config.yml`。供应商设置保留 `baseUrl`；DeepSeek 提供 `temperature` 和 `topP`，OpenAI 提供 `api` 和 `reasoningEffort`。API 密钥直接填写在所选供应商的 `apiKey` 中，控制台以密码框显示；未选用的供应商可以留空。密钥不会写入模型记录或终端日志。

`models.default` 不再手动输入：插件启动时用已填写密钥的供应商请求 `{baseUrl}/models`，把返回的 `provider/model` 注册为控制台下拉选项，当前配置值始终保留在选项中。请求失败只影响可选项，不阻断启动；修改供应商密钥或地址后重载插件以刷新列表。插件未运行时（例如尚未启用）没有列表可注册，控制台显示回退输入框。

`models` 使用 Koishi 响应式配置，每轮取得频道锁后读取一次，该轮工具循环固定使用同一快照。其他配置改变由 Koishi 重载插件。每轮重新读取角色预设文件；修改日常生活设定后重载插件以重新生成日程。

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

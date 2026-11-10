import type { ChatCompletionsConfig } from "../chat-completions/config"

// 已经由启动配置边界校验的参数；baseUrl 是 API 根地址，不含 /chat/completions。
export interface DeepSeekConfig extends ChatCompletionsConfig {}

import type { CharacterState } from "../characters/state"

// 角色绑定与状态作为 Koishi 频道表的扩展字段；空 yokaiPreset 表示尚未绑定。
declare module "koishi" {
  interface Channel {
    yokaiPreset: string
    yokaiState: CharacterState | null
  }
}

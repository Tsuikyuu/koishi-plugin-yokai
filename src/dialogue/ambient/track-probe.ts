import { Effect, Layer, Random, Ref } from "effect"
import { channelIdOf, type ChannelId } from "../../channels/channel"
import type { Message, ParticipantId } from "../../channels/message"
import {
  AmbientTriggers,
  type AmbientObservation,
  type AmbientProbeConfig,
  type AmbientProbeResult,
} from "./probe"

interface ChannelAmbientState {
  readonly heat: number
  readonly lastMessageAt: number
  readonly lastSender: ParticipantId | undefined
  readonly lastSignature: string | undefined
  readonly recentSpeakers: ReadonlyMap<ParticipantId, number>
  readonly cooldownUntil: number
  readonly silentStreak: number
}

const emptyState = (now: number): ChannelAmbientState => ({
  heat: 0,
  lastMessageAt: now,
  lastSender: undefined,
  lastSignature: undefined,
  recentSpeakers: new Map(),
  cooldownUntil: 0,
  silentStreak: 0,
})

// 提取消息的可比较特征，用于识别群友复读或斗图接龙。
const signatureOf = (message: Message): string | undefined => {
  const tokens: string[] = []
  for (const part of message.parts) {
    if (part.type === "text") {
      const trimmed = part.text.trim()
      if (trimmed !== "") tokens.push(`t:${trimmed}`)
    } else if (part.type === "image" && "sha256" in part) {
      tokens.push(`i:${part.sha256}`)
    }
  }
  return tokens.length === 0 ? undefined : tokens.join("|")
}

const pruneSpeakers = (
  previous: ReadonlyMap<ParticipantId, number>,
  sender: ParticipantId,
  now: number,
  activeWindowMs: number,
): ReadonlyMap<ParticipantId, number> => {
  const next = new Map<ParticipantId, number>()
  for (const [id, time] of previous) {
    if (now - time <= activeWindowMs) {
      next.set(id, time)
    }
  }
  next.set(sender, now)
  return next
}

const backoffCooldownMs = (baseCooldownMs: number, silentStreak: number, maxBackoffShift: number): number =>
  baseCooldownMs * Math.pow(2, Math.min(silentStreak, maxBackoffShift))

// 使用 Hill 非线性激活函数将累积热度映射为单条消息的触发概率：
// p(h) = maxProbability * h^k / (h^k + h50^k)，低热度区幂次抑制零星闲聊，高热度区平滑逼近上限。
export const probeProbability = (heat: number, config: AmbientProbeConfig): number => {
  if (heat <= 0) {
    return 0
  }
  if (heat <= config.midpointHeat) {
    const powered = Math.pow(heat / config.midpointHeat, config.steepness)
    return config.maxProbability * (powered / (1 + powered))
  }
  const inversePowered = Math.pow(config.midpointHeat / heat, config.steepness)
  return config.maxProbability * (1 / (1 + inversePowered))
}

export const AmbientTriggersLive = (config: AmbientProbeConfig) =>
  Layer.effect(
    AmbientTriggers,
    Effect.gen(function* () {
      const states = yield* Ref.make<ReadonlyMap<ChannelId, ChannelAmbientState>>(new Map())
      const baseCooldownMs = config.cooldownSeconds * 1000
      const halfLifeMs = config.halfLifeSeconds * 1000
      const activeWindowMs = config.activeWindowSeconds * 1000
      const idleResetMs = config.idleResetSeconds * 1000

      return AmbientTriggers.of({
        observe: (channel, message, now) =>
          config.enabled
            ? Effect.gen(function* () {
                const roll = yield* Random.next
                return yield* Ref.modify(
                  states,
                  (
                    all,
                  ): readonly [AmbientObservation, ReadonlyMap<ChannelId, ChannelAmbientState>] => {
                    const channelId = channelIdOf(channel)
                    const prev = all.get(channelId)
                    const silentStreak =
                      prev === undefined || now - prev.lastMessageAt >= idleResetMs ? 0 : prev.silentStreak
                    const recentSpeakers = pruneSpeakers(
                      prev?.recentSpeakers ?? new Map(),
                      message.sender,
                      now,
                      activeWindowMs,
                    )
                    const signature = signatureOf(message)

                    // 处于冷却期时只更新发言人窗口与最后消息特征，不累积探头热度
                    if (prev !== undefined && now < prev.cooldownUntil) {
                      const cooled: ChannelAmbientState = {
                        heat: 0,
                        lastMessageAt: now,
                        lastSender: message.sender,
                        lastSignature: signature,
                        recentSpeakers,
                        cooldownUntil: prev.cooldownUntil,
                        silentStreak,
                      }
                      return [
                        { status: "cooling", remainingSeconds: Math.ceil((prev.cooldownUntil - now) / 1000) },
                        new Map(all).set(channelId, cooled),
                      ]
                    }

                    const decayed =
                      prev === undefined
                        ? 0
                        : prev.heat * Math.pow(0.5, Math.max(0, now - prev.lastMessageAt) / halfLifeMs)
                    const switchedSpeaker = prev?.lastSender !== undefined && prev.lastSender !== message.sender
                    const activeCount = recentSpeakers.size
                    const containsImage = message.parts.some((part) => part.type === "image" && "sha256" in part)
                    const isEcho = switchedSpeaker && signature !== undefined && signature === prev?.lastSignature

                    let delta =
                      switchedSpeaker && activeCount >= 2
                        ? activeCount >= 3
                          ? config.crowdDelta
                          : config.duoDelta
                        : config.soloDelta
                    if (containsImage) {
                      delta += activeCount >= 2 ? config.groupImageBonus : config.soloImageBonus
                    }
                    if (isEcho) {
                      delta += config.echoBonus
                    }

                    const nextHeat = decayed + delta
                    const probability = probeProbability(nextHeat, config)
                    if (roll >= probability) {
                      const updated: ChannelAmbientState = {
                        heat: nextHeat,
                        lastMessageAt: now,
                        lastSender: message.sender,
                        lastSignature: signature,
                        recentSpeakers,
                        cooldownUntil: prev?.cooldownUntil ?? 0,
                        silentStreak,
                      }
                      return [
                        { status: "accumulating", heat: nextHeat, probability },
                        new Map(all).set(channelId, updated),
                      ]
                    }

                    const reason = isEcho
                      ? "群里有人开始复读起哄，你顺手点开群聊看了一眼"
                      : containsImage
                        ? "群里有人在发图聊天，你顺手点开群聊看了一眼"
                        : "群里大家聊得正热闹，你顺手点开群聊看了一眼"
                    const cooldownMs = backoffCooldownMs(baseCooldownMs, silentStreak, config.maxBackoffShift)
                    const triggeredState: ChannelAmbientState = {
                      heat: 0,
                      lastMessageAt: now,
                      lastSender: message.sender,
                      lastSignature: signature,
                      recentSpeakers,
                      cooldownUntil: now + cooldownMs,
                      silentStreak,
                    }
                    return [
                      {
                        status: "triggered",
                        trigger: { channel, reason, time: now },
                        heat: nextHeat,
                        probability,
                        cooldownSeconds: Math.round(cooldownMs / 1000),
                      },
                      new Map(all).set(channelId, triggeredState),
                    ]
                  },
                )
              })
            : Effect.succeed({ status: "disabled" }),

        onExplicitTurn: (channel, now) =>
          Ref.update(states, (all) => {
            const channelId = channelIdOf(channel)
            const prev = all.get(channelId) ?? emptyState(now)
            return new Map(all).set(channelId, {
              ...prev,
              heat: 0,
              lastMessageAt: now,
              silentStreak: 0,
              cooldownUntil: Math.max(prev.cooldownUntil, now + baseCooldownMs),
            })
          }),

        onProbeCompleted: (channel, spoke, now) =>
          Ref.modify(
            states,
            (all): readonly [AmbientProbeResult, ReadonlyMap<ChannelId, ChannelAmbientState>] => {
              const channelId = channelIdOf(channel)
              const prev = all.get(channelId) ?? emptyState(now)
              const nextStreak = spoke ? 0 : prev.silentStreak + 1
              const cooldownMs = backoffCooldownMs(baseCooldownMs, nextStreak, config.maxBackoffShift)
              return [
                { silentStreak: nextStreak, cooldownSeconds: Math.round(cooldownMs / 1000) },
                new Map(all).set(channelId, {
                  ...prev,
                  heat: 0,
                  silentStreak: nextStreak,
                  cooldownUntil: now + cooldownMs,
                }),
              ]
            },
          ),
      })
    }),
  )

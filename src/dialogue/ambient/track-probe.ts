import { Effect, Layer, Ref } from "effect"
import { channelIdOf, type ChannelId } from "../../channels/channel"
import type { Message, ParticipantId } from "../../channels/message"
import {
  AmbientTriggers,
  type AmbientObservation,
  type AmbientProbeConfig,
  type AmbientProbeResult,
} from "./probe"

const HalfLifeMs = 90_000
const ActiveWindowMs = 120_000
const IdleTopicResetMs = 900_000
const MaxBackoffShift = 3
const TriggerThreshold = 1

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
): ReadonlyMap<ParticipantId, number> => {
  const next = new Map<ParticipantId, number>()
  for (const [id, time] of previous) {
    if (now - time <= ActiveWindowMs) {
      next.set(id, time)
    }
  }
  next.set(sender, now)
  return next
}

const backoffCooldownMs = (baseCooldownMs: number, silentStreak: number): number =>
  baseCooldownMs * Math.pow(2, Math.min(silentStreak, MaxBackoffShift))

export const AmbientTriggersLive = (config: AmbientProbeConfig) =>
  Layer.effect(
    AmbientTriggers,
    Effect.gen(function* () {
      const states = yield* Ref.make<ReadonlyMap<ChannelId, ChannelAmbientState>>(new Map())
      const baseCooldownMs = config.cooldownSeconds * 1000

      return AmbientTriggers.of({
        observe: (channel, message, now) =>
          config.enabled
            ? Ref.modify(
                states,
                (
                  all,
                ): readonly [AmbientObservation, ReadonlyMap<ChannelId, ChannelAmbientState>] => {
                  const channelId = channelIdOf(channel)
                  const prev = all.get(channelId)
                  const silentStreak =
                    prev === undefined || now - prev.lastMessageAt >= IdleTopicResetMs ? 0 : prev.silentStreak
                  const recentSpeakers = pruneSpeakers(prev?.recentSpeakers ?? new Map(), message.sender, now)
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
                      : prev.heat * Math.pow(0.5, Math.max(0, now - prev.lastMessageAt) / HalfLifeMs)
                  const switchedSpeaker = prev?.lastSender !== undefined && prev.lastSender !== message.sender
                  const activeCount = recentSpeakers.size
                  const hasImage = message.parts.some((part) => part.type === "image" && "sha256" in part)
                  const isEcho = switchedSpeaker && signature !== undefined && signature === prev?.lastSignature

                  let delta =
                    switchedSpeaker && activeCount >= 2 ? (activeCount >= 3 ? 0.34 : 0.28) : 0.08
                  if (hasImage) {
                    delta += activeCount >= 2 ? 0.32 : 0.22
                  }
                  if (isEcho) {
                    delta += 0.45
                  }

                  const nextHeat = decayed + delta
                  if (nextHeat < TriggerThreshold) {
                    const updated: ChannelAmbientState = {
                      heat: nextHeat,
                      lastMessageAt: now,
                      lastSender: message.sender,
                      lastSignature: signature,
                      recentSpeakers,
                      cooldownUntil: prev?.cooldownUntil ?? 0,
                      silentStreak,
                    }
                    return [{ status: "accumulating", heat: nextHeat }, new Map(all).set(channelId, updated)]
                  }

                  const reason = isEcho
                    ? "群里有人开始复读起哄，你顺手点开群聊看了一眼"
                    : hasImage
                      ? "群里有人在发图聊天，你顺手点开群聊看了一眼"
                      : "群里大家聊得正热闹，你顺手点开群聊看了一眼"
                  const cooldownMs = backoffCooldownMs(baseCooldownMs, silentStreak)
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
                      cooldownSeconds: Math.round(cooldownMs / 1000),
                    },
                    new Map(all).set(channelId, triggeredState),
                  ]
                },
              )
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
              const cooldownMs = backoffCooldownMs(baseCooldownMs, nextStreak)
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

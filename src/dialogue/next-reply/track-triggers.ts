import { Effect, Layer, Ref } from "effect"
import { channelIdOf, type ChannelId, type ChannelKey } from "../../channels/channel"
import type { Message } from "../../channels/message"
import { NextReplyTtlMs, type NextReplyAction } from "./action"
import { ChannelTriggers, type ProactiveTrigger } from "./triggers"

interface State {
  readonly channel: ChannelKey
  readonly pending: ReadonlyArray<NextReplyAction>
  readonly registeredAt: number
  readonly lastMessageAt: number
  readonly lastMessageAtByUser: Readonly<Record<string, number>>
}

const expiresAt = (state: State) => state.registeredAt + NextReplyTtlMs
const isExpired = (state: State, now: number) => now >= expiresAt(state)

const groups = (actions: ReadonlyArray<NextReplyAction>) => {
  const result = new Map<string, NextReplyAction[]>()
  for (const action of actions) {
    const list = result.get(action.group) ?? []
    list.push(action)
    result.set(action.group, list)
  }
  return [...result.values()]
}

const describe = (actions: ReadonlyArray<NextReplyAction>) =>
  actions
    .map((action) =>
      action.condition === "message_from_user"
        ? `收到用户 ${action.userId} 的新消息`
        : action.userId === "all"
          ? `连续 ${action.seconds} 秒没有新消息`
          : `用户 ${action.userId} 连续 ${action.seconds} 秒没有新消息`,
    )
    .join(" 且 ")

const matchMessage = (state: State, message: Message) =>
  groups(state.pending).find((actions) =>
    actions.every(
      (action) =>
        action.condition === "message_from_user" &&
        (action.userId === "all" ||
          action.userId === message.sender ||
          (state.lastMessageAtByUser[action.userId] ?? 0) >= state.registeredAt),
    ),
  )

const matchSilence = (state: State, now: number) => {
  const deadline = expiresAt(state)
  return groups(state.pending).find((actions) =>
    actions.every((action) => {
      if (action.condition === "message_from_user") {
        return action.userId === "all"
          ? state.lastMessageAt >= state.registeredAt
          : (state.lastMessageAtByUser[action.userId] ?? 0) >= state.registeredAt
      }
      if (action.seconds === undefined) return false
      if (action.maxWaitSeconds !== undefined) {
        const maxAt = state.registeredAt + action.maxWaitSeconds * 1000
        if (maxAt <= deadline && now >= maxAt) return true
      }
      const lastMessageAt = action.userId === "all" ? state.lastMessageAt : state.lastMessageAtByUser[action.userId]
      if (lastMessageAt === undefined) return false
      const fireAt = lastMessageAt + action.seconds * 1000
      return fireAt <= deadline && now >= fireAt
    }),
  )
}

export const ChannelTriggersLive = Layer.effect(
  ChannelTriggers,
  Effect.gen(function* () {
    const states = yield* Ref.make(new Map<ChannelId, State>())
    return ChannelTriggers.of({
      observeAndMatch: (channel, message, now) =>
        Ref.modify(states, (all) => {
          const channelId = channelIdOf(channel)
          const state = all.get(channelId)
          if (state === undefined) return [undefined, all] as const
          if (isExpired(state, now)) {
            const next = new Map(all)
            next.delete(channelId)
            return [undefined, next] as const
          }
          const updated: State = {
            ...state,
            lastMessageAt: now,
            lastMessageAtByUser: { ...state.lastMessageAtByUser, [message.sender]: now },
          }
          const matched = matchMessage(updated, message)
          if (matched === undefined) return [undefined, new Map(all).set(channelId, updated)] as const
          const next = new Map(all)
          next.delete(channelId)
          return [describe(matched), next] as const
        }),
      register: (channel, actions, now) =>
        Ref.update(states, (all) =>
          new Map(all).set(channelIdOf(channel), {
            channel,
            pending: actions,
            registeredAt: now,
            lastMessageAt: now,
            lastMessageAtByUser: {},
          }),
        ),
      clear: (channel) =>
        Ref.update(states, (all) => {
          const next = new Map(all)
          next.delete(channelIdOf(channel))
          return next
        }),
      due: (now) =>
        Ref.modify(states, (all) => {
          const triggers: ProactiveTrigger[] = []
          const next = new Map(all)
          for (const [channelId, state] of all) {
            const matched = matchSilence(state, now)
            if (matched !== undefined) {
              triggers.push({ channel: state.channel, reason: describe(matched), time: now })
              next.delete(channelId)
              continue
            }
            if (isExpired(state, now)) {
              next.delete(channelId)
            }
          }
          return [triggers, next] as const
        }),
    })
  }),
)

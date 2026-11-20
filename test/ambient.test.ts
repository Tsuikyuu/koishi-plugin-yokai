import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Random, Schema } from "effect"
import type { ChannelKey } from "../src/channels/channel"
import { Message } from "../src/channels/message"
import { AmbientTriggers, DefaultAmbientProbeConfig, type AmbientProbeConfig } from "../src/dialogue/ambient/probe"
import { AmbientTriggersLive, probeProbability } from "../src/dialogue/ambient/track-probe"

const room: ChannelKey = { platform: "test", channelId: "room-1" }
const sampleHash = "a".repeat(64)

const textMessage = (id: string, sender: string, text: string, time: number): Message =>
  Schema.decodeSync(Message)({
    id,
    sender,
    time,
    parts: [{ type: "text", text }],
  })

const imageMessage = (id: string, sender: string, time: number): Message =>
  Schema.decodeSync(Message)({
    id,
    sender,
    time,
    parts: [
      {
        type: "image",
        kind: "image",
        sha256: sampleHash,
        mimeType: "image/png",
        byteLength: 128,
      },
    ],
  })

const sequenceRandom = (rolls: ReadonlyArray<number>): Random.Random => {
  let cursor = 0
  return {
    nextIntUnsafe: () => 0,
    nextDoubleUnsafe: () => {
      const value = rolls[cursor] ?? 0.999999
      cursor += 1
      return value
    },
  }
}

test("probeProbability follows a nonlinear Hill S-curve with low-heat suppression and safe saturation", () => {
  const cfg = DefaultAmbientProbeConfig
  assert.equal(probeProbability(0, cfg), 0)
  assert.equal(probeProbability(-1, cfg), 0)

  // 单人连发 5 条的累积热度（0.25）处于强抑制区，单条触发概率低于千分之一
  const lowProb = probeProbability(0.25, cfg)
  assert.ok(lowProb > 0 && lowProb < 0.001)

  // 半激活点精确等于最大概率的一半
  const midProb = probeProbability(cfg.midpointHeat, cfg)
  assert.ok(Math.abs(midProb - cfg.maxProbability * 0.5) < 1e-12)

  // 严格单调递增且收敛于 maxProbability，极端数值下不溢出为 NaN
  const highProb = probeProbability(cfg.midpointHeat * 3, cfg)
  assert.ok(highProb > midProb && highProb < cfg.maxProbability)
  const extremeProb = probeProbability(1e200, { ...cfg, steepness: 200 })
  assert.equal(Number.isNaN(extremeProb), false)
  assert.ok(Math.abs(extremeProb - cfg.maxProbability) < 1e-12)
})

test("AmbientTriggersLive samples probabilistically and respects configured weights, windows, and backoff limits", async () => {
  const cfg: AmbientProbeConfig = {
    enabled: true,
    cooldownSeconds: 10,
    maxBackoffShift: 2,
    halfLifeSeconds: 20,
    activeWindowSeconds: 30,
    idleResetSeconds: 100,
    midpointHeat: 1,
    steepness: 2,
    maxProbability: 0.8,
    soloDelta: 0.1,
    duoDelta: 0.4,
    crowdDelta: 0.6,
    soloImageBonus: 0.2,
    groupImageBonus: 0.5,
    echoBonus: 0.3,
  }

  // 预置随机采样序列：第 1、2 次未命中采样，第 3 次命中采样触发探头
  const program = Effect.gen(function* () {
    const ambient = yield* AmbientTriggers

    // t=0: alice 单人发图，heat = 0.1 + 0.2 = 0.3，prob = 0.8 * (0.09 / 1.09) ≈ 0.066；roll=0.50 未命中
    const obs1 = yield* ambient.observe(room, imageMessage("m1", "alice", 0), 0)
    assert.equal(obs1.status, "accumulating")
    if (obs1.status === "accumulating") {
      assert.ok(Math.abs(obs1.heat - 0.3) < 1e-9)
      assert.ok(Math.abs(obs1.probability - probeProbability(0.3, cfg)) < 1e-9)
    }

    // t=20s（恰好一个半衰期）: bob 切换发言人（活跃 2 人），decayed = 0.15，delta = 0.4，heat = 0.55
    // prob = 0.8 * (0.3025 / 1.3025) ≈ 0.1858；roll=0.30 仍未命中，热度继续保留而不像硬阈值那样固定步数触发
    const obs2 = yield* ambient.observe(room, textMessage("m2", "bob", "哈哈", 20_000), 20_000)
    assert.equal(obs2.status, "accumulating")
    if (obs2.status === "accumulating") {
      assert.ok(Math.abs(obs2.heat - 0.55) < 1e-9)
    }

    // t=20s: carol 复读 bob（活跃 3 人 + 复读），delta = 0.6 + 0.3 = 0.9，heat = 1.45
    // prob = 0.8 / (1 + (1 / 1.45)^2) ≈ 0.5425；roll=0.20 < prob 命中触发！
    const obs3 = yield* ambient.observe(room, textMessage("m3", "carol", "哈哈", 20_000), 20_000)
    assert.equal(obs3.status, "triggered")
    if (obs3.status === "triggered") {
      assert.ok(Math.abs(obs3.heat - 1.45) < 1e-9)
      assert.equal(obs3.cooldownSeconds, 10)
      assert.match(obs3.trigger.reason, /复读/)
    }

    // 连续 3 次探头沉默：受 maxBackoffShift=2 限制，冷却依次为 20s、40s、40s（封顶 2^2 倍）
    const r1 = yield* ambient.onProbeCompleted(room, false, 21_000)
    assert.deepEqual(r1, { silentStreak: 1, cooldownSeconds: 20 })
    const r2 = yield* ambient.onProbeCompleted(room, false, 41_000)
    assert.deepEqual(r2, { silentStreak: 2, cooldownSeconds: 40 })
    const r3 = yield* ambient.onProbeCompleted(room, false, 81_000)
    assert.deepEqual(r3, { silentStreak: 3, cooldownSeconds: 40 })

    // 静默超过 idleResetSeconds(100s) 且超过 activeWindowSeconds(30s) 后：
    // 历史活跃发言人已过期（仅剩 carol 1 人），且连续沉默计数已清零，新触发冷却回到基础 10s
    const obs4 = yield* ambient.observe(room, textMessage("m4", "dave", "有人吗", 200_000), 200_000)
    assert.equal(obs4.status, "triggered")
    if (obs4.status === "triggered") {
      // 距离 t=20s 已超过 30s 活跃窗口，recentSpeakers 裁剪后仅剩 dave 1 人，因此走 soloDelta = 0.1
      assert.ok(Math.abs(obs4.heat - 0.1) < 1e-9)
      assert.equal(obs4.cooldownSeconds, 10)
    }
  })

  await Effect.runPromise(
    program.pipe(
      Effect.provide(AmbientTriggersLive(cfg)),
      Effect.provideService(Random.Random, sequenceRandom([0.5, 0.3, 0.2, 0.0001])),
    ),
  )
})

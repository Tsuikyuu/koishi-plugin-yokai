import { Schema } from "effect"

const Minute = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
const EndMinute = Schema.String.check(Schema.isPattern(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/))
const Activity = Schema.String.check(Schema.isPattern(/\S/))
export const RoutineEntry = Schema.Struct({
  start: Minute,
  end: EndMinute,
  activity: Activity,
})
export type RoutineEntry = typeof RoutineEntry.Type

// XML 动作：修改 [start, end) 时段的活动；起止使用配置时区的本地分钟。
export const RoutineAction = Schema.Struct({
  type: Schema.Literal("routine"),
  start: Minute,
  end: EndMinute,
  activity: Activity,
}).check(Schema.makeFilter(({ start, end }) => start < end))
export type RoutineAction = typeof RoutineAction.Type

// 起止时间为配置时区的本地分钟，区间左闭右开，连续覆盖一整天。
export const CharacterRoutine = Schema.Struct({
  entries: Schema.NonEmptyArray(RoutineEntry),
}).check(
  Schema.makeFilter(
    ({ entries }) =>
      entries[0].start === "00:00" &&
      entries[entries.length - 1]?.end === "24:00" &&
      entries.every(
        (entry, index) => entry.start < entry.end && (index === 0 || entries[index - 1]?.end === entry.start),
      ),
  ),
)
export type CharacterRoutine = typeof CharacterRoutine.Type

const mergeAdjacent = (entries: ReadonlyArray<RoutineEntry>): ReadonlyArray<RoutineEntry> =>
  entries.reduce<ReadonlyArray<RoutineEntry>>((merged, entry) => {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.end === entry.start && previous.activity === entry.activity) {
      return [...merged.slice(0, -1), { ...previous, end: entry.end }]
    }
    return [...merged, entry]
  }, [])

// 用 update 覆盖对应时段，保留未受影响的条目，并按需要拆分边界条目。
export const replaceRoutineRange = (routine: CharacterRoutine, update: RoutineAction): CharacterRoutine => {
  const entries = routine.entries.flatMap((entry) => {
    if (entry.end <= update.start || entry.start >= update.end) return [entry]
    return [
      ...(entry.start < update.start ? [{ ...entry, end: update.start }] : []),
      ...(entry.end > update.end ? [{ ...entry, start: update.end }] : []),
    ]
  })
  const merged = mergeAdjacent(
    [...entries, { start: update.start, end: update.end, activity: update.activity }].sort((left, right) =>
      left.start.localeCompare(right.start),
    ),
  )
  return { entries: [merged[0]!, ...merged.slice(1)] }
}

export class CharacterRoutineError extends Schema.TaggedError<CharacterRoutineError>()("CharacterRoutineError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

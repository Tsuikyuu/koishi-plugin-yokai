import type { CharacterRoutine } from "../../characters/routine"
import { element, escapeXml } from "./xml"

export const routineContext = (routine: CharacterRoutine, now: number, timezone: string): string => {
  const minute = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now)
  const current = routine.entries.reduce(
    (selected, entry) => (entry.start <= minute ? entry : selected),
    routine.entries[0],
  )
  const entryXml = (entry: CharacterRoutine["entries"][number]) =>
    `<activity start="${entry.start}" end="${entry.end}">${escapeXml(entry.activity)}</activity>`
  return [
    "# 日常生活时间表",
    `<daily_routine timezone="${escapeXml(timezone)}">${routine.entries.map(entryXml).join("\n")}</daily_routine>`,
    "# 当前正在进行的事",
    `<current_activity>${element("local_minute", minute)}${entryXml(current)}</current_activity>`,
  ].join("\n")
}

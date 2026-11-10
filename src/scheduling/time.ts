import { Cron } from "croner"

// 5 段沿用 Unix cron；6 段使用 EventBridge 字段顺序：分 时 日 月 周 年。
// 6 段必须用 ? 空出日或周，年份支持单个值、范围、列表和步进。
const normalize = (expression: string): { pattern: string; domAndDow: boolean } => {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length === 5) return { pattern: `0 ${fields.join(" ")} *`, domAndDow: false }
  if (fields.length !== 6) throw new Error("schedule requires five or six cron fields")
  if (fields[2] !== "?" && fields[4] !== "?") {
    throw new Error("six-field schedule must use ? in day-of-month or day-of-week")
  }
  return { pattern: `0 ${fields.join(" ")}`, domAndDow: true }
}

// 返回 null 表示表达式在可搜索范围内没有下一次触发。
export const nextScheduleTime = (expression: string, timezone: string, now: Date): Date | null => {
  const { pattern, domAndDow } = normalize(expression)
  const job = new Cron(pattern, { timezone, mode: "7-part", domAndDow })
  try {
    return job.nextRun(now)
  } finally {
    job.stop()
  }
}

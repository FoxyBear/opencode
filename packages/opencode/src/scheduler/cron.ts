/**
 * Minimal cron expression evaluator.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 *
 * Field syntax:
 *   *       — matches any value
 *   N       — matches exact value
 *   N,M     — matches N or M
 *   N-M     — matches range N through M
 *   * /N    — matches every N (step)
 *   N-M/S   — matches every S in range N-M
 */

export interface CronFields {
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length} in "${expression}"`)
  }
  return {
    minute: parts[0]!,
    hour: parts[1]!,
    dayOfMonth: parts[2]!,
    month: parts[3]!,
    dayOfWeek: parts[4]!,
  }
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field.includes(",")) {
    return field.split(",").some((part) => matchField(part.trim(), value, min, max))
  }

  if (field.includes("/")) {
    const [rangeStr, stepStr] = field.split("/")
    const step = parseInt(stepStr!, 10)
    if (isNaN(step) || step <= 0) return false

    if (rangeStr === "*") {
      return (value - min) % step === 0
    }

    if (rangeStr!.includes("-")) {
      const [startStr, endStr] = rangeStr!.split("-")
      const start = parseInt(startStr!, 10)
      const end = parseInt(endStr!, 10)
      if (value < start || value > end) return false
      return (value - start) % step === 0
    }

    const start = parseInt(rangeStr!, 10)
    if (value < start) return false
    return (value - start) % step === 0
  }

  if (field === "*") {
    return true
  }

  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-")
    const start = parseInt(startStr!, 10)
    const end = parseInt(endStr!, 10)
    return value >= start && value <= end
  }

  const exact = parseInt(field, 10)
  return value === exact
}

export function cronMatches(expression: string, date: Date): boolean {
  const fields = parseCron(expression)

  const minute = date.getMinutes()
  const hour = date.getHours()
  const dayOfMonth = date.getDate()
  const month = date.getMonth() + 1
  const dayOfWeek = date.getDay()

  return (
    matchField(fields.minute, minute, 0, 59) &&
    matchField(fields.hour, hour, 0, 23) &&
    matchField(fields.dayOfMonth, dayOfMonth, 1, 31) &&
    matchField(fields.month, month, 1, 12) &&
    matchField(fields.dayOfWeek, dayOfWeek, 0, 6)
  )
}

export function nextFireTime(expression: string, from: Date): Date | null {
  const _fields = parseCron(expression)
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const maxIterations = 366 * 24 * 60
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(expression, cursor)) {
      return cursor
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

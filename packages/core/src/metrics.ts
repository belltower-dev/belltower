/*
 * Response times and degraded minutes (docs/spec.md, "Components"), kept by
 * decide() as it goes so the page never reads raw results. Each minute adds
 * the public HTTP checks' passing response times to a histogram per
 * component for the hour and the day, and counts the minute as degraded
 * when the component was. Histogram buckets are 2% wide, so a median is
 * within 1% of the exact value, and the file stays small however many
 * checks and regions there are.
 */

export const METRICS_FORMAT = "belltower.metrics/1"
export const METRICS_KEY = "state/metrics.json"

/** Days kept, matching the 90-day history. */
const KEEP_DAYS = 90
/** Hours kept, for the last-24-hours chart. */
const KEEP_HOURS = 25
const RATIO = 1.02

/** Bucket index to count. */
export type Histogram = Record<string, number>

interface DayMetrics {
  /** While the day may still change; replaced by medianMs once it's two days old. */
  response?: Histogram
  medianMs?: number | null
  degradedMinutes: number
}

export interface Metrics {
  format: typeof METRICS_FORMAT
  /** The newest minute recorded, so a minute is never counted twice. */
  lastMinute?: string
  components: Record<string, { hours: Record<string, Histogram>; days: Record<string, DayMetrics> }>
}

export function emptyMetrics(): Metrics {
  return { format: METRICS_FORMAT, components: {} }
}

function bucket(ms: number): number {
  return Math.round(Math.log(Math.max(ms, 1)) / Math.log(RATIO))
}

/** The median of a histogram in whole milliseconds, or null when it's empty. */
export function median(h: Histogram | undefined): number | null {
  if (!h) return null
  const entries = Object.entries(h).map(([k, n]) => [Number(k), n] as const).sort((a, b) => a[0] - b[0])
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  if (!total) return null
  let seen = 0
  for (const [k, n] of entries) {
    seen += n
    if (seen * 2 >= total) return Math.round(RATIO ** k)
  }
  return null
}

/**
 * Adds one minute. `responses` holds each component's response times in
 * that minute; `degraded` the components that were degraded. Returns the
 * metrics unchanged when the minute is already recorded.
 */
export function recordMinute(metrics: Metrics, minute: Date, responses: ReadonlyMap<string, readonly number[]>, degraded: ReadonlySet<string>): Metrics {
  const iso = minute.toISOString()
  if (metrics.lastMinute && iso <= metrics.lastMinute) return metrics
  const day = iso.slice(0, 10)
  const hour = iso.slice(0, 13)
  const names = new Set([...responses.keys(), ...degraded])
  for (const name of names) {
    const c = (metrics.components[name] ??= { hours: {}, days: {} })
    const d = (c.days[day] ??= { degradedMinutes: 0 })
    if (degraded.has(name)) d.degradedMinutes++
    for (const ms of responses.get(name) ?? []) {
      const b = String(bucket(ms))
      const h = (c.hours[hour] ??= {})
      h[b] = (h[b] ?? 0) + 1
      d.response ??= {}
      d.response[b] = (d.response[b] ?? 0) + 1
    }
  }
  metrics.lastMinute = iso
  prune(metrics, minute)
  return metrics
}

function prune(metrics: Metrics, now: Date): void {
  const oldestHour = new Date(now.getTime() - KEEP_HOURS * 3_600_000).toISOString().slice(0, 13)
  const oldestDay = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
  const settled = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)
  for (const c of Object.values(metrics.components)) {
    for (const h of Object.keys(c.hours)) if (h < oldestHour) delete c.hours[h]
    for (const [date, d] of Object.entries(c.days)) {
      if (date < oldestDay) delete c.days[date]
      else if (date <= settled && d.response) {
        d.medianMs = median(d.response)
        delete d.response
      }
    }
  }
}

export interface ResponseFigures {
  /** The last 24 whole hours, oldest first, each as yyyy-mm-ddThh:00Z. */
  hours: { hour: string; responseMs: number | null }[]
  /** By UTC date. */
  days: Map<string, { responseMs: number | null; degradedMinutes: number }>
}

/** A component's figures as the page shows them. */
export function responseFigures(metrics: Metrics | null, component: string, now: Date): ResponseFigures {
  const c = metrics?.components[component]
  const thisHour = Math.floor(now.getTime() / 3_600_000) * 3_600_000
  const hours = Array.from({ length: 24 }, (_, i) => {
    const key = new Date(thisHour - (24 - i) * 3_600_000).toISOString().slice(0, 13)
    return { hour: `${key}:00Z`, responseMs: median(c?.hours[key]) }
  })
  const days = new Map(Object.entries(c?.days ?? {}).map(([date, d]) => [date, { responseMs: d.response ? median(d.response) : (d.medianMs ?? null), degradedMinutes: d.degradedMinutes }]))
  return { hours, days }
}

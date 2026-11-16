import type { Component, Config } from "./config.ts"
import type { Incident } from "./decide.ts"
import { responseFigures, type Metrics } from "./metrics.ts"
import type { Clock, Store } from "./ports.ts"

/*
 * Availability (docs/spec.md, "Availability"): a minute is down when it
 * falls inside a confirmed incident for any public check in the component,
 * and maintenance minutes count neither up nor down. Days and months are in
 * UTC. The math is pure; rollUp reads incidents and writes the public
 * history and the monthly reports.
 */

export const HISTORY_FORMAT = "belltower.history/1"
export const REPORT_FORMAT = "belltower.report/1"
export const HISTORY_KEY = "public/history.json"
export const HISTORY_DAYS = 90

const MINUTE = 60_000
const DAY = 86_400_000

/** A half-open span of time in milliseconds: [start, end). */
export interface Span {
  start: number
  end: number
}

export interface MaintenanceWindow {
  component: string
  start: string
  end: string
}

/** Merges overlapping or touching spans, sorted by start. */
export function merge(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Total milliseconds of `spans` inside `window`. Spans must be merged. */
export function overlap(spans: readonly Span[], window: Span): number {
  let total = 0
  for (const s of spans) total += Math.max(0, Math.min(s.end, window.end) - Math.max(s.start, window.start))
  return total
}

/** Removes `cut` from `spans`. Both must be merged. */
export function subtract(spans: readonly Span[], cut: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    let pieces: Span[] = [s]
    for (const c of cut) {
      pieces = pieces.flatMap((p) => {
        if (c.end <= p.start || c.start >= p.end) return [p]
        return [
          ...(c.start > p.start ? [{ start: p.start, end: c.start }] : []),
          ...(c.end < p.end ? [{ start: c.end, end: p.end }] : []),
        ]
      })
    }
    out.push(...pieces)
  }
  return out
}

/** Each component's down and maintenance time, as merged spans. Open incidents run to `now`. */
export function componentSpans(
  config: Config,
  incidents: readonly Incident[],
  maintenance: readonly MaintenanceWindow[],
  now: Date,
): Map<string, { down: Span[]; maintenance: Span[]; incidents: Incident[] }> {
  const publicChecks = new Set(config.checks.filter((c) => c.public).map((c) => c.id))
  const out = new Map<string, { down: Span[]; maintenance: Span[]; incidents: Incident[] }>()
  for (const component of config.components) {
    // Each public check in the component counts for its own spans, not the whole incident's.
    const parts = (i: Incident) => Object.entries(i.checks ?? {}).filter(([id, c]) => c.component === component.name && publicChecks.has(id))
    const own = incidents.filter((i) => parts(i).length > 0)
    const maint = merge(
      maintenance.filter((m) => m.component === component.name).map((m) => ({ start: Date.parse(m.start), end: Date.parse(m.end) })),
    )
    const down = merge(
      own.flatMap((i) => parts(i).flatMap(([, c]) => c.spans.map((s) => ({ start: Date.parse(s.start), end: s.end ? Date.parse(s.end) : now.getTime() })))),
    )
    out.set(component.name, { down: subtract(down, maint), maintenance: maint, incidents: own })
  }
  return out
}

/** Availability as a percentage, rounded down to three places so a down minute never shows as 100%. */
export function percent(up: number, counted: number): number | null {
  if (counted <= 0) return null
  return Math.floor((up / counted) * 100_000) / 1000
}

export interface DayFigure {
  /** UTC date, yyyy-mm-dd. */
  date: string
  /** Percentage up, or null before monitoring began. */
  uptime: number | null
  downMinutes: number
  maintenanceMinutes: number
  /** Minutes the component was degraded. They don't count against uptime. */
  degradedMinutes: number
  /** Median response time of its public HTTP checks, or null with none recorded. */
  responseMs: number | null
  /** Ids of public incidents that overlap the day. */
  incidents: string[]
}

export interface PeriodFigure {
  /** Minutes counted: the period up to now, from when monitoring began, without maintenance. */
  minutesCounted: number
  downMinutes: number
  maintenanceMinutes: number
  availability: number | null
}

/** Figures for [start, end), counting only from `since` and up to `now`. */
export function figure(spans: { down: Span[]; maintenance: Span[] }, start: number, end: number, since: number, now: number): PeriodFigure {
  const window = { start: Math.max(start, since), end: Math.min(end, now) }
  if (window.end <= window.start) return { minutesCounted: 0, downMinutes: 0, maintenanceMinutes: 0, availability: null }
  const total = window.end - window.start
  const maintenance = overlap(spans.maintenance, window)
  const down = overlap(spans.down, window)
  const counted = total - maintenance
  return {
    minutesCounted: Math.floor(counted / MINUTE),
    downMinutes: Math.ceil(down / MINUTE),
    maintenanceMinutes: Math.round(maintenance / MINUTE),
    availability: percent(counted - down, counted),
  }
}

function utcDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY
}

function monthStart(ms: number, offset = 0): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)
}

/** Each component's last 90 UTC days, oldest first, and this month to date against its target. */
export interface PublicHistory {
  format: typeof HISTORY_FORMAT
  writtenAt: string
  components: {
    name: string
    target: number | null
    month: { month: string; availability: number | null }
    days: DayFigure[]
    /** The last 24 whole hours, oldest first. */
    hours: { hour: string; responseMs: number | null }[]
  }[]
}

export function buildHistory(
  config: Config,
  incidents: readonly Incident[],
  maintenance: readonly MaintenanceWindow[],
  since: Date,
  now: Date,
  metrics: Metrics | null = null,
): PublicHistory {
  const spans = componentSpans(config, incidents, maintenance, now)
  const today = utcDay(now.getTime())
  const thisMonth = monthStart(now.getTime())
  return {
    format: HISTORY_FORMAT,
    writtenAt: now.toISOString(),
    components: config.components.map((component) => {
      const s = spans.get(component.name) ?? { down: [], maintenance: [], incidents: [] }
      const response = responseFigures(metrics, component.name, now)
      const days: DayFigure[] = []
      for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
        const start = today - i * DAY
        const f = figure(s, start, start + DAY, since.getTime(), now.getTime())
        const date = new Date(start).toISOString().slice(0, 10)
        days.push({
          date,
          uptime: f.availability,
          downMinutes: f.downMinutes,
          maintenanceMinutes: f.maintenanceMinutes,
          degradedMinutes: response.days.get(date)?.degradedMinutes ?? 0,
          responseMs: response.days.get(date)?.responseMs ?? null,
          incidents: s.incidents
            .filter((inc) => Date.parse(inc.startedAt) < start + DAY && (inc.endedAt ? Date.parse(inc.endedAt) : now.getTime()) > start)
            .map((inc) => inc.id),
        })
      }
      const month = figure(s, thisMonth, monthStart(now.getTime(), 1), since.getTime(), now.getTime())
      return {
        name: component.name,
        target: component.target ?? null,
        month: { month: new Date(thisMonth).toISOString().slice(0, 7), availability: month.availability },
        days,
        hours: response.hours,
      }
    }),
  }
}

export interface ComponentReport extends PeriodFigure {
  name: string
  target: number | null
  /** Null without a target, or before any minute was counted. */
  targetMet: boolean | null
  /** Percentage credit owed by the tiers, 0 when none applies. */
  credit: number
  incidents: number
  /** Mean minutes from start to end of the incidents that ended in the month. */
  meanMinutesToRecover: number | null
}

export interface MonthlyReport {
  format: typeof REPORT_FORMAT
  /** yyyy-mm, UTC. */
  month: string
  writtenAt: string
  /** False while the month is still running. */
  complete: boolean
  components: ComponentReport[]
}

/** The credit the tiers give for an availability: the largest tier it falls below. */
export function creditFor(component: Component, availability: number | null): number {
  if (availability === null) return 0
  return component.credits.filter((t) => availability < t.below).reduce((max, t) => Math.max(max, t.percent), 0)
}

export function buildReport(config: Config, incidents: readonly Incident[], maintenance: readonly MaintenanceWindow[], month: number, since: Date, now: Date): MonthlyReport {
  const spans = componentSpans(config, incidents, maintenance, now)
  const start = monthStart(month)
  const end = monthStart(month, 1)
  return {
    format: REPORT_FORMAT,
    month: new Date(start).toISOString().slice(0, 7),
    writtenAt: now.toISOString(),
    complete: now.getTime() >= end,
    components: config.components.map((component) => {
      const s = spans.get(component.name) ?? { down: [], maintenance: [], incidents: [] }
      const f = figure(s, start, end, since.getTime(), now.getTime())
      const inMonth = s.incidents.filter((i) => Date.parse(i.startedAt) < end && (i.endedAt ? Date.parse(i.endedAt) : now.getTime()) > start)
      const recovered = inMonth.filter((i) => i.endedAt && Date.parse(i.endedAt) >= start && Date.parse(i.endedAt) < end)
      const mean = recovered.length
        ? Math.round(recovered.reduce((sum, i) => sum + (Date.parse(i.endedAt ?? "") - Date.parse(i.startedAt)), 0) / recovered.length / MINUTE)
        : null
      return {
        name: component.name,
        target: component.target ?? null,
        ...f,
        targetMet: component.target === undefined || f.availability === null ? null : f.availability >= component.target,
        credit: creditFor(component, f.availability),
        incidents: inMonth.length,
        meanMinutesToRecover: mean,
      }
    }),
  }
}

const CSV_COLUMNS = [
  "component",
  "availability_percent",
  "target_percent",
  "target_met",
  "credit_percent",
  "minutes_counted",
  "minutes_down",
  "maintenance_minutes",
  "incidents",
  "mean_minutes_to_recover",
] as const

export function reportCsv(report: MonthlyReport): string {
  const cell = (v: string | number | boolean | null) => {
    const s = v === null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = report.components.map((c) =>
    [c.name, c.availability, c.target, c.targetMet, c.credit, c.minutesCounted, c.downMinutes, c.maintenanceMinutes, c.incidents, c.meanMinutesToRecover].map(cell).join(","),
  )
  return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`
}

export function reportKey(month: string, ext: "json" | "csv"): string {
  return `public/reports/${month}.${ext}`
}

/**
 * Reads every incident and writes public/history.json, plus this month's
 * and last month's reports as JSON and CSV. `since` is when monitoring
 * began; earlier minutes aren't counted.
 */
export async function rollUp(deps: { config: Config; store: Store; clock: Clock; since: Date; maintenance?: readonly MaintenanceWindow[]; metrics?: Metrics | null }): Promise<{ history: PublicHistory; reports: MonthlyReport[] }> {
  const now = deps.clock.now()
  const keys = await deps.store.list("incidents/")
  const incidents = (await Promise.all(keys.map(async (k) => JSON.parse((await deps.store.get(k)) ?? "null") as Incident | null))).filter(
    (i): i is Incident => i !== null && typeof i.startedAt === "string",
  )
  const maintenance = deps.maintenance ?? []
  const history = buildHistory(deps.config, incidents, maintenance, deps.since, now, deps.metrics ?? null)
  const reports = [monthStart(now.getTime(), -1), monthStart(now.getTime())].map((m) => buildReport(deps.config, incidents, maintenance, m, deps.since, now))
  const json = { contentType: "application/json" }
  await deps.store.put(HISTORY_KEY, JSON.stringify(history), json)
  for (const report of reports) {
    await deps.store.put(reportKey(report.month, "json"), JSON.stringify(report), json)
    await deps.store.put(reportKey(report.month, "csv"), reportCsv(report), { contentType: "text/csv; charset=utf-8" })
  }
  return { history, reports }
}

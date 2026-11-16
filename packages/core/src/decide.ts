import { resultsKey, RESULTS_FORMAT, type CheckResult, type ResultsFile } from "./check.ts"
import type { Check, Config, HeartbeatCheck, HttpCheck, PageConfig, Thresholds } from "./config.ts"
import { rollUp } from "./availability.ts"
import { buildPage, writePage, type BuildPageDeps } from "./page/build.ts"
import { heartbeatKey, judgeHeartbeat, type HeartbeatRecord } from "./heartbeat.ts"
import { emptyMetrics, METRICS_FORMAT, METRICS_KEY, recordMinute, type Metrics } from "./metrics.ts"
import { maintenanceWindows, NOTES_FORMAT, NOTES_KEY, type PublicNotes } from "./notes.ts"
import { worst, type ComponentState } from "./states.ts"
import type { Alert, Clock, HttpTiming, Notifier, Priority, Store } from "./ports.ts"

/*
 * decide(): reads every region's recent results, applies the confirmation,
 * degraded and recovery rules, opens and resolves incidents, sends alerts
 * and writes public/status.json (docs/spec.md, "Deciding that something is
 * down", "Incidents and alerts"). The rules are in `judge`, a pure function
 * over recorded results; `decide` does the reading and writing around it.
 */

export const INCIDENT_FORMAT = "belltower.incident/1"
export const STATUS_FORMAT = "belltower.status/1"
export const DECIDE_STATE_FORMAT = "belltower.decide/1"
export const DECIDE_STATE_KEY = "state/decide.json"
export const STATUS_KEY = "public/status.json"
export const PAGE_FORMAT = "belltower.page/1"
export const PAGE_KEY = "public/page.json"

export type CheckState = "up" | "degraded" | "down" | "pending" | "maintenance"

/** One minute of one check: each region that reported it, and its result. */
export type Sample = Readonly<Record<string, CheckResult>>

export interface Judgement {
  state: CheckState
  /** Index into the samples of the first minute of the streak behind the state. */
  since: number | null
}

const MINUTE = 60_000

/**
 * Applies the rules to one check's samples, oldest first, ending at the
 * last complete minute. `regionCount` is how many regions run the check;
 * a missing sample breaks every streak, so silence never confirms anything.
 */
export function judge(samples: readonly Sample[], regionCount: number, t: Thresholds, wasDown: boolean): Judgement {
  const confirmNeed = Math.min(t.confirmRegions, regionCount)
  const recoverNeed = Math.min(t.recoverRegions, regionCount)
  const count = (s: Sample, f: (r: CheckResult) => boolean) => Object.values(s).filter(f).length
  const failing = (s: Sample) => count(s, (r) => !r.ok) >= confirmNeed
  const passing = (s: Sample) => count(s, (r) => r.ok) >= recoverNeed
  const slow = (s: Sample) => count(s, (r) => r.ok && r.slow) >= confirmNeed

  /** Start index of the run of minutes matching `f` that ends at the newest sample. */
  const streak = (f: (s: Sample) => boolean): { start: number; length: number } => {
    let i = samples.length
    while (i > 0 && f(samples[i - 1] ?? {})) i--
    return { start: i, length: samples.length - i }
  }

  if (wasDown) {
    const up = streak(passing)
    if (up.length >= t.recoverMinutes) return { state: "up", since: up.start }
    return { state: "down", since: null }
  }
  const down = streak(failing)
  if (down.length >= t.confirmMinutes) return { state: "down", since: down.start }
  const slowRun = streak(slow)
  if (slowRun.length >= t.degradedMinutes) return { state: "degraded", since: slowRun.start }
  return { state: "up", since: null }
}

export interface FirstFailure {
  at: string
  failure?: string
  message?: string
  status?: number
  timing: HttpTiming
  headers?: Record<string, string>
  bodyStart?: string
}

/** A span of time as ISO strings; `end` is absent while it's still going. */
export interface OpenSpan {
  start: string
  end?: string
}

/** One check's part in an incident. */
export interface IncidentCheck {
  component: string
  /** When the check was down. A check that recovers and fails again while the incident is open gets another span. */
  spans: OpenSpan[]
  /** What happened, in words. */
  summary: string
  regions: string[]
  /** From the first failure in each region. */
  firstFailures: Record<string, FirstFailure>
}

export interface Incident {
  format: typeof INCIDENT_FORMAT
  id: string
  /** The checks' shared incident key, or the check id. */
  key: string
  /** The most urgent priority among its checks. */
  priority: Priority
  components: string[]
  checks: Record<string, IncidentCheck>
  /** The first failing minute of any of its checks. */
  startedAt: string
  detectedAt: string
  /** The end of its last check's span: the first passing minute of the recovery. */
  endedAt?: string
  resolvedAt?: string
}


/** Written from an allowlist of fields: nothing from the config beyond component names. */
export interface PublicStatus {
  format: typeof STATUS_FORMAT
  writtenAt: string
  overall: ComponentState
  components: { name: string; state: ComponentState }[]
  incidents: { id: string; components: string[]; startedAt: string }[]
  /** Each region and when it last finished a run; null when it never has. */
  regions: RegionStatus[]
}

export interface RegionStatus {
  name: string
  lastResultsAt: string | null
}

/** What the status page shows that comes from the config: the page section and each component's group, description, link and target. */
export interface PublicPage {
  format: typeof PAGE_FORMAT
  writtenAt: string
  page: PageConfig
  components: { name: string; group?: string; description?: string; link?: string; target?: number }[]
}

interface DecideState {
  format: typeof DECIDE_STATE_FORMAT
  /** Incident key to the id of its open incident. */
  open: Record<string, string>
  /** When decide() first ran: availability isn't counted before it. */
  since?: string
  /** When public/history.json and the reports were last written. */
  rolledUpAt?: string
  /** Region to the end of its newest run seen, kept past the minutes decide() reads. */
  lastResults?: Record<string, string>
}

/** How often the history and reports are rewritten when nothing has changed. */
const ROLL_UP_EVERY = 10 * MINUTE

export interface DecideDeps {
  config: Config
  byRegion: Readonly<Record<string, readonly string[]>>
  store: Store
  clock: Clock
  notifiers: readonly Notifier[]
  /**
   * Rebuild the status page beside status.json when something changed, and
   * at least every 10 minutes. Without it the page is built separately.
   */
  page?: Omit<BuildPageDeps, "store" | "clock">
}

export interface DecideReport {
  states: Record<string, CheckState>
  opened: Incident[]
  resolved: Incident[]
  /** Results files that couldn't be read, alerts that couldn't be sent, and a page that couldn't be built. */
  problems: string[]
  /** Whether this run rebuilt the status page. */
  pageBuilt?: boolean
}

/** Runs once a minute in one place per deployment. */
export async function decide(deps: DecideDeps): Promise<DecideReport> {
  const { config, byRegion, store, clock } = deps
  const t = config.thresholds
  const now = clock.now()
  const problems: string[] = []

  // The last complete minute: regions run at the top of the minute, so this
  // minute's results may not all be written yet.
  const last = Math.floor(now.getTime() / MINUTE) * MINUTE - MINUTE
  const width = Math.max(t.confirmMinutes, t.degradedMinutes, t.recoverMinutes) + 5
  const minutes = Array.from({ length: width }, (_, i) => new Date(last - (width - 1 - i) * MINUTE))

  const latest = new Map<string, string>()
  const files = await readResults(store, Object.keys(byRegion), minutes, problems, latest)
  const state = await readState(store)
  state.lastResults ??= {}
  for (const [region, at] of latest) if (!state.lastResults[region] || at > state.lastResults[region]) state.lastResults[region] = at
  const report: DecideReport = { states: {}, opened: [], resolved: [], problems }
  const notes = await readNotes(store, problems)
  const windows = maintenanceWindows(notes)
  /** The end of the maintenance window covering a moment, or null. */
  const maintenanceEnd = (component: string, at: number): number | null => {
    const w = windows.find((m) => m.component === component && Date.parse(m.start) <= at && at < Date.parse(m.end))
    return w ? Date.parse(w.end) : null
  }

  const runners = new Map<string, string[]>()
  for (const [region, ids] of Object.entries(byRegion)) for (const id of ids) runners.set(id, [...(runners.get(id) ?? []), region])

  const open = new Map<string, Incident>()
  for (const [key, id] of Object.entries(state.open)) {
    const incident = await readJson<Incident>(store, incidentKey(id))
    if (incident) open.set(key, incident)
    else {
      problems.push(`Incident "${id}" is missing from the store; its checks are judged afresh and no recovery alert is sent for it.`)
      delete state.open[key]
    }
  }

  /** What changed this minute, by incident key. */
  const changes = new Map<string, { down: { check: Check; part: IncidentCheck }[]; up: { check: Check; end: Date }[] }>()
  const changesFor = (key: string) => {
    const c = changes.get(key) ?? { down: [], up: [] }
    changes.set(key, c)
    return c
  }

  /** Response times in the last complete minute, by component, from public HTTP checks that passed. */
  const responses = new Map<string, number[]>()

  for (const check of config.checks) {
    const key = check.incidentKey ?? check.id
    const spans = open.get(key)?.checks[check.id]?.spans
    const wasDown = spans !== undefined && spans.at(-1)?.end === undefined
    const maintenanceNow = maintenanceEnd(check.component, now.getTime()) !== null

    if (check.type === "http") {
      const regions = runners.get(check.id) ?? []
      const samples = minutes.map((m) => sampleFor(files, regions, m, check.id))
      if (check.public) {
        const times = Object.values(samples.at(-1) ?? {}).filter((r) => r.ok).map((r) => r.timing.totalMs)
        if (times.length) responses.set(check.component, [...(responses.get(check.component) ?? []), ...times])
      }
      const verdict = judge(samples, regions.length, t, wasDown)
      report.states[check.id] = maintenanceNow && !wasDown ? "maintenance" : verdict.state
      if (!wasDown && !maintenanceNow && verdict.state === "down" && verdict.since !== null) {
        // An outage that began in a maintenance window counts from the window's end.
        let from = verdict.since
        while (from < minutes.length && maintenanceEnd(check.component, minutes[from]?.getTime() ?? 0) !== null) from++
        if (from < minutes.length) changesFor(key).down.push({ check, part: httpPart(check, samples.slice(from), minutes.slice(from), now) })
      } else if (wasDown && verdict.state !== "down" && verdict.since !== null) {
        changesFor(key).up.push({ check, end: minutes[verdict.since] ?? now })
      }
    } else if (check.type === "heartbeat") {
      const record = await readJson<HeartbeatRecord>(store, heartbeatKey(check.id))
      const verdict = judgeHeartbeat(check, record, now)
      report.states[check.id] = maintenanceNow && !wasDown ? "maintenance" : verdict.state
      if (!wasDown && !maintenanceNow && verdict.state === "down" && verdict.since) {
        const since = new Date(Math.max(verdict.since.getTime(), maintenanceEnd(check.component, verdict.since.getTime()) ?? 0))
        changesFor(key).down.push({ check, part: heartbeatPart(check, since, verdict.reason ?? "") })
      } else if (wasDown && verdict.state === "up") {
        changesFor(key).up.push({ check, end: new Date(record?.lastSuccess ?? now) })
      }
    }
  }

  for (const [key, change] of changes) {
    const existing = open.get(key)
    if (!existing) {
      if (!change.down.length) continue
      const incident = newIncident(key, change.down, now)
      await store.put(incidentKey(incident.id), JSON.stringify(incident), { contentType: "application/json" })
      await send(deps.notifiers, downAlert(incident, change.down.map((d) => d.check)), problems)
      state.open[key] = incident.id
      open.set(key, incident)
      report.opened.push(incident)
      continue
    }

    const incident = existing
    const before = incident.priority
    for (const { check, end } of change.up) {
      const last = incident.checks[check.id]?.spans.at(-1)
      if (last) last.end = end.toISOString()
    }
    for (const { check, part } of change.down) {
      const known = incident.checks[check.id]
      if (known) known.spans.push(...part.spans)
      else incident.checks[check.id] = part
      if (!incident.components.includes(check.component)) incident.components.push(check.component)
      if (rank(check.priority) < rank(incident.priority)) incident.priority = check.priority
    }

    const ends = Object.values(incident.checks).flatMap((c) => c.spans.map((s) => s.end))
    if (ends.every((e) => e !== undefined)) {
      incident.endedAt = ends.reduce((a, b) => (a > b ? a : b))
      incident.resolvedAt = now.toISOString()
      await store.put(incidentKey(incident.id), JSON.stringify(incident), { contentType: "application/json" })
      await send(deps.notifiers, recoveryAlert(incident), problems)
      delete state.open[key]
      open.delete(key)
      report.resolved.push(incident)
    } else {
      await store.put(incidentKey(incident.id), JSON.stringify(incident), { contentType: "application/json" })
      // A check joining an open incident alerts only when it makes the incident more urgent.
      if (rank(incident.priority) < rank(before)) {
        await send(deps.notifiers, downAlert(incident, change.down.map((d) => d.check)), problems)
      }
    }
  }

  state.since ??= now.toISOString()
  const changed = report.opened.length > 0 || report.resolved.length > 0
  const maintenance = new Set(config.components.map((c) => c.name).filter((name) => maintenanceEnd(name, now.getTime()) !== null))
  const regionTimes = Object.keys(byRegion).map((name) => ({ name, lastResultsAt: state.lastResults?.[name] ?? null }))
  const current = publicStatus(config, report.states, [...open.values()], now, maintenance, regionTimes)
  const metrics = recordMinute(
    await readMetrics(store, problems),
    new Date(last),
    responses,
    new Map(current.components.flatMap((c) => (c.state === "degraded" || c.state === "partial" || c.state === "major" ? [[c.name, c.state] as const] : []))),
  )
  await store.put(METRICS_KEY, JSON.stringify(metrics), { contentType: "application/json" })

  const rollingUp = changed || !state.rolledUpAt || now.getTime() - Date.parse(state.rolledUpAt) >= ROLL_UP_EVERY
  if (rollingUp) {
    await rollUp({ config, store, clock, since: new Date(state.since), maintenance: windows, metrics })
    await store.put(PAGE_KEY, JSON.stringify(publicPage(config, now)), { contentType: "application/json" })
    state.rolledUpAt = now.toISOString()
  }

  await store.put(DECIDE_STATE_KEY, JSON.stringify(state), { contentType: "application/json" })
  await store.put(STATUS_KEY, JSON.stringify(current), { contentType: "application/json" })
  // The page is built from the files just written, so it matches status.json.
  if (deps.page && rollingUp) {
    try {
      const built = await buildPage({ ...deps.page, store, clock })
      if (built.ok) {
        await writePage(store, built.files)
        report.pageBuilt = true
        problems.push(...built.warnings.map((w) => `Status page: ${w}`))
      } else problems.push(...built.problems.map((p) => `The status page wasn't rebuilt: ${p}`))
    } catch (error) {
      problems.push(`The status page wasn't rebuilt: ${(error as Error).message}`)
    }
  }
  return report
}

async function readMetrics(store: Store, problems: string[]): Promise<Metrics> {
  try {
    const metrics = await readJson<Metrics>(store, METRICS_KEY)
    if (metrics === null) return emptyMetrics()
    if (metrics.format !== METRICS_FORMAT) throw new Error(`format ${JSON.stringify(metrics.format)}`)
    return metrics
  } catch (error) {
    problems.push(`${METRICS_KEY} couldn't be read (${(error as Error).message}); response times start again from this minute.`)
    return emptyMetrics()
  }
}

async function readNotes(store: Store, problems: string[]): Promise<PublicNotes | null> {
  const text = await store.get(NOTES_KEY)
  if (text === null) return null
  try {
    const notes = JSON.parse(text) as PublicNotes
    if (notes.format !== NOTES_FORMAT || !Array.isArray(notes.notes)) throw new Error(`format ${JSON.stringify(notes.format)}`)
    return notes
  } catch (error) {
    problems.push(`${NOTES_KEY} couldn't be read (${(error as Error).message}); maintenance windows are ignored until it's published again.`)
    return null
  }
}

/** Region to minute (ms) to that run's results by check id. */
type ResultsByRegion = Map<string, Map<number, Map<string, CheckResult>>>

async function readResults(store: Store, regions: readonly string[], minutes: readonly Date[], problems: string[], latest: Map<string, string>): Promise<ResultsByRegion> {
  const out: ResultsByRegion = new Map()
  await Promise.all(
    regions.flatMap((region) =>
      minutes.map(async (minute) => {
        const key = resultsKey(region, minute)
        const text = await store.get(key)
        if (text === null) return
        let file: ResultsFile
        try {
          file = JSON.parse(text) as ResultsFile
        } catch {
          problems.push(`${key} isn't valid JSON; its results were skipped.`)
          return
        }
        if (file.format !== RESULTS_FORMAT || !Array.isArray(file.results)) {
          problems.push(`${key} has format ${JSON.stringify(file.format)}, expected ${RESULTS_FORMAT}; its results were skipped.`)
          return
        }
        const byMinute = out.get(region) ?? new Map<number, Map<string, CheckResult>>()
        out.set(region, byMinute)
        byMinute.set(minute.getTime(), new Map(file.results.map((r) => [r.id, r])))
        const finished = typeof file.finishedAt === "string" ? file.finishedAt : minute.toISOString()
        if (finished > (latest.get(region) ?? "")) latest.set(region, finished)
      }),
    ),
  )
  return out
}

function sampleFor(files: ResultsByRegion, regions: readonly string[], minute: Date, checkId: string): Sample {
  const sample: Record<string, CheckResult> = {}
  for (const region of regions) {
    const result = files.get(region)?.get(minute.getTime())?.get(checkId)
    if (result) sample[region] = result
  }
  return sample
}

async function readState(store: Store): Promise<DecideState> {
  const text = await store.get(DECIDE_STATE_KEY)
  if (text === null) return { format: DECIDE_STATE_FORMAT, open: {} }
  const parsed = JSON.parse(text) as DecideState
  if (parsed.format !== DECIDE_STATE_FORMAT) throw new Error(`${DECIDE_STATE_KEY} has format ${JSON.stringify(parsed.format)}, expected ${DECIDE_STATE_FORMAT}.`)
  return parsed
}

async function readJson<T>(store: Store, key: string): Promise<T | null> {
  const text = await store.get(key)
  return text === null ? null : (JSON.parse(text) as T)
}

export function incidentKey(id: string): string {
  return `incidents/${id}.json`
}

function incidentId(key: string, start: Date): string {
  return `${key}-${start.toISOString().slice(0, 16).replace(/[-T:]/g, "")}`
}

const rank = (p: Priority) => Number(p.slice(1))

function newIncident(key: string, down: readonly { check: Check; part: IncidentCheck }[], now: Date): Incident {
  const startedAt = down.map((d) => d.part.spans[0]?.start ?? now.toISOString()).reduce((a, b) => (a < b ? a : b))
  return {
    format: INCIDENT_FORMAT,
    id: incidentId(key, new Date(startedAt)),
    key,
    priority: down.map((d) => d.check.priority).reduce((a, b) => (rank(a) <= rank(b) ? a : b)),
    components: [...new Set(down.map((d) => d.check.component))],
    checks: Object.fromEntries(down.map((d) => [d.check.id, d.part])),
    startedAt,
    detectedAt: now.toISOString(),
  }
}

function heartbeatPart(check: HeartbeatCheck, since: Date, summary: string): IncidentCheck {
  return { component: check.component, spans: [{ start: since.toISOString() }], summary, regions: [], firstFailures: {} }
}

function httpPart(check: HttpCheck, samples: readonly Sample[], minutes: readonly Date[], now: Date): IncidentCheck {
  const start = minutes[0] ?? now
  const firstFailures: Record<string, FirstFailure> = {}
  samples.forEach((sample, i) => {
    for (const [region, r] of Object.entries(sample)) {
      if (r.ok || firstFailures[region]) continue
      firstFailures[region] = {
        at: (minutes[i] ?? now).toISOString(),
        timing: r.timing,
        ...(r.failure !== undefined ? { failure: r.failure } : {}),
        ...(r.message !== undefined ? { message: r.message } : {}),
        ...(r.status !== undefined ? { status: r.status } : {}),
        ...(r.headers !== undefined ? { headers: r.headers } : {}),
        ...(r.bodyStart !== undefined ? { bodyStart: r.bodyStart } : {}),
      }
    }
  })
  const regions = Object.keys(firstFailures).sort()
  const reasons = [...new Set(Object.values(firstFailures).map((f) => f.message).filter((m) => m !== undefined))]
  return {
    component: check.component,
    spans: [{ start: start.toISOString() }],
    summary: [`${check.id} has failed in ${regions.join(", ")} since ${hhmm(start.toISOString())}.`, ...reasons].join("\n"),
    regions,
    firstFailures,
  }
}

function hhmm(iso: string): string {
  return `${iso.slice(11, 16)} UTC`
}

/** "home (Website)", or "api, web (API, Website)" for several checks. */
function naming(checks: readonly string[], components: readonly string[]): string {
  return `${checks.join(", ")} (${components.join(", ")})`
}

/** The alert for checks that went down, opening an incident or joining one. */
function downAlert(incident: Incident, down: readonly Check[]): Alert {
  const components = [...new Set(down.map((c) => c.component))]
  return {
    priority: incident.priority,
    title: `${incident.priority} down: ${naming(down.map((c) => c.id), components)}`,
    text: [
      ...down.map((c) => incident.checks[c.id]?.summary ?? ""),
      ...down.flatMap((c) => (c.type === "http" ? [`URL: ${c.url}`] : [])),
      ...(Object.keys(incident.checks).length > down.length ? [`Part of incident ${incident.id}, with ${Object.keys(incident.checks).filter((id) => !down.some((c) => c.id === id)).join(", ")}.`] : []),
      "Belltower will send another alert when it recovers.",
    ].join("\n"),
  }
}

function recoveryAlert(incident: Incident): Alert {
  const end = incident.endedAt ?? incident.resolvedAt ?? incident.startedAt
  const minutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(incident.startedAt)) / MINUTE))
  const checks = Object.keys(incident.checks)
  return {
    priority: incident.priority,
    title: `${incident.priority} recovered: ${naming(checks, incident.components)}`,
    text: `${checks.join(", ")} ${checks.length === 1 ? "is" : "are"} passing again. It was down for ${minutes} minute${minutes === 1 ? "" : "s"}, from ${hhmm(incident.startedAt)} to ${hhmm(end)}.`,
  }
}

/** Sends through every notifier whose upTo covers the priority. P5 is never sent. One failing never stops the others. */
async function send(notifiers: readonly Notifier[], alert: Alert, problems: string[]): Promise<void> {
  await Promise.all(
    notifiers
      .filter((n) => alert.priority !== "P5" && rank(alert.priority) <= rank(n.upTo))
      .map(async (n, i) => {
        try {
          await n.send(alert)
        } catch (error) {
          problems.push(`Notifier ${i + 1} couldn't send "${alert.title}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }),
  )
}

export function publicStatus(
  config: Config,
  states: Readonly<Record<string, CheckState>>,
  open: readonly Incident[],
  now: Date,
  maintenance: ReadonlySet<string> = new Set(),
  regions: readonly RegionStatus[] = [],
): PublicStatus {
  const publicChecks = new Set(config.checks.filter((c) => c.public).map((c) => c.id))
  const components = config.components.map((component) => {
    // Only checks decide() judged count, so a check type it doesn't judge yet never makes an outage look partial.
    const judged = config.checks.filter((c) => c.component === component.name && publicChecks.has(c.id) && states[c.id] !== undefined).map((c) => states[c.id])
    const down = judged.filter((s) => s === "down").length
    let state: ComponentState = down === 0 ? "operational" : down === judged.length ? "major" : "partial"
    if (state === "operational" && judged.includes("degraded")) state = "degraded"
    // Maintenance replaces anything but an incident that was already open when it began.
    if (maintenance.has(component.name) && down === 0) state = "maintenance"
    return { name: component.name, state }
  })
  const overall = worst(components.map((c) => c.state))
  return {
    format: STATUS_FORMAT,
    writtenAt: now.toISOString(),
    overall,
    components,
    incidents: open.flatMap((i) => {
      const shown = Object.entries(i.checks).filter(([id]) => publicChecks.has(id))
      return shown.length ? [{ id: i.id, components: [...new Set(shown.map(([, c]) => c.component))], startedAt: i.startedAt }] : []
    }),
    regions: regions.map((r) => ({ name: r.name, lastResultsAt: r.lastResultsAt })),
  }
}

/** Written from an allowlist: the page section, and only the public fields of each component. */
export function publicPage(config: Config, now: Date): PublicPage {
  return {
    format: PAGE_FORMAT,
    writtenAt: now.toISOString(),
    page: config.page,
    components: config.components.map((c) => ({
      name: c.name,
      ...(c.group !== undefined ? { group: c.group } : {}),
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.link !== undefined ? { link: c.link } : {}),
      ...(c.target !== undefined ? { target: c.target } : {}),
    })),
  }
}

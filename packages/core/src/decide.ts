import { resultsKey, RESULTS_FORMAT, type CheckResult, type ResultsFile } from "./check.ts"
import type { Check, Config, HeartbeatCheck, HttpCheck, Thresholds } from "./config.ts"
import { rollUp } from "./availability.ts"
import { heartbeatKey, judgeHeartbeat, type HeartbeatRecord } from "./heartbeat.ts"
import type { Alert, AlertLevel, Clock, HttpTiming, Notifier, Store } from "./ports.ts"

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

export type CheckState = "up" | "degraded" | "down" | "pending"

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

export interface Incident {
  format: typeof INCIDENT_FORMAT
  id: string
  check: string
  component: string
  level: AlertLevel
  /** The first failing minute. */
  startedAt: string
  detectedAt: string
  /** The first passing minute of the recovery. */
  endedAt?: string
  resolvedAt?: string
  /** What happened, in words. */
  summary: string
  regions: string[]
  /** From the first failure in each region. */
  firstFailures: Record<string, FirstFailure>
}

export type ComponentState = "operational" | "degraded" | "down"

/** Written from an allowlist of fields: nothing from the config beyond component names. */
export interface PublicStatus {
  format: typeof STATUS_FORMAT
  writtenAt: string
  overall: ComponentState
  components: { name: string; state: ComponentState }[]
  incidents: { id: string; component: string; startedAt: string }[]
}

interface DecideState {
  format: typeof DECIDE_STATE_FORMAT
  /** Check id to the id of its open incident. */
  open: Record<string, string>
  /** When decide() first ran: availability isn't counted before it. */
  since?: string
  /** When public/history.json and the reports were last written. */
  rolledUpAt?: string
}

/** How often the history and reports are rewritten when nothing has changed. */
const ROLL_UP_EVERY = 10 * MINUTE

export interface DecideDeps {
  config: Config
  byRegion: Readonly<Record<string, readonly string[]>>
  store: Store
  clock: Clock
  notifiers: readonly Notifier[]
}

export interface DecideReport {
  states: Record<string, CheckState>
  opened: Incident[]
  resolved: Incident[]
  /** Results files that couldn't be read, and alerts that couldn't be sent. */
  problems: string[]
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

  const files = await readResults(store, Object.keys(byRegion), minutes, problems)
  const state = await readState(store)
  const report: DecideReport = { states: {}, opened: [], resolved: [], problems }

  const runners = new Map<string, string[]>()
  for (const [region, ids] of Object.entries(byRegion)) for (const id of ids) runners.set(id, [...(runners.get(id) ?? []), region])

  const componentCritical = new Set(config.components.filter((c) => c.critical).map((c) => c.name))
  const levelFor = (check: Check): AlertLevel =>
    check.severity === "critical" || componentCritical.has(check.component) ? "critical" : "alert"

  for (const check of config.checks) {
    const openId = state.open[check.id]
    let change: { opened: Incident } | { endedAt: Date } | null = null

    if (check.type === "http") {
      const regions = runners.get(check.id) ?? []
      const samples = minutes.map((m) => sampleFor(files, regions, m, check.id))
      const verdict = judge(samples, regions.length, t, openId !== undefined)
      report.states[check.id] = verdict.state
      if (openId === undefined && verdict.state === "down" && verdict.since !== null) {
        change = { opened: httpIncident(check, levelFor(check), samples.slice(verdict.since), minutes.slice(verdict.since), now) }
      } else if (openId !== undefined && verdict.state !== "down" && verdict.since !== null) {
        change = { endedAt: minutes[verdict.since] ?? now }
      }
    } else if (check.type === "heartbeat") {
      const record = await readJson<HeartbeatRecord>(store, heartbeatKey(check.id))
      const verdict = judgeHeartbeat(check, record, now)
      report.states[check.id] = verdict.state
      if (openId === undefined && verdict.state === "down" && verdict.since) {
        change = { opened: heartbeatIncident(check, levelFor(check), verdict.since, verdict.reason ?? "", now) }
      } else if (openId !== undefined && verdict.state === "up") {
        change = { endedAt: new Date(record?.lastSuccess ?? now) }
      }
    } else {
      continue
    }

    if (change && "opened" in change) {
      const incident = change.opened
      await store.put(incidentKey(incident.id), JSON.stringify(incident), { contentType: "application/json" })
      await send(deps.notifiers, downAlert(incident, check), problems)
      state.open[check.id] = incident.id
      report.opened.push(incident)
    } else if (change && openId !== undefined) {
      const incident = await readJson<Incident>(store, incidentKey(openId))
      if (incident) {
        incident.endedAt = change.endedAt.toISOString()
        incident.resolvedAt = now.toISOString()
        await store.put(incidentKey(incident.id), JSON.stringify(incident), { contentType: "application/json" })
        await send(deps.notifiers, recoveryAlert(incident, check), problems)
        report.resolved.push(incident)
      } else {
        problems.push(`Incident "${openId}" for check "${check.id}" is missing from the store; marking the check recovered without an alert.`)
      }
      delete state.open[check.id]
    }
  }

  state.since ??= now.toISOString()
  const changed = report.opened.length > 0 || report.resolved.length > 0
  if (changed || !state.rolledUpAt || now.getTime() - Date.parse(state.rolledUpAt) >= ROLL_UP_EVERY) {
    await rollUp({ config, store, clock, since: new Date(state.since) })
    state.rolledUpAt = now.toISOString()
  }

  await store.put(DECIDE_STATE_KEY, JSON.stringify(state), { contentType: "application/json" })
  const openIncidents = await Promise.all(Object.values(state.open).map((id) => readJson<Incident>(store, incidentKey(id))))
  await store.put(STATUS_KEY, JSON.stringify(publicStatus(config, report.states, openIncidents, now)), { contentType: "application/json" })
  return report
}

/** Region to minute (ms) to that run's results by check id. */
type ResultsByRegion = Map<string, Map<number, Map<string, CheckResult>>>

async function readResults(store: Store, regions: readonly string[], minutes: readonly Date[], problems: string[]): Promise<ResultsByRegion> {
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

function incidentId(checkId: string, start: Date): string {
  return `${checkId}-${start.toISOString().slice(0, 16).replace(/[-T:]/g, "")}`
}

function heartbeatIncident(check: HeartbeatCheck, level: AlertLevel, since: Date, summary: string, now: Date): Incident {
  return {
    format: INCIDENT_FORMAT,
    id: incidentId(check.id, since),
    check: check.id,
    component: check.component,
    level,
    startedAt: since.toISOString(),
    detectedAt: now.toISOString(),
    summary,
    regions: [],
    firstFailures: {},
  }
}

function httpIncident(check: HttpCheck, level: AlertLevel, samples: readonly Sample[], minutes: readonly Date[], now: Date): Incident {
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
    format: INCIDENT_FORMAT,
    id: incidentId(check.id, start),
    check: check.id,
    component: check.component,
    level,
    startedAt: start.toISOString(),
    detectedAt: now.toISOString(),
    summary: [`${check.id} has failed in ${regions.join(", ")} since ${hhmm(start.toISOString())}.`, ...reasons].join("\n"),
    regions,
    firstFailures,
  }
}

function hhmm(iso: string): string {
  return `${iso.slice(11, 16)} UTC`
}

function downAlert(incident: Incident, check: Check): Alert {
  return {
    level: incident.level,
    title: `Down: ${check.id} (${check.component})`,
    text: [incident.summary, ...(check.type === "http" ? [`URL: ${check.url}`] : []), "Belltower will send another alert when it recovers."].join("\n"),
  }
}

function recoveryAlert(incident: Incident, check: Check): Alert {
  const end = incident.endedAt ?? incident.resolvedAt ?? incident.startedAt
  const minutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(incident.startedAt)) / MINUTE))
  return {
    level: incident.level,
    title: `Recovered: ${check.id} (${check.component})`,
    text: `${check.id} is passing again. It was down for ${minutes} minute${minutes === 1 ? "" : "s"}, from ${hhmm(incident.startedAt)} to ${hhmm(end)}.`,
  }
}

/** Sends through every notifier that takes the level. One failing never stops the others. */
async function send(notifiers: readonly Notifier[], alert: Alert, problems: string[]): Promise<void> {
  await Promise.all(
    notifiers
      .filter((n) => n.levels.includes(alert.level))
      .map(async (n, i) => {
        try {
          await n.send(alert)
        } catch (error) {
          problems.push(`Notifier ${i + 1} couldn't send "${alert.title}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }),
  )
}

const RANK: Record<ComponentState, number> = { operational: 0, degraded: 1, down: 2 }

export function publicStatus(config: Config, states: Readonly<Record<string, CheckState>>, open: readonly (Incident | null)[], now: Date): PublicStatus {
  const publicChecks = new Set(config.checks.filter((c) => c.public).map((c) => c.id))
  const components = config.components.map((component) => {
    let state: ComponentState = "operational"
    for (const check of config.checks) {
      if (check.component !== component.name || !publicChecks.has(check.id)) continue
      const s = states[check.id]
      const mapped: ComponentState = s === "down" ? "down" : s === "degraded" ? "degraded" : "operational"
      if (RANK[mapped] > RANK[state]) state = mapped
    }
    return { name: component.name, state }
  })
  const overall = components.reduce<ComponentState>((worst, c) => (RANK[c.state] > RANK[worst] ? c.state : worst), "operational")
  return {
    format: STATUS_FORMAT,
    writtenAt: now.toISOString(),
    overall,
    components,
    incidents: open
      .filter((i): i is Incident => i !== null && publicChecks.has(i.check))
      .map((i) => ({ id: i.id, component: i.component, startedAt: i.startedAt })),
  }
}

import { describe, expect, it } from "vitest"
import {
  HISTORY_KEY,
  buildHistory,
  buildReport,
  componentSpans,
  creditFor,
  decide,
  incidentKey,
  memoryStore,
  merge,
  overlap,
  reportCsv,
  rollUp,
  subtract,
  validateConfig,
  type Config,
  type Incident,
  type Region,
} from "../src/index.ts"

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }
const regions: Region[] = [{ name: "us", capabilities: caps }]

function config(): Config {
  const result = validateConfig(
    {
      components: [
        { name: "Website", target: 99.9, credits: [{ below: 99.9, percent: 10 }, { below: 99, percent: 25 }] },
        { name: "API" },
      ],
      notifiers: [{ id: "ops", type: "webhook", secret: "HOOK" }],
      checks: [
        { id: "home", type: "http", component: "Website", url: "https://www.example.com/" },
        { id: "internal", type: "http", component: "Website", url: "https://internal.example.com/", public: false },
        { id: "api", type: "http", component: "API", url: "https://api.example.com/" },
      ],
    },
    regions,
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  return result.config
}

function incident(check: string, component: string, startedAt: string, endedAt?: string): Incident {
  return {
    format: "belltower.incident/1",
    id: `${check}-${startedAt.slice(0, 16).replace(/[-T:]/g, "")}`,
    key: check,
    priority: "P3",
    components: [component],
    checks: { [check]: { component, spans: [{ start: startedAt, ...(endedAt ? { end: endedAt } : {}) }], summary: "", regions: ["us"], firstFailures: {} } },
    startedAt,
    detectedAt: startedAt,
    ...(endedAt ? { endedAt, resolvedAt: endedAt } : {}),
  }
}

const span = (a: string, b: string) => ({ start: Date.parse(a), end: Date.parse(b) })

describe("spans", () => {
  it("merges overlapping and touching spans", () => {
    expect(merge([span("2026-11-01T10:05Z", "2026-11-01T10:20Z"), span("2026-11-01T10:00Z", "2026-11-01T10:10Z"), span("2026-11-01T10:20Z", "2026-11-01T10:30Z")])).toEqual([
      span("2026-11-01T10:00Z", "2026-11-01T10:30Z"),
    ])
  })

  it("subtracts maintenance from downtime", () => {
    expect(subtract([span("2026-11-01T10:00Z", "2026-11-01T11:00Z")], [span("2026-11-01T10:15Z", "2026-11-01T10:45Z")])).toEqual([
      span("2026-11-01T10:00Z", "2026-11-01T10:15Z"),
      span("2026-11-01T10:45Z", "2026-11-01T11:00Z"),
    ])
  })

  it("measures overlap with a window", () => {
    expect(overlap([span("2026-11-01T23:50Z", "2026-11-02T00:10Z")], span("2026-11-02T00:00Z", "2026-11-03T00:00Z"))).toBe(10 * 60_000)
  })
})

const since = new Date("2026-10-01T00:00:00Z")

describe("componentSpans", () => {
  it("counts each check's own spans when an incident covers several components", () => {
    const shared = incident("home", "Website", "2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z")
    shared.components.push("API")
    shared.checks.api = { component: "API", spans: [{ start: "2026-11-01T10:10:00Z", end: "2026-11-01T10:20:00Z" }, { start: "2026-11-01T10:40:00Z", end: "2026-11-01T10:45:00Z" }], summary: "", regions: ["us"], firstFailures: {} }
    shared.checks.internal = { component: "Website", spans: [{ start: "2026-11-01T09:00:00Z", end: "2026-11-01T12:00:00Z" }], summary: "", regions: ["us"], firstFailures: {} }
    const spans = componentSpans(config(), [shared], [], new Date("2026-11-02T00:00:00Z"))
    expect(spans.get("Website")?.down).toEqual([span("2026-11-01T10:00Z", "2026-11-01T11:00Z")])
    expect(spans.get("API")?.down).toEqual([span("2026-11-01T10:10Z", "2026-11-01T10:20Z"), span("2026-11-01T10:40Z", "2026-11-01T10:45Z")])
  })
})

describe("buildHistory", () => {
  it("gives 90 UTC days per component, with outages split across midnight", () => {
    const now = new Date("2026-11-15T12:00:00Z")
    const history = buildHistory(config(), [incident("home", "Website", "2026-11-14T23:50:00Z", "2026-11-15T00:20:00Z")], [], since, now)
    const website = history.components[0]
    expect(website?.days).toHaveLength(90)
    expect(website?.days.at(-2)).toEqual({ date: "2026-11-14", uptime: 99.305, downMinutes: 10, maintenanceMinutes: 0, degradedMinutes: 0, responseMs: null, incidents: ["home-202611142350"] })
    // Today counts only the 720 minutes so far: 20 down.
    expect(website?.days.at(-1)).toMatchObject({ date: "2026-11-15", uptime: 97.222, downMinutes: 20 })
    expect(history.components[1]?.days.at(-1)?.uptime).toBe(100)
  })

  it("shows no data before monitoring began", () => {
    const history = buildHistory(config(), [], [], new Date("2026-11-15T00:00:00Z"), new Date("2026-11-15T12:00:00Z"))
    expect(history.components[0]?.days.at(-2)).toMatchObject({ date: "2026-11-14", uptime: null })
    expect(history.components[0]?.days.at(-1)?.uptime).toBe(100)
  })

  it("leaves out incidents on internal checks", () => {
    const history = buildHistory(config(), [incident("internal", "Website", "2026-11-15T01:00:00Z", "2026-11-15T02:00:00Z")], [], since, new Date("2026-11-15T12:00:00Z"))
    expect(history.components[0]?.days.at(-1)).toMatchObject({ uptime: 100, incidents: [] })
  })

  it("never rounds a down minute up to 100%", () => {
    const history = buildHistory(config(), [incident("home", "Website", "2026-10-15T10:00:00Z", "2026-10-15T10:01:00Z")], [], since, new Date("2026-10-31T23:59:00Z"))
    const oct15 = history.components[0]?.days.find((d) => d.date === "2026-10-15")
    expect(oct15?.uptime).toBe(99.93)
  })

  it("reports this month to date against the target", () => {
    const history = buildHistory(config(), [], [], since, new Date("2026-11-15T12:00:00Z"))
    expect(history.components[0]).toMatchObject({ name: "Website", target: 99.9, month: { month: "2026-11", availability: 100 } })
    expect(history.components[1]?.target).toBeNull()
  })
})

describe("buildReport", () => {
  const october = Date.parse("2026-10-01T00:00:00Z")
  const now = new Date("2026-11-02T00:00:00Z")

  it("gives availability, downtime, incidents and time to recover for a complete month", () => {
    const incidents = [incident("home", "Website", "2026-10-10T10:00:00Z", "2026-10-10T10:30:00Z"), incident("home", "Website", "2026-10-20T08:00:00Z", "2026-10-20T08:20:00Z")]
    const report = buildReport(config(), incidents, [], october, since, now)
    expect(report).toMatchObject({ format: "belltower.report/1", month: "2026-10", complete: true })
    // October has 44,640 minutes; 50 down.
    expect(report.components[0]).toEqual({
      name: "Website",
      target: 99.9,
      minutesCounted: 44_640,
      downMinutes: 50,
      maintenanceMinutes: 0,
      availability: 99.887,
      targetMet: false,
      credit: 10,
      incidents: 2,
      meanMinutesToRecover: 25,
    })
  })

  it("leaves maintenance out of both downtime and the minutes counted", () => {
    const incidents = [incident("home", "Website", "2026-10-10T10:00:00Z", "2026-10-10T11:00:00Z")]
    const maintenance = [{ component: "Website", start: "2026-10-10T10:00:00Z", end: "2026-10-10T11:00:00Z" }]
    const website = buildReport(config(), incidents, maintenance, october, since, now).components[0]
    expect(website).toMatchObject({ minutesCounted: 44_580, downMinutes: 0, maintenanceMinutes: 60, availability: 100, targetMet: true, credit: 0 })
  })

  it("counts an open incident up to now, and marks the month incomplete", () => {
    const report = buildReport(config(), [incident("home", "Website", "2026-11-01T23:00:00Z")], [], Date.parse("2026-11-01T00:00:00Z"), since, now)
    expect(report.complete).toBe(false)
    expect(report.components[0]).toMatchObject({ minutesCounted: 1440, downMinutes: 60, incidents: 1, meanMinutesToRecover: null })
  })

  it("writes a CSV with one row per component", () => {
    const csv = reportCsv(buildReport(config(), [], [], october, since, now))
    expect(csv.split("\r\n")).toEqual([
      "component,availability_percent,target_percent,target_met,credit_percent,minutes_counted,minutes_down,maintenance_minutes,incidents,mean_minutes_to_recover",
      "Website,100,99.9,true,0,44640,0,0,0,",
      "API,100,,,0,44640,0,0,0,",
      "",
    ])
  })
})

describe("creditFor", () => {
  it("gives the largest tier the month falls below", () => {
    const website = config().components[0]
    if (!website) throw new Error("no component")
    expect([creditFor(website, 99.95), creditFor(website, 99.5), creditFor(website, 98), creditFor(website, null)]).toEqual([0, 10, 25, 0])
  })
})

describe("rollUp", () => {
  it("writes the history and this month's and last month's reports", async () => {
    const store = memoryStore()
    const inc = incident("home", "Website", "2026-11-10T10:00:00Z", "2026-11-10T10:10:00Z")
    await store.put(incidentKey(inc.id), JSON.stringify(inc))
    await rollUp({ config: config(), store, clock: { now: () => new Date("2026-11-15T12:00:00Z") }, since })
    expect(await store.list("public/")).toEqual([
      "public/history.json",
      "public/reports/2026-10.csv",
      "public/reports/2026-10.json",
      "public/reports/2026-11.csv",
      "public/reports/2026-11.json",
    ])
    const history = JSON.parse((await store.get(HISTORY_KEY)) ?? "")
    expect(history.components[0].days.find((d: { date: string }) => d.date === "2026-11-10")).toMatchObject({ downMinutes: 10, incidents: [inc.id] })
  })

  it("runs from decide on its first run, then every ten minutes", async () => {
    const store = memoryStore()
    let now = Date.parse("2026-11-15T12:00:30Z")
    const deps = { config: config(), byRegion: { us: ["home", "internal", "api"] }, store, clock: { now: () => new Date(now) }, notifiers: [] }
    await decide(deps)
    const first = JSON.parse((await store.get(HISTORY_KEY)) ?? "").writtenAt
    now += 5 * 60_000
    await decide(deps)
    expect(JSON.parse((await store.get(HISTORY_KEY)) ?? "").writtenAt).toBe(first)
    now += 5 * 60_000
    await decide(deps)
    expect(JSON.parse((await store.get(HISTORY_KEY)) ?? "").writtenAt).toBe("2026-11-15T12:10:30.000Z")
    // Monitoring began at the first run, so yesterday has no data.
    expect(JSON.parse((await store.get(HISTORY_KEY)) ?? "").components[0].days.at(-2).uptime).toBeNull()
  })
})

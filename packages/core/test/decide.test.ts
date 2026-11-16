import { describe, expect, it } from "vitest"
import {
  DEFAULT_THRESHOLDS,
  RESULTS_FORMAT,
  HISTORY_KEY,
  PAGE_KEY,
  STATUS_KEY,
  decide,
  judge,
  memoryStore,
  resultsKey,
  validateConfig,
  type Alert,
  type CheckResult,
  type Notifier,
  type Region,
  type Sample,
  type Store,
} from "../src/index.ts"

const pass = (id = "home", slow = false): CheckResult => ({ id, ok: true, slow, status: 200, timing: { totalMs: slow ? 6000 : 100 } })
const fail = (id = "home"): CheckResult => ({
  id,
  ok: false,
  slow: false,
  failure: "status",
  message: "Got status 503, expected 2xx.",
  status: 503,
  timing: { totalMs: 80 },
  headers: { "retry-after": "60" },
  bodyStart: "Service Unavailable",
})

/** Builds samples from a picture: one string per minute, one letter per region (p pass, f fail, s slow, - missing). */
function samples(...minutes: string[]): Sample[] {
  return minutes.map((m) => {
    const s: Record<string, CheckResult> = {}
    ;[...m].forEach((c, i) => {
      if (c === "p") s[`r${i}`] = pass()
      if (c === "s") s[`r${i}`] = pass("home", true)
      if (c === "f") s[`r${i}`] = fail()
    })
    return s
  })
}

const t = DEFAULT_THRESHOLDS

describe("judge", () => {
  it("doesn't confirm one region failing alone", () => {
    expect(judge(samples("fpp", "fpp", "fpp", "fpp"), 3, t, false).state).toBe("up")
  })

  it("confirms two regions failing in two consecutive minutes, from the first failing minute", () => {
    expect(judge(samples("ppp", "pff", "ffp", "fff"), 3, t, false)).toEqual({ state: "down", since: 1 })
  })

  it("needs the minutes to be consecutive", () => {
    expect(judge(samples("ffp", "ppp", "ffp"), 3, t, false).state).toBe("up")
  })

  it("never confirms from silence: a missing minute breaks the streak", () => {
    expect(judge(samples("ffp", "---", "ffp"), 3, t, false).state).toBe("up")
  })

  it("with a single region, confirms two consecutive failures", () => {
    expect(judge(samples("p", "f", "f"), 1, t, false)).toEqual({ state: "down", since: 1 })
    expect(judge(samples("p", "p", "f"), 1, t, false).state).toBe("up")
  })

  it("marks degraded after five minutes slow in two regions", () => {
    expect(judge(samples("ssp", "ssp", "ssp", "ssp", "ssp"), 3, t, false)).toEqual({ state: "degraded", since: 0 })
    expect(judge(samples("ppp", "ssp", "ssp", "ssp", "ssp"), 3, t, false).state).toBe("up")
  })

  it("stays down until three minutes pass in two regions", () => {
    expect(judge(samples("fff", "ppf", "ppf"), 3, t, true)).toEqual({ state: "down", since: null })
    expect(judge(samples("fff", "ppf", "ppf", "pfp"), 3, t, true)).toEqual({ state: "up", since: 1 })
  })

  it("takes counts from the thresholds", () => {
    const strict = { ...t, confirmRegions: 3, confirmMinutes: 3 }
    expect(judge(samples("ffp", "ffp", "ffp"), 3, strict, false).state).toBe("up")
    expect(judge(samples("fff", "fff", "fff"), 3, strict, false).state).toBe("down")
  })
})

const caps = { tlsInspector: false, inbox: false, sms: true, skipTlsVerify: false, timingBreakdown: false }
const regions: Region[] = ["us", "eu", "ap"].map((name) => ({ name, capabilities: caps }))

function world(extraChecks: Record<string, unknown>[] = []) {
  const result = validateConfig(
    {
      components: [{ name: "Website" }, { name: "API" }],
      notifiers: [
        { id: "ops", type: "email", to: ["ops@example.com"] },
        { id: "pager", type: "sms", to: ["+15555550100"] },
      ],
      checks: [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/" }, ...extraChecks],
    },
    regions,
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  const store = memoryStore()
  let now = Date.parse("2026-11-15T10:00:30Z")
  const sent: { to: string; alert: Alert }[] = []
  const notifier = (to: string, upTo: Notifier["upTo"]): Notifier => ({ upTo, send: async (alert) => void sent.push({ to, alert }) })
  const deps = {
    config: result.config,
    byRegion: result.byRegion,
    store,
    clock: { now: () => new Date(now) },
    notifiers: [notifier("email", "P4"), notifier("sms", "P2")],
  }
  /** Records one minute of results (a letter per region in us, eu, ap order), then runs decide 30 seconds into the next minute. */
  async function minute(picture: string, ids = ["home"]) {
    const at = new Date(now - 30_000)
    await Promise.all(
      ["us", "eu", "ap"].map(async (region, i) => {
        const c = picture[i]
        if (c === "-") return
        const results = ids.map((id) => (c === "f" ? fail(id) : pass(id, c === "s")))
        await store.put(resultsKey(region, at), JSON.stringify({ format: RESULTS_FORMAT, region, startedAt: at.toISOString(), finishedAt: at.toISOString(), results }))
      }),
    )
    now += 60_000
    return decide(deps)
  }
  return { deps, store, sent, minute }
}

const status = async (store: Store) => JSON.parse((await store.get(STATUS_KEY)) ?? "null")

describe("decide", () => {
  it("opens an incident from the first failing minute and alerts once", async () => {
    const { minute, sent, store } = world()
    await minute("ppp")
    expect((await minute("ffp")).opened).toEqual([])
    const report = await minute("fff")
    expect(report.opened).toHaveLength(1)
    const incident = report.opened[0]
    expect(incident).toMatchObject({
      id: "home-202611151001",
      key: "home",
      priority: "P3",
      components: ["Website"],
      startedAt: "2026-11-15T10:01:00.000Z",
      detectedAt: "2026-11-15T10:03:30.000Z",
    })
    expect(incident?.checks.home).toMatchObject({ component: "Website", spans: [{ start: "2026-11-15T10:01:00.000Z" }], regions: ["ap", "eu", "us"] })
    expect(incident?.checks.home?.firstFailures.us).toMatchObject({ at: "2026-11-15T10:01:00.000Z", status: 503, bodyStart: "Service Unavailable" })
    expect(incident?.checks.home?.firstFailures.ap?.at).toBe("2026-11-15T10:02:00.000Z")
    expect(JSON.parse((await store.get("incidents/home-202611151001.json")) ?? "")).toEqual(incident)

    expect(sent).toEqual([
      {
        to: "email",
        alert: {
          priority: "P3",
          title: "P3 down: home (Website)",
          text: "home has failed in ap, eu, us since 10:01 UTC.\nGot status 503, expected 2xx.\nURL: https://www.example.com/\nBelltower will send another alert when it recovers.",
        },
      },
    ])
    expect((await minute("fff")).opened).toEqual([])
    expect(sent).toHaveLength(1)
  })

  it("ignores one region failing alone", async () => {
    const { minute, sent } = world()
    for (let i = 0; i < 6; i++) await minute("fpp")
    expect(sent).toEqual([])
  })

  it("resolves after three passing minutes and gives the duration", async () => {
    const { minute, sent, store } = world()
    await minute("fff")
    await minute("fff")
    await minute("ppp")
    expect((await minute("pfp")).resolved).toEqual([])
    const report = await minute("ppf")
    expect(report.resolved[0]).toMatchObject({ endedAt: "2026-11-15T10:02:00.000Z", resolvedAt: "2026-11-15T10:05:30.000Z" })
    expect(sent[1]?.alert).toEqual({
      priority: "P3",
      title: "P3 recovered: home (Website)",
      text: "home is passing again. It was down for 2 minutes, from 10:00 UTC to 10:02 UTC.",
    })
    expect(JSON.parse((await store.get("incidents/home-202611151000.json")) ?? "").resolvedAt).toBe("2026-11-15T10:05:30.000Z")
    expect((await status(store)).overall).toBe("operational")
  })

  it("texts for a P1 check as well as emailing", async () => {
    const { minute, sent } = world([{ id: "private", type: "http", component: "API", url: "https://www.example.com/account", rejectKeyword: "balance", priority: "P1" }])
    await minute("ppp", ["home", "private"])
    await minute("fff", ["private"])
    await minute("fff", ["private"])
    expect(sent.map((s) => [s.to, s.alert.priority, s.alert.title])).toEqual([
      ["email", "P1", "P1 down: private (API)"],
      ["sms", "P1", "P1 down: private (API)"],
    ])
  })

  it("records a P5 incident without sending it", async () => {
    const { minute, sent, store } = world([{ id: "batch", type: "http", component: "API", url: "https://batch.example.com/", priority: "P5" }])
    await minute("ppp", ["home", "batch"])
    await minute("fff", ["batch"])
    const report = await minute("fff", ["batch"])
    expect(report.opened.map((i) => i.priority)).toEqual(["P5"])
    expect(sent).toEqual([])
    expect(await store.get("incidents/batch-202611151001.json")).not.toBeNull()
  })

  it("folds checks that share an incident key into one incident and one alert", async () => {
    const shared = { type: "http" as const, url: "https://db.example.com/", incidentKey: "database" }
    const { minute, sent, store } = world([
      { ...shared, id: "orders", component: "API" },
      { ...shared, id: "search", component: "API", priority: "P2" },
    ])
    const all = ["home", "orders", "search"]
    await minute("ppp", all)
    await minute("fff", ["orders", "search"])
    const report = await minute("fff", ["orders", "search"])
    expect(report.opened).toHaveLength(1)
    expect(report.opened[0]).toMatchObject({ id: "database-202611151001", key: "database", priority: "P2", components: ["API"] })
    expect(Object.keys(report.opened[0]?.checks ?? {})).toEqual(["orders", "search"])
    expect(sent.map((s) => [s.to, s.alert.title])).toEqual([
      ["email", "P2 down: orders, search (API)"],
      ["sms", "P2 down: orders, search (API)"],
    ])
    expect((await status(store)).incidents).toEqual([{ id: "database-202611151001", components: ["API"], startedAt: "2026-11-15T10:01:00.000Z" }])

    // One check recovers; the incident stays open until the other does too.
    for (let i = 0; i < 3; i++) await minute("ppp", ["home", "orders"])
    expect(sent).toHaveLength(2)
    const incident = JSON.parse((await store.get("incidents/database-202611151001.json")) ?? "")
    expect(incident.checks.orders.spans).toEqual([{ start: "2026-11-15T10:01:00.000Z", end: "2026-11-15T10:03:00.000Z" }])
    expect(incident.resolvedAt).toBeUndefined()
    let resolved
    for (let i = 0; i < 3; i++) resolved = await minute("ppp", all)
    expect(resolved?.resolved[0]).toMatchObject({ id: "database-202611151001", endedAt: "2026-11-15T10:06:00.000Z" })
    expect(sent.at(-1)?.alert.title).toBe("P2 recovered: orders, search (API)")
  })

  it("adds a check to an open incident silently unless it's more urgent", async () => {
    const shared = { type: "http" as const, url: "https://db.example.com/", incidentKey: "database" }
    const { minute, sent, store } = world([
      { ...shared, id: "orders", component: "API" },
      { ...shared, id: "search", component: "API" },
      { ...shared, id: "billing", component: "Website", priority: "P1" },
    ])
    await minute("ppp", ["home", "orders", "search", "billing"])
    await minute("fff", ["orders"])
    await minute("fff", ["orders"])
    expect(sent.map((s) => s.alert.title)).toEqual(["P3 down: orders (API)"])

    // search joins at P3: recorded, no alert.
    await minute("fff", ["orders", "search"])
    await minute("fff", ["orders", "search"])
    expect(sent).toHaveLength(1)

    // billing joins at P1: the incident becomes P1 and the SMS notifier hears too.
    await minute("fff", ["orders", "search", "billing"])
    await minute("fff", ["orders", "search", "billing"])
    expect(sent.slice(1).map((s) => [s.to, s.alert.title])).toEqual([
      ["email", "P1 down: billing (Website)"],
      ["sms", "P1 down: billing (Website)"],
    ])
    expect(sent[1]?.alert.text).toContain("Part of incident database-202611151001, with orders, search.")
    const incident = JSON.parse((await store.get("incidents/database-202611151001.json")) ?? "null")
    expect(incident).toMatchObject({ priority: "P1", components: ["API", "Website"] })
  })

  it("writes public status from public checks only, with the time it was written", async () => {
    const { minute, store } = world([{ id: "internal", type: "http", component: "API", url: "https://internal.example.com/", public: false }])
    await minute("fff", ["home", "internal"])
    await minute("fff", ["home", "internal"])
    expect(await status(store)).toEqual({
      format: "belltower.status/1",
      writtenAt: "2026-11-15T10:02:30.000Z",
      overall: "major",
      components: [
        { name: "Website", state: "major" },
        { name: "API", state: "operational" },
      ],
      incidents: [{ id: "home-202611151000", components: ["Website"], startedAt: "2026-11-15T10:00:00.000Z" }],
      regions: ["us", "eu", "ap"].map((name) => ({ name, lastResultsAt: "2026-11-15T10:01:00.000Z" })),
    })
  })

  it("keeps each region's last results time after it stops writing", async () => {
    const { minute, store } = world()
    await minute("ppp")
    for (let i = 0; i < 12; i++) await minute("pp-")
    const regions = (await status(store)).regions
    expect(regions).toEqual([
      { name: "us", lastResultsAt: "2026-11-15T10:12:00.000Z" },
      { name: "eu", lastResultsAt: "2026-11-15T10:12:00.000Z" },
      { name: "ap", lastResultsAt: "2026-11-15T10:00:00.000Z" },
    ])
  })

  it("publishes the page section and components' public fields, nothing else", async () => {
    const { minute, store } = world()
    await minute("ppp")
    const page = JSON.parse((await store.get(PAGE_KEY)) ?? "null")
    expect(page).toEqual({
      format: "belltower.page/1",
      writtenAt: "2026-11-15T10:01:30.000Z",
      page: { name: "Status", mode: "system", poweredBy: true },
      components: [{ name: "Website" }, { name: "API" }],
    })
  })

  it("counts degraded minutes and response times into the history", async () => {
    const { minute, store } = world()
    for (let i = 0; i < 5; i++) await minute("ppp")
    for (let i = 0; i < 7; i++) await minute("ssp")
    // Slow from 10:05, degraded from the fifth slow minute (10:09). The roll-up at 10:11:30 has 10:09 and 10:10.
    const history = JSON.parse((await store.get(HISTORY_KEY)) ?? "null")
    const today = history.components[0].days.at(-1)
    expect(today.degradedMinutes).toBe(2)
    expect(today.responseMs).toBe(101) // 100 ms, read from a 2% bucket
  })

  it("shows degraded after five slow minutes, without an incident", async () => {
    const { minute, store, sent } = world()
    for (let i = 0; i < 5; i++) await minute("ssp")
    expect((await status(store)).components[0]).toEqual({ name: "Website", state: "degraded" })
    expect(sent).toEqual([])
  })

  it("keeps going when a notifier fails, and reports it", async () => {
    const { deps, minute } = world()
    deps.notifiers = [{ upTo: "P4", send: async () => Promise.reject(new Error("SMTP refused")) }, ...deps.notifiers]
    await minute("fff")
    const report = await minute("fff")
    expect(report.opened).toHaveLength(1)
    expect(report.problems).toEqual(['Notifier 1 couldn\'t send "P3 down: home (Website)": SMTP refused'])
  })

  it("skips a results file it can't read, and says which", async () => {
    const { store, minute } = world()
    await store.put(resultsKey("us", new Date("2026-11-15T10:00:00Z")), "not json")
    const report = await minute("-pp")
    expect(report.problems).toEqual(["results/us/2026/11/15/1000.json isn't valid JSON; its results were skipped."])
  })

  it("leaves out results for the current minute, which may not be written yet", async () => {
    const { deps, store } = world()
    // Two failing minutes, but the second is the minute decide runs in.
    for (const at of ["2026-11-15T10:00:00Z", "2026-11-15T10:01:00Z"]) {
      for (const region of ["us", "eu", "ap"]) {
        await store.put(resultsKey(region, new Date(at)), JSON.stringify({ format: RESULTS_FORMAT, region, startedAt: at, finishedAt: at, results: [fail()] }))
      }
    }
    deps.clock = { now: () => new Date("2026-11-15T10:01:10Z") }
    expect((await decide(deps)).opened).toEqual([])
  })
})

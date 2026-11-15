import { describe, expect, it } from "vitest"
import {
  DEFAULT_THRESHOLDS,
  RESULTS_FORMAT,
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
  const notifier = (to: string, levels: Notifier["levels"]): Notifier => ({ levels, send: async (alert) => void sent.push({ to, alert }) })
  const deps = {
    config: result.config,
    byRegion: result.byRegion,
    store,
    clock: { now: () => new Date(now) },
    notifiers: [notifier("email", ["warn", "alert", "critical"]), notifier("sms", ["critical"])],
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
      check: "home",
      component: "Website",
      level: "alert",
      startedAt: "2026-11-15T10:01:00.000Z",
      detectedAt: "2026-11-15T10:03:30.000Z",
      regions: ["ap", "eu", "us"],
    })
    expect(incident?.firstFailures.us).toMatchObject({ at: "2026-11-15T10:01:00.000Z", status: 503, bodyStart: "Service Unavailable" })
    expect(incident?.firstFailures.ap?.at).toBe("2026-11-15T10:02:00.000Z")
    expect(JSON.parse((await store.get("incidents/home-202611151001.json")) ?? "")).toEqual(incident)

    expect(sent).toEqual([
      {
        to: "email",
        alert: {
          level: "alert",
          title: "Down: home (Website)",
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
      level: "alert",
      title: "Recovered: home (Website)",
      text: "home is passing again. It was down for 2 minutes, from 10:00 UTC to 10:02 UTC.",
    })
    expect(JSON.parse((await store.get("incidents/home-202611151000.json")) ?? "").resolvedAt).toBe("2026-11-15T10:05:30.000Z")
    expect((await status(store)).overall).toBe("operational")
  })

  it("texts for a critical check as well as emailing", async () => {
    const { minute, sent } = world([{ id: "private", type: "http", component: "API", url: "https://www.example.com/account", rejectKeyword: "balance", severity: "critical" }])
    await minute("ppp", ["home", "private"])
    await minute("fff", ["private"])
    await minute("fff", ["private"])
    expect(sent.map((s) => [s.to, s.alert.level, s.alert.title])).toEqual([
      ["email", "critical", "Down: private (API)"],
      ["sms", "critical", "Down: private (API)"],
    ])
  })

  it("writes public status from public checks only, with the time it was written", async () => {
    const { minute, store } = world([{ id: "internal", type: "http", component: "API", url: "https://internal.example.com/", public: false }])
    await minute("fff", ["home", "internal"])
    await minute("fff", ["home", "internal"])
    expect(await status(store)).toEqual({
      format: "belltower.status/1",
      writtenAt: "2026-11-15T10:02:30.000Z",
      overall: "down",
      components: [
        { name: "Website", state: "down" },
        { name: "API", state: "operational" },
      ],
      incidents: [{ id: "home-202611151000", component: "Website", startedAt: "2026-11-15T10:00:00.000Z" }],
    })
  })

  it("shows degraded after five slow minutes, without an incident", async () => {
    const { minute, store, sent } = world()
    for (let i = 0; i < 5; i++) await minute("ssp")
    expect((await status(store)).components[0]).toEqual({ name: "Website", state: "degraded" })
    expect(sent).toEqual([])
  })

  it("keeps going when a notifier fails, and reports it", async () => {
    const { deps, minute } = world()
    deps.notifiers = [{ levels: ["alert"], send: async () => Promise.reject(new Error("SMTP refused")) }, ...deps.notifiers]
    await minute("fff")
    const report = await minute("fff")
    expect(report.opened).toHaveLength(1)
    expect(report.problems).toEqual(['Notifier 1 couldn\'t send "Down: home (Website)": SMTP refused'])
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

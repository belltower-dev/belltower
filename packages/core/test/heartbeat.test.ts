import { describe, expect, it } from "vitest"
import {
  decide,
  handle,
  heartbeatKey,
  judgeHeartbeat,
  memoryStore,
  validateConfig,
  type Alert,
  type HeartbeatCheck,
  type HeartbeatRecord,
} from "../src/index.ts"

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }

function world() {
  const result = validateConfig(
    {
      components: [{ name: "Jobs" }],
      notifiers: [{ id: "ops", type: "email", to: ["ops@example.com"] }],
      checks: [
        { id: "nightly", type: "heartbeat", component: "Jobs", period: "1h", grace: "5m", token: "NIGHTLY_TOKEN", public: false },
        { id: "backup", type: "heartbeat", component: "Jobs", period: "1d", token: "BACKUP_TOKEN" },
      ],
    },
    [{ name: "us", capabilities: caps }],
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  const store = memoryStore()
  let now = Date.parse("2026-11-15T10:00:00Z")
  const tokens: Record<string, string> = { NIGHTLY_TOKEN: "n1ght-ly-t0ken", BACKUP_TOKEN: "b4ckup-t0ken" }
  const sent: Alert[] = []
  const deps = {
    config: result.config,
    byRegion: result.byRegion,
    store,
    clock: { now: () => new Date(now) },
    secrets: { get: async (name: string) => tokens[name] ?? null },
    notifiers: [{ upTo: "P4" as const, send: async (a: Alert) => void sent.push(a) }],
  }
  const ping = (path: string, method = "GET") => handle(new Request(`https://monitor.example.com${path}`, { method }), deps)
  const record = async (id: string) => JSON.parse((await store.get(heartbeatKey(id))) ?? "null") as HeartbeatRecord | null
  return { deps, store, sent, ping, record, advance: (ms: number) => (now += ms) }
}

describe("handle", () => {
  it("records a success", async () => {
    const { ping, record } = world()
    const response = await ping("/hb/n1ght-ly-t0ken")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("Recorded a success for nightly.")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await record("nightly")).toEqual({ format: "belltower.heartbeat/1", lastSuccess: "2026-11-15T10:00:00.000Z" })
  })

  it("records a failure, keeping the last success", async () => {
    const { ping, record, advance } = world()
    await ping("/hb/n1ght-ly-t0ken")
    advance(60_000)
    expect((await ping("/hb/n1ght-ly-t0ken/fail", "POST")).status).toBe(200)
    expect(await record("nightly")).toMatchObject({ lastSuccess: "2026-11-15T10:00:00.000Z", lastFailure: "2026-11-15T10:01:00.000Z" })
  })

  it("keeps the run ID of a success for the email round trip", async () => {
    const { ping, record } = world()
    await ping("/hb/b4ckup-t0ken?run=abc123")
    expect((await record("backup"))?.runId).toBe("abc123")
  })

  it("works under a path prefix", async () => {
    const { ping } = world()
    expect((await ping("/belltower/hb/b4ckup-t0ken/")).status).toBe(200)
  })

  it("answers an unknown token with 404 and writes nothing", async () => {
    const { ping, store } = world()
    const response = await ping("/hb/wrong-token")
    expect(response.status).toBe(404)
    expect(await response.text()).toContain("No heartbeat has this token")
    expect(await store.list("heartbeats/")).toEqual([])
  })

  it("never echoes the token", async () => {
    const { ping } = world()
    expect(await (await ping("/hb/n1ght-ly-t0ken")).text()).not.toContain("n1ght")
  })

  it("refuses other methods and other paths", async () => {
    const { ping } = world()
    const put = await ping("/hb/n1ght-ly-t0ken", "PUT")
    expect(put.status).toBe(405)
    expect(put.headers.get("allow")).toBe("GET, HEAD, POST")
    expect((await ping("/status")).status).toBe(404)
  })
})

const nightly = { id: "nightly", period: 3600, grace: 300 } as HeartbeatCheck
const at = (iso: string) => new Date(iso)

describe("judgeHeartbeat", () => {
  it("is pending until the first ping", () => {
    expect(judgeHeartbeat(nightly, null, at("2026-11-15T10:00:00Z"))).toEqual({ state: "pending" })
  })

  it("is up within period plus grace of the last success", () => {
    const record = { format: "belltower.heartbeat/1", lastSuccess: "2026-11-15T10:00:00Z" } as const
    expect(judgeHeartbeat(nightly, record, at("2026-11-15T11:05:00Z")).state).toBe("up")
  })

  it("is down once period plus grace pass, from the moment it was due", () => {
    const record = { format: "belltower.heartbeat/1", lastSuccess: "2026-11-15T10:00:00Z" } as const
    expect(judgeHeartbeat(nightly, record, at("2026-11-15T11:05:01Z"))).toEqual({
      state: "down",
      since: at("2026-11-15T11:05:00Z"),
      reason: "nightly hasn't reported a success since 2026-11-15 10:00 UTC. One was due by 2026-11-15 11:05 UTC.",
    })
  })

  it("is down at once on a failure newer than the last success", () => {
    const record = { format: "belltower.heartbeat/1", lastSuccess: "2026-11-15T10:00:00Z", lastFailure: "2026-11-15T10:30:00Z" } as const
    expect(judgeHeartbeat(nightly, record, at("2026-11-15T10:30:10Z"))).toMatchObject({ state: "down", since: at("2026-11-15T10:30:00Z") })
  })

  it("is up again on the next success", () => {
    const record = { format: "belltower.heartbeat/1", lastSuccess: "2026-11-15T10:31:00Z", lastFailure: "2026-11-15T10:30:00Z" } as const
    expect(judgeHeartbeat(nightly, record, at("2026-11-15T10:31:10Z")).state).toBe("up")
  })
})

describe("decide with heartbeats", () => {
  it("alerts when a heartbeat misses its period plus grace, and recovers on the next success", async () => {
    const { deps, ping, sent, advance } = world()
    await ping("/hb/n1ght-ly-t0ken")
    advance(65 * 60_000)
    expect((await decide(deps)).opened).toEqual([])
    advance(60_000)
    const report = await decide(deps)
    expect(report.opened[0]).toMatchObject({ id: "nightly-202611151105", startedAt: "2026-11-15T11:05:00.000Z" })
    expect(report.opened[0]?.checks.nightly?.regions).toEqual([])
    expect(sent[0]).toEqual({
      priority: "P3",
      title: "P3 down: nightly (Jobs)",
      text: "nightly hasn't reported a success since 2026-11-15 10:00 UTC. One was due by 2026-11-15 11:05 UTC.\nBelltower will send another alert when it recovers.",
    })
    advance(10 * 60_000)
    await ping("/hb/n1ght-ly-t0ken")
    const recovered = await decide(deps)
    expect(recovered.resolved[0]).toMatchObject({ endedAt: "2026-11-15T11:16:00.000Z" })
    expect(sent[1]?.text).toBe("nightly is passing again. It was down for 11 minutes, from 11:05 UTC to 11:16 UTC.")
  })

  it("alerts at once on a /fail", async () => {
    const { deps, ping, sent } = world()
    await ping("/hb/b4ckup-t0ken/fail")
    expect((await decide(deps)).opened).toHaveLength(1)
    expect(sent[0]?.text).toContain("backup reported a failure at 2026-11-15 10:00 UTC.")
  })

  it("doesn't alert for a heartbeat that has never pinged", async () => {
    const { deps, sent } = world()
    const report = await decide(deps)
    expect(report.states).toEqual({ nightly: "pending", backup: "pending" })
    expect(sent).toEqual([])
  })
})

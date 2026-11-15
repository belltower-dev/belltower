import { describe, expect, it } from "vitest"
import pkg from "../package.json" with { type: "json" }
import {
  RESULTS_FORMAT,
  VERSION,
  resultsKey,
  runChecks,
  validateConfig,
  webHttpClient,
  type Clock,
  type HttpClient,
  type Region,
  type Store,
} from "../src/index.ts"

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: true, timingBreakdown: false }
const regions: Region[] = [{ name: "us", capabilities: caps }, { name: "eu", capabilities: caps }]

/** A clock the fake HTTP client moves forward, so timings are exact. */
function fakeClock(start = "2026-11-15T10:07:30.000Z") {
  let t = Date.parse(start)
  const clock: Clock & { advance(ms: number): void } = { now: () => new Date(t), advance: (ms) => (t += ms) }
  return clock
}

function memoryStore() {
  const files = new Map<string, string>()
  const store: Store & { files: Map<string, string> } = {
    files,
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => void files.set(key, body),
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
  }
  return store
}

interface Reply {
  status?: number
  body?: string
  headers?: Record<string, string>
  waitMs?: number
  downloadMs?: number
  error?: Error
  hang?: boolean
}

/** Answers each URL with a canned reply and records the requests it saw. */
function fakeHttp(clock: ReturnType<typeof fakeClock>, replies: Record<string, Reply>) {
  const seen: { request: Request; verifyTls: boolean }[] = []
  const http: HttpClient & { seen: typeof seen } = {
    seen,
    async fetch(request, { verifyTls }) {
      seen.push({ request, verifyTls })
      const reply = replies[request.url] ?? { status: 404 }
      if (reply.hang) {
        return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      }
      if (reply.error) throw reply.error
      clock.advance(reply.waitMs ?? 100)
      const status = reply.status ?? 200
      const noBody = [101, 204, 205, 304].includes(status)
      // pull with no queue, so the download time passes only when the core reads the body.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          clock.advance(reply.downloadMs ?? 0)
          controller.enqueue(new TextEncoder().encode(reply.body ?? ""))
          controller.close()
        },
      }, { highWaterMark: 0 })
      return { response: new Response(noBody ? null : body, { status, headers: reply.headers ?? {} }) }
    },
  }
  return http
}

function setup(checks: Record<string, unknown>[], replies: Record<string, Reply>) {
  const result = validateConfig(
    {
      components: [{ name: "Website" }],
      notifiers: [{ id: "ops", type: "email", to: ["ops@example.com"] }],
      checks: checks.map((c, i) => ({ id: `check-${i}`, type: "http", component: "Website", ...c })),
    },
    regions,
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  const clock = fakeClock()
  const store = memoryStore()
  const http = fakeHttp(clock, replies)
  const secrets = { get: async (name: string) => (name === "SITE_LOGIN" ? "monitor:pässword" : null) }
  const deps = { config: result.config, byRegion: result.byRegion, store, secrets, clock, http }
  return { deps, store, http, clock, run: async () => (await runChecks("us", deps)).results }
}

const URL_A = "https://www.example.com/"

describe("runChecks", () => {
  it("passes a 200 and records the timing it can see", async () => {
    const { run } = setup([{ url: URL_A }], { [URL_A]: { status: 200, body: "ok", waitMs: 120, downloadMs: 30 } })
    expect(await run()).toEqual([{ id: "check-0", ok: true, slow: false, status: 200, timing: { firstByteMs: 120, downloadMs: 30, totalMs: 150 } }])
  })

  it("keeps the adapter's DNS, connect and TLS times", async () => {
    const { deps, clock } = setup([{ url: URL_A }], {})
    const http: HttpClient = {
      async fetch() {
        clock.advance(80)
        return { response: new Response("ok"), timing: { dnsMs: 10, connectMs: 20, tlsMs: 30 } }
      },
    }
    const file = await runChecks("us", { ...deps, http })
    expect(file.results[0]?.timing).toEqual({ dnsMs: 10, connectMs: 20, tlsMs: 30, firstByteMs: 80, downloadMs: 0, totalMs: 80 })
  })

  it("marks a passing check slow past slowSeconds", async () => {
    const { run } = setup([{ url: URL_A, slowSeconds: 2 }], { [URL_A]: { waitMs: 2500 } })
    expect((await run())[0]).toMatchObject({ ok: true, slow: true })
  })

  it("fails on a status outside expectStatus and keeps the details", async () => {
    const { run } = setup([{ url: URL_A }], { [URL_A]: { status: 503, body: "Service Unavailable", headers: { "retry-after": "60" } } })
    expect((await run())[0]).toMatchObject({
      ok: false,
      failure: "status",
      message: "Got status 503, expected 2xx.",
      status: 503,
      headers: { "retry-after": "60" },
      bodyStart: "Service Unavailable",
    })
  })

  it("accepts the codes expectStatus lists", async () => {
    const { run } = setup([{ url: URL_A, expectStatus: ["2xx", 304] }], { [URL_A]: { status: 304 } })
    expect((await run())[0]?.ok).toBe(true)
  })

  it("fails when expectKeyword is missing", async () => {
    const { run } = setup([{ url: URL_A, expectKeyword: "Welcome" }], { [URL_A]: { body: "Maintenance" } })
    expect((await run())[0]).toMatchObject({ ok: false, failure: "missing-keyword", message: 'The body doesn\'t contain "Welcome".' })
  })

  it("fails when rejectKeyword appears, for checks that private pages stay private", async () => {
    const { run } = setup([{ url: URL_A, rejectKeyword: "Account balance" }], { [URL_A]: { body: "<h1>Account balance</h1>" } })
    expect((await run())[0]).toMatchObject({ ok: false, failure: "rejected-keyword" })
  })

  it("reports a rejected keyword ahead of a wrong status, since it means private content is showing", async () => {
    const { run } = setup([{ url: URL_A, expectStatus: 401, rejectKeyword: "Account balance" }], { [URL_A]: { status: 200, body: "Account balance: 10" } })
    expect((await run())[0]).toMatchObject({ ok: false, failure: "rejected-keyword", message: 'The body contains "Account balance", which it must not.' })
  })

  it("fails on a network error", async () => {
    const { run } = setup([{ url: URL_A }], { [URL_A]: { error: new TypeError("getaddrinfo ENOTFOUND") } })
    expect((await run())[0]).toMatchObject({ ok: false, failure: "network", message: "The request failed: getaddrinfo ENOTFOUND." })
  })

  it("fails on a timeout", async () => {
    const { run } = setup([{ url: URL_A, timeoutSeconds: 0.05, slowSeconds: 0.01 }], { [URL_A]: { hang: true } })
    expect((await run())[0]).toMatchObject({ ok: false, failure: "timeout", message: "No complete response within 0.05 seconds." })
  })

  it("keeps only the first 2 KB of the body, on a character boundary", async () => {
    const { run } = setup([{ url: URL_A }], { [URL_A]: { status: 500, body: `${"a".repeat(2047)}é and more` } })
    expect((await run())[0]?.bodyStart).toBe("a".repeat(2047))
  })

  it("sends the method, headers, body, user agent and basic auth", async () => {
    const { run, http } = setup(
      [{ url: URL_A, method: "POST", headers: { "X-Probe": "1" }, body: '{"q":1}', basicAuth: "SITE_LOGIN" }],
      { [URL_A]: {} },
    )
    await run()
    const sent = http.seen[0]?.request
    expect(sent?.method).toBe("POST")
    expect(sent?.headers.get("user-agent")).toBe(`Belltower/${VERSION}`)
    expect(sent?.headers.get("x-probe")).toBe("1")
    expect(sent?.headers.get("authorization")).toBe(`Basic ${btoa(String.fromCharCode(...new TextEncoder().encode("monitor:pässword")))}`)
    expect(await sent?.text()).toBe('{"q":1}')
    expect(sent?.redirect).toBe("follow")
  })

  it("fails without sending when the basicAuth secret isn't set", async () => {
    const { run, http } = setup([{ url: URL_A, basicAuth: "MISSING" }], { [URL_A]: {} })
    expect((await run())[0]).toMatchObject({ ok: false, failure: "secret" })
    expect(http.seen).toHaveLength(0)
  })

  it("asks the client not to follow redirects or verify TLS when the check says so", async () => {
    const { run, http } = setup([{ url: URL_A, followRedirects: false, verifyTls: false, expectStatus: 301 }], { [URL_A]: { status: 301 } })
    expect((await run())[0]?.ok).toBe(true)
    expect(http.seen[0]?.request.redirect).toBe("manual")
    expect(http.seen[0]?.verifyTls).toBe(false)
  })

  it("runs only HTTP checks assigned to the region", async () => {
    const { run } = setup(
      [
        { url: URL_A },
        { url: "https://eu.example.com/", regions: ["eu"] },
        { type: "heartbeat", period: "1h", token: "JOB_TOKEN" },
      ],
      { [URL_A]: {} },
    )
    expect((await run()).map((r) => r.id)).toEqual(["check-0"])
  })

  it("writes one results file per run under the region and minute", async () => {
    const { deps, store } = setup([{ url: URL_A }], { [URL_A]: {} })
    await runChecks("us", deps)
    const key = "results/us/2026/11/15/1007.json"
    expect([...store.files.keys()]).toEqual([key])
    expect(JSON.parse(store.files.get(key) ?? "")).toMatchObject({
      format: RESULTS_FORMAT,
      region: "us",
      startedAt: "2026-11-15T10:07:30.000Z",
      finishedAt: "2026-11-15T10:07:30.100Z",
    })
  })

  it("refuses a region that isn't configured", async () => {
    const { deps } = setup([{ url: URL_A }], {})
    await expect(runChecks("mars", deps)).rejects.toThrow('Region "mars"')
  })
})

describe("resultsKey", () => {
  it("uses UTC", () => {
    expect(resultsKey("eu", new Date("2026-01-02T23:59:59+02:00"))).toBe("results/eu/2026/01/02/2159.json")
  })
})

describe("webHttpClient", () => {
  it("passes the request to fetch", async () => {
    const client = webHttpClient(async (input) => new Response((input as Request).url))
    const { response } = await client.fetch(new Request(URL_A), { verifyTls: true })
    expect(await response.text()).toBe(URL_A)
  })

  it("can't skip TLS verification, and fails the check with the reason", async () => {
    const { deps } = setup([{ url: URL_A, verifyTls: false }], {})
    const file = await runChecks("us", { ...deps, http: webHttpClient(async () => new Response("ok")) })
    expect(file.results[0]).toMatchObject({ ok: false, failure: "unsupported" })
  })
})

describe("VERSION", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(pkg.version)
  })
})

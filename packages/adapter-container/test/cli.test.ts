import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RESULTS_FORMAT, resultsKey } from "@belltower/core"
import { localFolderStore, runCli, type Io } from "../src/index.ts"

let service: Server
let serviceUrl = ""
const hooks: unknown[] = []

beforeAll(async () => {
  service = createServer((req, res) => {
    if (req.url === "/hook") {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        hooks.push(JSON.parse(body))
        res.writeHead(204).end()
      })
      return
    }
    res.writeHead(200).end("Welcome")
  })
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve))
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => service.close(() => resolve())))

async function workspace(config?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "belltower-cli-"))
  const file = join(dir, "belltower.config.json")
  await writeFile(
    file,
    JSON.stringify(
      config ?? {
        $schema: "https://example.com/belltower.schema.json",
        components: [{ name: "Website" }],
        notifiers: [{ id: "chat", type: "webhook", secret: "HOOK_URL" }],
        checks: [
          { id: "home", type: "http", component: "Website", url: `${serviceUrl}/`, expectKeyword: "Welcome" },
          { id: "nightly", type: "heartbeat", component: "Website", period: "1h", token: "NIGHTLY_TOKEN", public: false },
        ],
      },
    ),
  )
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { HOOK_URL: `${serviceUrl}/hook`, NIGHTLY_TOKEN: "s3cret-t0ken" },
  }
  const run = (...args: string[]) => runCli(["--config", file, "--store", join(dir, "data"), "--regions", "us,eu", ...args], io)
  return { dir, file, out, err, io, run }
}

describe("belltower validate", () => {
  it("accepts a valid config, $schema included", async () => {
    const { run, out } = await workspace()
    expect(await run("validate")).toBe(0)
    expect(out).toEqual(["The config is valid: 2 checks across us, eu."])
  })

  it("exits 3 with each issue's path, message and fix", async () => {
    const { run, out } = await workspace({ components: [{ name: "Website" }], notifiers: [], checks: [{ id: "home", type: "http", component: "Website" }] })
    expect(await run("validate", "--json")).toBe(3)
    const parsed = JSON.parse(out[0] ?? "")
    expect(parsed).toMatchObject({ format: "belltower.cli/1", command: "validate", ok: false, exitCode: 3 })
    expect(parsed.errors).toContainEqual({ code: "required", path: "/checks/0/url", message: "is required: the http or https URL to request." })
  })

  it("exits 3 when the config file is missing, saying how to point at one", async () => {
    const { io } = await workspace()
    expect(await runCli(["validate", "--config", "/nowhere/belltower.config.json"], io)).toBe(3)
  })
})

describe("belltower run", () => {
  it("runs a region's checks and writes its results file", async () => {
    const { run, out, dir } = await workspace()
    expect(await run("run", "checks", "--region", "us")).toBe(0)
    expect(out[0]).toBe("us: 1 checks, 1 passed, 0 failed.")
    expect((await readdir(join(dir, "data/results"))).sort()).toEqual(["us"])
  })

  it("writes nothing on a dry run", async () => {
    const { run, dir } = await workspace()
    expect(await run("run", "checks", "--region", "us", "--dry-run")).toBe(0)
    await expect(readdir(join(dir, "data"))).rejects.toThrow()
  })

  it("decides from results and alerts through the webhook", async () => {
    const { run, out, dir } = await workspace()
    await recordFailures(join(dir, "data"))
    hooks.length = 0
    expect(await run("run", "decide")).toBe(0)
    expect(out.join("\n")).toContain("Opened home-")
    expect(hooks).toEqual([expect.objectContaining({ format: "belltower.alert/1", level: "alert", title: "Down: home (Website)" })])
  })

  it("shows the alerts a dry run would send, and sends none", async () => {
    const { run, out, dir } = await workspace()
    await recordFailures(join(dir, "data"))
    hooks.length = 0
    expect(await run("run", "decide", "--dry-run", "--json")).toBe(0)
    const parsed = JSON.parse(out[0] ?? "")
    expect(parsed.result.alerts).toEqual([expect.objectContaining({ title: "Down: home (Website)" })])
    expect(hooks).toEqual([])
    await expect(readdir(join(dir, "data/incidents"))).rejects.toThrow()
  })

  it("needs --region for run checks, and exits 2 without it", async () => {
    const { run, err } = await workspace()
    expect(await run("run", "checks")).toBe(2)
    expect(err[0]).toBe("run checks needs --region. Pass the region this run is for, such as --region us.")
  })

  it("exits 2 for an unknown command or flag", async () => {
    const { run } = await workspace()
    expect(await run("launch")).toBe(2)
    expect(await run("validate", "--colour")).toBe(2)
  })
})

/** Two failing minutes from both regions, ending at the last complete minute. */
async function recordFailures(storeDir: string) {
  const store = localFolderStore(storeDir)
  const last = Math.floor(Date.now() / 60_000) * 60_000 - 60_000
  for (const at of [last - 60_000, last]) {
    for (const region of ["us", "eu"]) {
      const minute = new Date(at)
      const results = [{ id: "home", ok: false, slow: false, failure: "status", message: "Got status 503, expected 2xx.", status: 503, timing: { totalMs: 5 } }]
      await store.put(resultsKey(region, minute), JSON.stringify({ format: RESULTS_FORMAT, region, startedAt: minute.toISOString(), finishedAt: minute.toISOString(), results }))
    }
  }
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe("email notifiers in the CLI", () => {
  const emailConfig = {
    components: [{ name: "Website" }],
    notifiers: [{ id: "ops", type: "email", to: ["ops@example.com"] }],
    checks: [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/" }],
  }

  it("stops with exit 3 and names the SMTP secrets when they aren't set", async () => {
    const { run, err } = await workspace(emailConfig)
    expect(await run("run", "decide")).toBe(3)
    expect(err[0]).toContain("/notifiers/0: Email notifiers need the secrets BELLTOWER_SMTP_URL and BELLTOWER_EMAIL_FROM")
  })

  it("never prints the SMTP URL's password", async () => {
    const { run, out, err, io } = await workspace(emailConfig)
    io.env.BELLTOWER_SMTP_URL = "smtp://user:hunter2-secret@127.0.0.1:1"
    io.env.BELLTOWER_EMAIL_FROM = "alerts@example.com"
    expect(await run("run", "decide")).toBe(0)
    expect([...out, ...err].join("\n")).not.toContain("hunter2-secret")
  })
})

describe("belltower serve", () => {
  it("records heartbeat pings and answers health checks, until stopped", async () => {
    const { file, dir, io, out } = await workspace()
    const port = await freePort()
    const controller = new AbortController()
    const done = runCli(["serve", "--config", file, "--store", join(dir, "data"), "--port", String(port), "--json"], io, controller.signal)
    await waitFor(() => out.length > 0)
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ event: "listening", port, schedule: false })

    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe("ok")
    const ping = await fetch(`http://127.0.0.1:${port}/hb/s3cret-t0ken`)
    expect([ping.status, await ping.text()]).toEqual([200, "Recorded a success for nightly."])
    expect((await fetch(`http://127.0.0.1:${port}/hb/wrong`)).status).toBe(404)

    controller.abort()
    expect(await done).toBe(0)
    expect(await localFolderStore(join(dir, "data")).list("heartbeats/")).toEqual(["heartbeats/nightly.json"])
  })
})

async function waitFor(condition: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { runHttpCheck, type HttpCheck } from "@belltower/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { nodeHttpClient } from "../src/index.ts"

let server: Server
let base = ""
const seen: { method: string | undefined; url: string | undefined; auth: string | undefined; body: string }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      const path = req.url ?? "/"
      if (path === "/ok") return res.end("hello")
      if (path === "/gzip") {
        res.setHeader("content-encoding", "gzip")
        return res.end(gzipSync("compressed hello"))
      }
      if (path === "/cookies") {
        res.setHeader("set-cookie", ["a=1", "b=2"])
        return res.end()
      }
      if (path === "/moved") return res.writeHead(301, { location: "/ok" }).end()
      if (path === "/see-other") return res.writeHead(303, { location: "/ok" }).end()
      if (path === "/loop") return res.writeHead(302, { location: "/loop" }).end()
      if (path === "/slow") return setTimeout(() => res.end("late"), 2000)
      res.writeHead(404).end("missing")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const client = nodeHttpClient()
const get = (path: string, init: RequestInit = {}) => client.fetch(new Request(`${base}${path}`, init), { verifyTls: true })

describe("nodeHttpClient", () => {
  it("returns the status and body, with DNS and connect times", async () => {
    const { response, timing } = await get("/ok")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello")
    expect(timing?.connectMs).toBeGreaterThanOrEqual(0)
    expect(timing?.dnsMs).toBeGreaterThanOrEqual(0)
    expect(timing?.tlsMs).toBeUndefined()
  })

  it("decompresses gzip", async () => {
    const { response } = await get("/gzip")
    expect(await response.text()).toBe("compressed hello")
    expect(response.headers.get("content-encoding")).toBeNull()
  })

  it("keeps repeated headers", async () => {
    const { response } = await get("/cookies")
    expect(response.headers.get("set-cookie")).toBe("a=1, b=2")
  })

  it("follows redirects when asked, and returns them when not", async () => {
    expect(await (await get("/moved")).response.text()).toBe("hello")
    const manual = await get("/moved", { redirect: "manual" })
    expect(manual.response.status).toBe(301)
    expect(manual.response.headers.get("location")).toBe("/ok")
  })

  it("turns a POST into a GET after a 303", async () => {
    seen.length = 0
    await get("/see-other", { method: "POST", body: "x=1" })
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ["POST", "/see-other", "x=1"],
      ["GET", "/ok", ""],
    ])
  })

  it("stops after 20 redirects", async () => {
    await expect(get("/loop")).rejects.toThrow("more than 20 redirects")
  })

  it("answers HEAD without a body", async () => {
    const { response } = await get("/ok", { method: "HEAD" })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
  })
})

describe("runHttpCheck with nodeHttpClient", () => {
  const check = (over: Partial<HttpCheck>): HttpCheck => ({
    id: "home",
    type: "http",
    component: "Website",
    url: `${base}/ok`,
    method: "GET",
    headers: {},
    expectStatus: [{ min: 200, max: 299 }],
    timeoutSeconds: 5,
    slowSeconds: 2,
    followRedirects: true,
    verifyTls: true,
    severity: "normal",
    public: true,
    ...over,
  })
  const deps = { http: client, secrets: { get: async () => "user:pass" }, clock: { now: () => new Date() } }

  it("passes against a real server and records the breakdown", async () => {
    const result = await runHttpCheck(check({ expectKeyword: "hello", basicAuth: "LOGIN" }), deps)
    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(result.timing.connectMs).toBeGreaterThanOrEqual(0)
    expect(seen.at(-1)?.auth).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`)
  })

  it("times out a slow response", async () => {
    const result = await runHttpCheck(check({ url: `${base}/slow`, timeoutSeconds: 0.2, slowSeconds: 0.1 }), deps)
    expect(result).toMatchObject({ ok: false, failure: "timeout" })
  })

  it("reports a refused connection as a network failure", async () => {
    const result = await runHttpCheck(check({ url: "http://127.0.0.1:1/" }), deps)
    expect(result).toMatchObject({ ok: false, failure: "network" })
  })
})

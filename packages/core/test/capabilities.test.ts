import { describe, expect, it } from "vitest"
import { assignChecks, type Region } from "../src/index.ts"

const node = (name: string): Region => ({ name, capabilities: { tlsInspector: true, inbox: false, sms: false } })
const workers = (name: string): Region => ({ name, capabilities: { tlsInspector: false, inbox: false, sms: false } })

describe("assignChecks", () => {
  it("runs HTTP checks in every region", () => {
    const result = assignChecks([{ id: "home", type: "http" }], [workers("us"), workers("eu")])
    expect(result).toEqual({ ok: true, byRegion: { us: ["home"], eu: ["home"] } })
  })

  it("sends a certificate check to the one region that can inspect TLS", () => {
    const result = assignChecks([{ id: "tls-www", type: "tls" }], [workers("us"), node("certs"), node("eu")])
    expect(result).toEqual({ ok: true, byRegion: { us: [], certs: ["tls-www"], eu: [] } })
  })

  it("refuses a certificate check no region can run, and says how to fix it", () => {
    const result = assignChecks([{ id: "tls-www", type: "tls" }], [workers("us"), workers("eu")])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain("Add a region on a Node adapter")
  })

  it("refuses an email check without an inbox", () => {
    const result = assignChecks([{ id: "mail", type: "email" }], [node("us")])
    expect(result.ok).toBe(false)
  })

  it("keeps a check to the regions it names", () => {
    const result = assignChecks([{ id: "home", type: "http", regions: ["eu"] }], [workers("us"), workers("eu")])
    expect(result).toEqual({ ok: true, byRegion: { us: [], eu: ["home"] } })
  })

  it("names regions in config that don't exist", () => {
    const result = assignChecks([{ id: "home", type: "http", regions: ["mars"] }], [workers("us")])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain("mars")
  })

  it("judges heartbeats in one region only", () => {
    const result = assignChecks([{ id: "nightly", type: "heartbeat" }], [workers("us"), workers("eu")])
    expect(result).toEqual({ ok: true, byRegion: { us: ["nightly"], eu: [] } })
  })
})

import { describe, expect, it } from "vitest"
import { emptyMetrics, median, recordMinute, responseFigures, type Histogram } from "../src/index.ts"

const at = (iso: string) => new Date(iso)

describe("response metrics", () => {
  it("gives a median within 1% of the exact one", () => {
    const values = [120, 130, 135, 150, 900, 95, 140]
    const m = recordMinute(emptyMetrics(), at("2026-11-15T10:00:00Z"), new Map([["API", values]]), new Map())
    const exact = 135
    const got = median(m.components.API?.hours["2026-11-15T10"] as Histogram)
    expect(Math.abs((got ?? 0) - exact) / exact).toBeLessThan(0.01)
    expect(median({})).toBeNull()
  })

  it("counts each minute once, and degraded minutes per day", () => {
    let m = emptyMetrics()
    m = recordMinute(m, at("2026-11-15T10:00:00Z"), new Map([["API", [100]]]), new Map([["API", "degraded" as const]]))
    m = recordMinute(m, at("2026-11-15T10:00:00Z"), new Map([["API", [100]]]), new Map([["API", "degraded" as const]]))
    m = recordMinute(m, at("2026-11-15T10:01:00Z"), new Map(), new Map([["API", "degraded" as const]]))
    m = recordMinute(m, at("2026-11-15T10:02:00Z"), new Map([["API", [100]]]), new Map())
    m = recordMinute(m, at("2026-11-15T10:03:00Z"), new Map(), new Map([["API", "partial" as const]]))
    m = recordMinute(m, at("2026-11-15T10:04:00Z"), new Map(), new Map([["API", "major" as const]]))
    expect(m.components.API?.days["2026-11-15"]).toMatchObject({ degradedMinutes: 2, partialMinutes: 1, majorMinutes: 1 })
    expect(Object.values(m.components.API?.days["2026-11-15"]?.response ?? {}).reduce((a, b) => a + b, 0)).toBe(2)
  })

  // Medians come from 2% buckets, so 200 reads as 202 and 250 as 251.
  it("settles days into a median after two days and forgets what's past the history", () => {
    let m = emptyMetrics()
    m = recordMinute(m, at("2026-08-01T10:00:00Z"), new Map([["API", [100]]]), new Map())
    m = recordMinute(m, at("2026-11-12T10:00:00Z"), new Map([["API", [200]]]), new Map())
    m = recordMinute(m, at("2026-11-15T10:00:00Z"), new Map([["API", [300]]]), new Map())
    const days = m.components.API?.days ?? {}
    expect(Object.keys(days)).toEqual(["2026-11-12", "2026-11-15"])
    expect(days["2026-11-12"]).toEqual({ degradedMinutes: 0, medianMs: 202 })
    expect(Object.keys(m.components.API?.hours ?? {})).toEqual(["2026-11-15T10"])
  })

  it("gives the last 24 whole hours and each day's figures", () => {
    let m = emptyMetrics()
    m = recordMinute(m, at("2026-11-15T09:30:00Z"), new Map([["API", [250]]]), new Map([["API", "degraded" as const]]))
    m = recordMinute(m, at("2026-11-15T10:05:00Z"), new Map([["API", [400]]]), new Map())
    const f = responseFigures(m, "API", at("2026-11-15T10:30:00Z"))
    expect(f.hours).toHaveLength(24)
    expect(f.hours.at(0)?.hour).toBe("2026-11-14T10:00Z")
    expect(f.hours.at(-1)).toEqual({ hour: "2026-11-15T09:00Z", responseMs: 251 })
    expect(f.days.get("2026-11-15")).toEqual({ responseMs: 251, degradedMinutes: 1, partialMinutes: 0, majorMinutes: 0 })
    expect(responseFigures(null, "API", at("2026-11-15T10:30:00Z")).hours.every((h) => h.responseMs === null)).toBe(true)
  })
})

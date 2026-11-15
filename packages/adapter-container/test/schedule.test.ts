import { afterEach, describe, expect, it, vi } from "vitest"
import { everyMinute } from "../src/index.ts"

afterEach(() => vi.useRealTimers())

describe("everyMinute", () => {
  it("runs at the top of each minute", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T10:00:40Z") })
    const runs: string[] = []
    const schedule = everyMinute(async (at) => void runs.push(at.toISOString()))
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(60_000)
    schedule.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runs).toEqual(["2026-11-15T10:01:00.000Z", "2026-11-15T10:02:00.000Z"])
  })

  it("waits out a timer that fires early, so the run gets its own minute", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T10:10:40Z") })
    const runs: string[] = []
    const skipped: string[] = []
    const schedule = everyMinute(async (at) => void runs.push(`${at.toISOString()} at ${new Date().toISOString()}`), (at) => skipped.push(at.toISOString()))
    // The wall clock runs 8 ms behind the timers, as seen on a real machine.
    vi.setSystemTime(new Date("2026-11-15T10:10:39.992Z"))
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(60_100)
    schedule.stop()
    expect(skipped).toEqual([])
    expect(runs).toEqual(["2026-11-15T10:11:00.000Z at 2026-11-15T10:11:00.000Z", "2026-11-15T10:12:00.000Z at 2026-11-15T10:12:00.000Z"])
  })

  it("skips a minute while the previous run is still going", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T10:00:59Z") })
    const skipped: string[] = []
    let finish = () => {}
    const schedule = everyMinute(
      () => new Promise<void>((resolve) => (finish = resolve)),
      (at) => skipped.push(at.toISOString()),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(60_000)
    finish()
    schedule.stop()
    expect(skipped).toEqual(["2026-11-15T10:02:00.000Z"])
  })
})

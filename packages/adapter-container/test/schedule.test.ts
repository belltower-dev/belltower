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

/*
 * Runs a task at the top of every minute, for single-machine deployments
 * where nothing else schedules Belltower. A tick that's still running when
 * the next minute starts makes that minute skip, so ticks never overlap.
 */

export interface Schedule {
  stop(): void
}

export function everyMinute(task: (at: Date) => Promise<void>, onSkip: (at: Date) => void = () => {}): Schedule {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let stopped = false

  const next = () => {
    if (stopped) return
    const now = Date.now()
    timer = setTimeout(tick, 60_000 - (now % 60_000))
  }
  const tick = () => {
    const at = new Date(Math.round(Date.now() / 60_000) * 60_000)
    next()
    if (running) return onSkip(at)
    running = true
    task(at).finally(() => (running = false))
  }

  next()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

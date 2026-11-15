/*
 * Runs a task at the top of every minute, for single-machine deployments
 * where nothing else schedules Belltower. A tick that's still running when
 * the next minute starts makes that minute skip, so ticks never overlap.
 *
 * Timers can fire a few milliseconds early. Each tick aims at a known
 * minute and waits again if it's early, so a run is never stamped with the
 * minute before the one it's for.
 */

export interface Schedule {
  stop(): void
}

const MINUTE = 60_000

export function everyMinute(task: (at: Date) => Promise<void>, onSkip: (at: Date) => void = () => {}): Schedule {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let stopped = false

  const arm = (target: number) => {
    if (stopped) return
    timer = setTimeout(() => fire(target), Math.max(0, target - Date.now()))
  }
  const fire = (target: number) => {
    if (Date.now() < target) return arm(target)
    arm(target + MINUTE)
    const at = new Date(target)
    if (running) return onSkip(at)
    running = true
    task(at).finally(() => (running = false))
  }

  arm(Math.floor(Date.now() / MINUTE) * MINUTE + MINUTE)
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

import type { Config, HeartbeatCheck } from "./config.ts"
import type { Clock, Secrets, Store } from "./ports.ts"

/*
 * Heartbeats (docs/spec.md, "Heartbeats"): handle() records pings at
 * /hb/{token} and /hb/{token}/fail, and judgeHeartbeat() decides from the
 * record whether the job is up, down or hasn't reported yet.
 */

export const HEARTBEAT_FORMAT = "belltower.heartbeat/1"

export interface HeartbeatRecord {
  format: typeof HEARTBEAT_FORMAT
  lastSuccess?: string
  lastFailure?: string
  /** The `run` query parameter of the last success, for the email round trip. */
  runId?: string
}

export function heartbeatKey(id: string): string {
  return `heartbeats/${id}.json`
}

export interface HandleDeps {
  config: Config
  store: Store
  secrets: Secrets
  clock: Clock
}

const PING = /\/hb\/([^/]+)(\/fail)?\/?$/

/** A standard fetch handler. Paths can sit under any prefix, so it can share a host. */
export async function handle(request: Request, deps: HandleDeps): Promise<Response> {
  const match = PING.exec(new URL(request.url).pathname)
  if (!match) return text(404, "Not found. Heartbeat URLs end in /hb/{token} or /hb/{token}/fail.")
  if (!["GET", "HEAD", "POST"].includes(request.method)) {
    return text(405, "Use GET, HEAD or POST to send a heartbeat.", { Allow: "GET, HEAD, POST" })
  }

  const token = decodeURIComponent(match[1] ?? "")
  const failed = match[2] !== undefined
  const check = await findByToken(token, deps)
  if (!check) return text(404, "No heartbeat has this token. Check the URL in the job's configuration against the secret Belltower reads.")

  const key = heartbeatKey(check.id)
  const existing = await deps.store.get(key)
  const record: HeartbeatRecord = existing ? (JSON.parse(existing) as HeartbeatRecord) : { format: HEARTBEAT_FORMAT }
  const now = deps.clock.now().toISOString()
  if (failed) {
    record.lastFailure = now
  } else {
    record.lastSuccess = now
    const runId = new URL(request.url).searchParams.get("run")
    if (runId) record.runId = runId.slice(0, 200)
    else delete record.runId
  }
  await deps.store.put(key, JSON.stringify(record), { contentType: "application/json" })
  return text(200, failed ? `Recorded a failure for ${check.id}.` : `Recorded a success for ${check.id}.`)
}

async function findByToken(token: string, deps: HandleDeps): Promise<HeartbeatCheck | null> {
  if (!token) return null
  const heartbeats = deps.config.checks.filter((c): c is HeartbeatCheck => c.type === "heartbeat")
  const secrets = await Promise.all(heartbeats.map((c) => deps.secrets.get(c.token)))
  // Compare against every token, so the time taken doesn't say which one nearly matched.
  let found: HeartbeatCheck | null = null
  heartbeats.forEach((check, i) => {
    const secret = secrets[i]
    if (secret && equal(secret, token) && !found) found = check
  })
  return found
}

/** Compares in time that depends only on the lengths. */
function equal(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } })
}

export type HeartbeatState = "pending" | "up" | "down"

export interface HeartbeatJudgement {
  state: HeartbeatState
  /** When it went down: the failure, or the moment the success became overdue. */
  since?: Date
  /** What happened, in words. */
  reason?: string
}

/** Down when no success arrives within period plus grace, or a failure is newer than the last success. */
export function judgeHeartbeat(check: HeartbeatCheck, record: HeartbeatRecord | null, now: Date): HeartbeatJudgement {
  const success = record?.lastSuccess ? new Date(record.lastSuccess) : null
  const failure = record?.lastFailure ? new Date(record.lastFailure) : null
  if (failure && (!success || failure > success)) {
    return { state: "down", since: failure, reason: `${check.id} reported a failure at ${hhmm(failure)}.` }
  }
  if (!success) return { state: "pending" }
  const due = new Date(success.getTime() + (check.period + check.grace) * 1000)
  if (now > due) {
    return { state: "down", since: due, reason: `${check.id} hasn't reported a success since ${hhmm(success)}. One was due by ${hhmm(due)}.` }
  }
  return { state: "up" }
}

function hhmm(d: Date): string {
  const iso = d.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

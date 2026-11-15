import type { Check, Config, HttpCheck } from "./config.ts"
import type { Clock, HttpClient, HttpTiming, Secrets, Store } from "./ports.ts"
import { VERSION } from "./version.ts"

/*
 * runChecks(region): runs the checks assigned to one region and writes one
 * results file (docs/spec.md, "What the platform calls" and "HTTP"). Only
 * HTTP checks run here so far; heartbeats are judged by decide(), and tls
 * and domain checks come in phase 3.
 */

export const RESULTS_FORMAT = "belltower.results/1"

/** Bytes of the response body kept on a failure. */
const BODY_KEPT = 2048

export type Failure =
  | "network" // the request errored before a response arrived
  | "timeout" // no complete response within timeoutSeconds
  | "status" // status outside expectStatus
  | "missing-keyword" // the body didn't contain expectKeyword
  | "rejected-keyword" // the body contained rejectKeyword
  | "secret" // a secret the check needs isn't set
  | "unsupported" // this region's HTTP client can't do what the check asks

export interface CheckResult {
  id: string
  ok: boolean
  /** Passed, but took longer than slowSeconds. */
  slow: boolean
  failure?: Failure
  /** What went wrong, in words. */
  message?: string
  status?: number
  timing: HttpTiming
  /** Response headers, kept on failure for the incident. */
  headers?: Record<string, string>
  /** The first 2 KB of the body, kept on failure for the incident. */
  bodyStart?: string
}

export interface ResultsFile {
  format: typeof RESULTS_FORMAT
  region: string
  startedAt: string
  finishedAt: string
  results: CheckResult[]
}

export interface RunDeps {
  config: Config
  /** From validateConfig: the check ids each region runs. */
  byRegion: Readonly<Record<string, readonly string[]>>
  store: Store
  secrets: Secrets
  clock: Clock
  /** Defaults to web-standard fetch. */
  http?: HttpClient
}

/** Runs one region's checks in parallel and writes `results/{region}/{yyyy}/{mm}/{dd}/{hh}{mm}.json`. */
export async function runChecks(region: string, deps: RunDeps): Promise<ResultsFile> {
  const ids = deps.byRegion[region]
  if (!ids) throw new Error(`Region "${region}" isn't one of the configured regions: ${Object.keys(deps.byRegion).join(", ")}.`)
  const wanted = new Set(ids)
  const checks = deps.config.checks.filter((c): c is HttpCheck => wanted.has(c.id) && runsHere(c))
  const http = deps.http ?? webHttpClient()

  const started = deps.clock.now()
  const results = await Promise.all(checks.map((check) => runHttpCheck(check, { ...deps, http })))
  const file: ResultsFile = {
    format: RESULTS_FORMAT,
    region,
    startedAt: started.toISOString(),
    finishedAt: deps.clock.now().toISOString(),
    results,
  }
  await deps.store.put(resultsKey(region, started), JSON.stringify(file), { contentType: "application/json" })
  return file
}

function runsHere(check: Check): check is HttpCheck {
  return check.type === "http"
}

/** `results/{region}/{yyyy}/{mm}/{dd}/{hh}{mm}.json`, in UTC. */
export function resultsKey(region: string, at: Date): string {
  const iso = at.toISOString()
  return `results/${region}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(11, 13)}${iso.slice(14, 16)}.json`
}

/** The HttpClient used when an adapter supplies none: web-standard fetch, which always verifies certificates. */
export function webHttpClient(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): HttpClient {
  return {
    async fetch(request, options) {
      if (!options.verifyTls) throw new UnsupportedError("verifyTls: false needs an adapter that can skip certificate verification.")
      return { response: await fetchImpl(request) }
    },
  }
}

class UnsupportedError extends Error {}

export async function runHttpCheck(check: HttpCheck, deps: { http: HttpClient; secrets: Secrets; clock: Clock }): Promise<CheckResult> {
  const start = deps.clock.now().getTime()
  const elapsed = () => deps.clock.now().getTime() - start
  const fail = (failure: Failure, message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
    id: check.id,
    ok: false,
    slow: false,
    failure,
    message,
    timing: { totalMs: elapsed() },
    ...extra,
  })

  const headers = new Headers({ "User-Agent": `Belltower/${VERSION}` })
  for (const [name, value] of Object.entries(check.headers)) headers.set(name, value)
  if (check.basicAuth) {
    const credentials = await deps.secrets.get(check.basicAuth)
    if (credentials === null) return fail("secret", `The secret "${check.basicAuth}" named in basicAuth isn't set. Set it, or remove basicAuth.`)
    headers.set("Authorization", `Basic ${base64(credentials)}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), check.timeoutSeconds * 1000)
  try {
    const request = new Request(check.url, {
      method: check.method,
      headers,
      redirect: check.followRedirects ? "follow" : "manual",
      signal: controller.signal,
      ...(check.body !== undefined ? { body: check.body } : {}),
    })
    const { response, timing: phases } = await deps.http.fetch(request, { verifyTls: check.verifyTls })
    const firstByteMs = elapsed()
    const body = await response.text()
    const totalMs = elapsed()
    const timing: HttpTiming = { ...phases, firstByteMs, downloadMs: totalMs - firstByteMs, totalMs }
    const details = { status: response.status, timing, headers: headerRecord(response.headers), bodyStart: truncate(body) }

    if (response.type === "opaqueredirect") {
      return fail("unsupported", "The response is a redirect this runtime won't show (followRedirects is false). Set followRedirects to true, or run the check on a server runtime.", { timing })
    }
    if (!check.expectStatus.some((r) => response.status >= r.min && response.status <= r.max)) {
      return fail("status", `Got status ${response.status}, expected ${describeStatus(check)}.`, details)
    }
    if (check.expectKeyword !== undefined && !body.includes(check.expectKeyword)) {
      return fail("missing-keyword", `The body doesn't contain "${check.expectKeyword}".`, details)
    }
    if (check.rejectKeyword !== undefined && body.includes(check.rejectKeyword)) {
      return fail("rejected-keyword", `The body contains "${check.rejectKeyword}", which it must not.`, details)
    }
    return { id: check.id, ok: true, slow: totalMs > check.slowSeconds * 1000, status: response.status, timing }
  } catch (error) {
    if (controller.signal.aborted) return fail("timeout", `No complete response within ${check.timeoutSeconds} seconds.`)
    if (error instanceof UnsupportedError) return fail("unsupported", error.message)
    return fail("network", `The request failed: ${error instanceof Error ? error.message : String(error)}.`)
  } finally {
    clearTimeout(timer)
  }
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => (out[name] = value))
  return out
}

function describeStatus(check: HttpCheck): string {
  return check.expectStatus
    .map((r) => (r.min === r.max ? String(r.min) : r.max - r.min === 99 ? `${r.min / 100}xx` : `${r.min}-${r.max}`))
    .join(", ")
}

/** The first 2 KB of the body, cut on a character boundary. */
function truncate(body: string): string {
  const bytes = new TextEncoder().encode(body)
  if (bytes.length <= BODY_KEPT) return body
  return new TextDecoder().decode(bytes.slice(0, BODY_KEPT)).replace(/�$/, "")
}

/** Base64 of UTF-8 text; btoa alone only takes Latin-1. */
function base64(text: string): string {
  let binary = ""
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

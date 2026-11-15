import { assignChecks, type CheckType, type Region } from "./capabilities.ts"
import type { AlertLevel } from "./ports.ts"

/*
 * The deployment's config (docs/spec.md, "Checks", "The rest of the config"
 * and "Validation"): checks, components, notifiers and thresholds.
 * `validateConfig` fills in defaults, names the field behind every error,
 * and assigns checks to regions.
 */

export type Severity = "normal" | "critical"

interface CheckBase {
  id: string
  component: string
  /** Regions named in config; every region when absent. */
  regions?: readonly string[]
  severity: Severity
  public: boolean
}

/** An inclusive range of HTTP status codes. */
export interface StatusRange {
  min: number
  max: number
}

export interface HttpCheck extends CheckBase {
  type: "http"
  url: string
  method: string
  headers: Readonly<Record<string, string>>
  body?: string
  /** Name of the secret holding `user:password`. */
  basicAuth?: string
  expectStatus: readonly StatusRange[]
  expectKeyword?: string
  rejectKeyword?: string
  timeoutSeconds: number
  slowSeconds: number
  followRedirects: boolean
  verifyTls: boolean
}

export interface HeartbeatCheck extends CheckBase {
  type: "heartbeat"
  /** Seconds between expected successes. */
  period: number
  /** Extra seconds before a missing success counts as down. */
  grace: number
  /** Name of the secret holding the ping URL's token. */
  token: string
}

export interface EmailCheck extends CheckBase {
  type: "email"
  /** The heartbeat check that carries the run ID. */
  heartbeat: string
  /** Seconds after that heartbeat by which the message must arrive. */
  within: number
}

export interface TlsCheck extends CheckBase {
  type: "tls"
  host: string
  port: number
  servername: string
  addresses: "first" | "all"
  /** Fraction of the lifetime left below which renewal is overdue. */
  renewWithin: number
  warnDays: number
  alertDays: number
  /** Seconds between inspections. */
  schedule: number
}

export interface DomainCheck extends CheckBase {
  type: "domain"
  domain: string
  warnDays: number
  alertDays: number
  /** Seconds between lookups. */
  schedule: number
}

export type Check = HttpCheck | HeartbeatCheck | EmailCheck | TlsCheck | DomainCheck

/** A service credit owed when monthly availability falls below a threshold. */
export interface CreditTier {
  /** Availability percentage the month must fall below, such as 99.9. */
  below: number
  /** Credit owed, as a percentage of the month's fee. */
  percent: number
}

export interface Component {
  name: string
  /** Down alerts for any check in this component also go by SMS. */
  critical: boolean
  /** Monthly availability target, as a percentage, such as 99.9. */
  target?: number
  /** Credit tiers, highest threshold first. */
  credits: readonly CreditTier[]
}

interface NotifierBase {
  id: string
  levels: readonly AlertLevel[]
}

export type NotifierConfig =
  | (NotifierBase & { type: "email"; to: readonly string[] })
  | (NotifierBase & { type: "sms"; to: readonly string[] })
  | (NotifierBase & { type: "webhook"; /** Name of the secret holding the URL. */ secret: string })

export interface Thresholds {
  /** Regions that must fail the same check for it to count as down. */
  confirmRegions: number
  /** Consecutive failing minutes before it counts as down. */
  confirmMinutes: number
  /** Consecutive slow minutes before it counts as degraded. */
  degradedMinutes: number
  /** Regions that must pass for it to count as recovered. */
  recoverRegions: number
  /** Consecutive passing minutes before it counts as recovered. */
  recoverMinutes: number
  /** Minutes between repeats of an unacknowledged down alert. */
  repeatAlertMinutes: number
}

export interface Config {
  components: readonly Component[]
  checks: readonly Check[]
  notifiers: readonly NotifierConfig[]
  thresholds: Thresholds
}

/** Stable codes for config problems, for agents and scripts. */
export type IssueCode =
  | "required" // a required field is missing
  | "invalid" // a value of the wrong kind, format or range
  | "empty" // a list that needs at least one entry
  | "unknown-field" // a field this object doesn't have
  | "duplicate" // an id or name used twice
  | "unknown-reference" // a reference to a component or check that doesn't exist
  | "conflict" // two fields that can't be used together
  | "missing-capability" // no region can do what the config asks
  | "no-regions" // the adapter declared no regions

export interface ConfigIssue {
  code: IssueCode
  /** JSON pointer to the field, such as /checks/0/timeoutSeconds; "" for the whole config. */
  path: string
  /** What's wrong. */
  message: string
  /** What to do about it, when the message doesn't already say. */
  fix?: string
}

export type ConfigResult =
  | { ok: true; config: Config; byRegion: Record<string, string[]> }
  | { ok: false; /** One line per issue, for people. */ errors: string[]; issues: ConfigIssue[] }

/** Collects issues with both a JSON pointer and a readable location. */
class Issues {
  readonly items: { issue: ConfigIssue; where: string }[] = []

  add(where: string, path: string, code: IssueCode, message: string, fix?: string) {
    this.items.push({ issue: { code, path, message, ...(fix !== undefined ? { fix } : {}) }, where })
  }

  get length(): number {
    return this.items.length
  }

  failure(): { ok: false; errors: string[]; issues: ConfigIssue[] } {
    return {
      ok: false,
      errors: this.items.map(({ issue, where }) => `${where ? `${where}: ` : ""}${issue.message}${issue.fix ? ` ${issue.fix}` : ""}`),
      issues: this.items.map((i) => i.issue),
    }
  }
}

/** Where each parsed entry sat in its list, for JSON pointers. */
const positions = new WeakMap<object, number>()

function pointer(...parts: (string | number)[]): string {
  return parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("")
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  confirmRegions: 2,
  confirmMinutes: 2,
  degradedMinutes: 5,
  recoverRegions: 2,
  recoverMinutes: 3,
  repeatAlertMinutes: 30,
}

const CHECK_TYPES: readonly CheckType[] = ["http", "heartbeat", "email", "tls", "domain"]
const ALERT_LEVELS: readonly AlertLevel[] = ["info", "warn", "alert", "critical"]
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
const ID = /^[a-z0-9][a-z0-9_-]*$/
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i
const PHONE = /^\+[1-9][0-9]{6,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DURATION = /^([0-9]+)(s|m|h|d)$/
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const

/** Validates a parsed config against the regions the adapter declares. */
export function validateConfig(input: unknown, regions: readonly Region[]): ConfigResult {
  const issues = new Issues()
  if (!regions.length) issues.add("", "", "no-regions", "No regions are declared.", "The adapter must supply at least one region.")

  if (!isRecord(input)) {
    issues.add("", "", "invalid", "The config must be an object with components, checks and notifiers.")
    return issues.failure()
  }
  // $schema lets editors and agents validate the file as they write it.
  const root = new Fields(input, "", "", issues, ["$schema", "components", "checks", "notifiers", "thresholds"])

  const components = list(root, "components", "add at least one component.", (f) => readComponent(f))
  const notifiers = list(root, "notifiers", "add at least one notifier, or no alert can be sent.", (f) => readNotifier(f))
  const checks = list(root, "checks", "add at least one check.", (f) => readCheck(f))
  const thresholds = readThresholds(root)
  root.finish()

  unique(components, (c) => c.name, "components", "name", issues)
  unique(notifiers, (n) => n.id, "notifiers", "id", issues)
  unique(checks, (c) => c.id, "checks", "id", issues)

  const at = (check: Check, field: string) => pointer("checks", positions.get(check) ?? 0, field)
  const componentNames = new Set(components.map((c) => c.name))
  const byId = new Map(checks.map((c) => [c.id, c]))
  for (const check of checks) {
    if (!componentNames.has(check.component)) {
      issues.add(`${label(check)}.component`, at(check, "component"), "unknown-reference", `"${check.component}" isn't in components.`, `Add it there, or use one of: ${[...componentNames].join(", ") || "(none)"}.`)
    }
    if (check.type === "email") {
      const hb = byId.get(check.heartbeat)
      if (!hb) issues.add(`${label(check)}.heartbeat`, at(check, "heartbeat"), "unknown-reference", `no check has the id "${check.heartbeat}".`, "Name the heartbeat check that carries the run ID.")
      else if (hb.type !== "heartbeat") issues.add(`${label(check)}.heartbeat`, at(check, "heartbeat"), "invalid", `"${check.heartbeat}" is a ${hb.type} check.`, "Name a heartbeat check.")
    }
  }

  const hasSms = notifiers.some((n) => n.type === "sms")
  if (hasSms && regions.length && !regions.some((r) => r.capabilities.sms)) {
    const index = notifiers.findIndex((n) => n.type === "sms")
    issues.add("notifiers", pointer("notifiers", positions.get(notifiers[index] ?? {}) ?? index, "type"), "missing-capability", "an sms notifier is configured, but no region's adapter can send SMS.", "Run decide() on an adapter that can (aws), or remove the sms notifier.")
  }
  if (!hasSms && notifiers.length) {
    for (const check of checks) {
      if (check.severity === "critical") {
        issues.add(`${label(check)}.severity`, at(check, "severity"), "conflict", "critical checks also alert by SMS, and no sms notifier is configured.", 'Add an sms notifier, or set severity to "normal".')
      }
    }
    for (const component of components) {
      if (component.critical) {
        issues.add(`components (${component.name}).critical`, pointer("components", positions.get(component) ?? 0, "critical"), "conflict", "critical components also alert by SMS, and no sms notifier is configured.", "Add an sms notifier, or set critical to false.")
      }
    }
  }

  if (issues.length) return issues.failure()

  const refs = checks.map((c) => (c.type === "http" && !c.verifyTls ? { ...c, needs: ["skipTlsVerify" as const] } : c))
  const assignment = assignChecks(refs, regions)
  if (!assignment.ok) {
    for (const e of assignment.errors) {
      const check = byId.get(e.check)
      issues.add("", check ? at(check, e.field) : "", e.code, e.message, e.fix)
    }
    return issues.failure()
  }
  return { ok: true, config: { components, checks, notifiers, thresholds }, byRegion: assignment.byRegion }
}

function readComponent(f: Fields): Component | null {
  const name = f.string("name", { required: true })
  const critical = f.boolean("critical", false)
  const target = f.has("target") ? f.percentage("target") : undefined
  const credits = readCredits(f)
  f.finish()
  return name === undefined ? null : { name, critical, credits, ...(target !== undefined ? { target } : {}) }
}

function readCredits(f: Fields): CreditTier[] {
  const raw = f.raw("credits")
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    f.error("credits", "invalid", "must be a list of tiers such as { \"below\": 99.9, \"percent\": 10 }.")
    return []
  }
  const tiers: CreditTier[] = []
  raw.forEach((item: unknown, i) => {
    const below = isRecord(item) ? item.below : undefined
    const percent = isRecord(item) ? item.percent : undefined
    const ok = (n: unknown): n is number => typeof n === "number" && n > 0 && n <= 100
    if (!isRecord(item) || !ok(below) || !ok(percent) || Object.keys(item).some((k) => k !== "below" && k !== "percent")) {
      f.error("credits", "invalid", `must be { "below": <availability percent>, "percent": <credit percent> }, both above 0 and at most 100, got ${show(item)}.`, undefined, i)
      return
    }
    tiers.push({ below, percent })
  })
  const thresholds = tiers.map((t) => t.below)
  if (new Set(thresholds).size !== thresholds.length) f.error("credits", "duplicate", "two tiers have the same below value.", "Give each tier its own threshold.")
  return tiers.sort((a, b) => b.below - a.below)
}

function readNotifier(f: Fields): NotifierConfig | null {
  const id = f.id()
  const type = f.oneOf("type", ["email", "sms", "webhook"] as const, { required: true })
  if (type === undefined) return null
  const defaultLevels: readonly AlertLevel[] = type === "sms" ? ["critical"] : ["warn", "alert", "critical"]
  const levels = f.stringList("levels", { allowed: ALERT_LEVELS }) ?? defaultLevels
  let result: NotifierConfig | null = null
  if (type === "webhook") {
    const secret = f.string("secret", { required: true, hint: "the name of the secret holding the webhook URL" })
    if (id !== undefined && secret !== undefined) result = { id, type, levels, secret }
  } else {
    const pattern = type === "email" ? EMAIL : PHONE
    const what = type === "email" ? "an email address" : "a phone number in international format, such as +15555550100"
    const to = f.stringList("to", { required: true, pattern, what })
    if (to && !to.length) f.error("to", "empty", "add at least one recipient.")
    if (id !== undefined && to?.length) result = { id, type, levels, to }
  }
  f.finish()
  return result
}

function readThresholds(root: Fields): Thresholds {
  const raw = root.raw("thresholds")
  if (raw === undefined) return DEFAULT_THRESHOLDS
  if (!isRecord(raw)) {
    root.error("thresholds", "invalid", "must be an object.")
    return DEFAULT_THRESHOLDS
  }
  const f = new Fields(raw, "thresholds", pointer("thresholds"), root.issues, Object.keys(DEFAULT_THRESHOLDS))
  const t = { ...DEFAULT_THRESHOLDS }
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    t[key] = f.integer(key, DEFAULT_THRESHOLDS[key], { min: 1 })
  }
  f.finish()
  return t
}

function readCheck(f: Fields): Check | null {
  const id = f.id()
  const type = f.oneOf("type", CHECK_TYPES, { required: true })
  const component = f.string("component", { required: true })
  const regions = f.stringList("regions")
  if (regions && !regions.length) f.error("regions", "empty", "add at least one region, or leave regions out to run in every region.")
  const severity = f.oneOf("severity", ["normal", "critical"] as const) ?? "normal"
  const isPublic = f.boolean("public", true)
  if (type === undefined) {
    f.finish({ skipUnknown: true })
    return null
  }

  const base = { severity, public: isPublic, ...(regions?.length ? { regions: [...new Set(regions)] } : {}) }
  let check: Check | null = null
  switch (type) {
    case "http":
      check = readHttp(f, base)
      break
    case "heartbeat": {
      const period = f.duration("period", undefined, { required: true })
      const grace = f.duration("grace", 300)
      const token = f.string("token", { required: true, hint: "the name of the secret holding the ping URL's token" })
      if (period !== undefined && token !== undefined) check = { ...base, type, id: "", component: "", period, grace, token }
      break
    }
    case "email": {
      const heartbeat = f.string("heartbeat", { required: true, hint: "the id of the heartbeat check that carries the run ID" })
      const within = f.duration("within", 1800)
      if (heartbeat !== undefined) check = { ...base, type, id: "", component: "", heartbeat, within }
      break
    }
    case "tls": {
      const host = f.host("host")
      const port = f.integer("port", 443, { min: 1, max: 65535 })
      // Without a valid host there's no default to fall back on; host already has its error.
      const servername = host !== undefined || f.has("servername") ? f.host("servername", host) : (f.raw("servername"), undefined)
      const addresses = f.oneOf("addresses", ["first", "all"] as const) ?? "first"
      const renewWithin = f.fraction("renewWithin", 1 / 3)
      const { warnDays, alertDays } = expiryDays(f, 14, 7)
      const schedule = f.duration("schedule", 86400)
      if (host !== undefined && servername !== undefined) {
        check = { ...base, type, id: "", component: "", host, port, servername, addresses, renewWithin, warnDays, alertDays, schedule }
      }
      break
    }
    case "domain": {
      const domain = f.host("domain")
      const { warnDays, alertDays } = expiryDays(f, 30, 14)
      const schedule = f.duration("schedule", 86400)
      if (domain !== undefined) check = { ...base, type, id: "", component: "", domain, warnDays, alertDays, schedule }
      break
    }
  }
  f.finish()
  if (!check || id === undefined || component === undefined) return null
  check.id = id
  check.component = component
  return check
}

function readHttp(f: Fields, base: Pick<CheckBase, "severity" | "public" | "regions">): HttpCheck | null {
  const url = f.url("url")
  const method = f.oneOf("method", METHODS, { transform: (s) => s.toUpperCase() }) ?? "GET"
  const headers = f.stringRecord("headers")
  const body = f.string("body")
  if (body !== undefined && (method === "GET" || method === "HEAD")) f.error("body", "conflict", `a ${method} request can't have a body.`, "Remove body, or set method to POST.")
  const basicAuth = f.string("basicAuth", { hint: "the name of the secret holding user:password" })
  const expectStatus = f.statusRanges("expectStatus")
  const expectKeyword = f.string("expectKeyword")
  const rejectKeyword = f.string("rejectKeyword")
  if (method === "HEAD") {
    for (const key of ["expectKeyword", "rejectKeyword"] as const) {
      if (f.has(key)) f.error(key, "conflict", "a HEAD response has no body to search.", "Set method to GET, or remove the keyword.")
    }
  }
  const timeoutSeconds = f.number("timeoutSeconds", 10, { above: 0 })
  const slowSeconds = f.number("slowSeconds", 5, { above: 0 })
  if (slowSeconds >= timeoutSeconds) {
    f.error("slowSeconds", "conflict", `must be less than timeoutSeconds (${timeoutSeconds}), or a slow response would time out before it counts as slow.`)
  }
  const followRedirects = f.boolean("followRedirects", true)
  const verifyTls = f.boolean("verifyTls", true)
  if (url === undefined) return null
  return {
    ...base,
    type: "http",
    id: "",
    component: "",
    url,
    method,
    headers,
    expectStatus,
    timeoutSeconds,
    slowSeconds,
    followRedirects,
    verifyTls,
    ...(body !== undefined ? { body } : {}),
    ...(basicAuth !== undefined ? { basicAuth } : {}),
    ...(expectKeyword !== undefined ? { expectKeyword } : {}),
    ...(rejectKeyword !== undefined ? { rejectKeyword } : {}),
  }
}

function expiryDays(f: Fields, warnDefault: number, alertDefault: number) {
  const warnDays = f.integer("warnDays", warnDefault, { min: 1 })
  const alertDays = f.integer("alertDays", alertDefault, { min: 1 })
  if (alertDays > warnDays) f.error("alertDays", "conflict", `must not be more than warnDays (${warnDays}), or the warning would come after the alert.`)
  return { warnDays, alertDays }
}

function list<T extends object>(root: Fields, key: string, empty: string, read: (f: Fields) => T | null): T[] {
  const raw = root.raw(key)
  if (raw === undefined) {
    root.error(key, "required", "is required.")
    return []
  }
  if (!Array.isArray(raw)) {
    root.error(key, "invalid", "must be a list.")
    return []
  }
  if (!raw.length) root.error(key, "empty", empty)
  const out: T[] = []
  raw.forEach((item: unknown, i) => {
    const name = isRecord(item) && typeof (item.id ?? item.name) === "string" ? ` (${String(item.id ?? item.name)})` : ""
    const path = `${key}[${i}]${name}`
    if (!isRecord(item)) {
      root.issues.add(path, pointer(key, i), "invalid", "must be an object.")
      return
    }
    const value = read(new Fields(item, path, pointer(key, i), root.issues))
    if (value !== null) {
      positions.set(value, i)
      out.push(value)
    }
  })
  return out
}

function unique<T extends object>(items: readonly T[], key: (t: T) => string, section: string, field: string, issues: Issues) {
  const seen = new Set<string>()
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) issues.add(section, pointer(section, positions.get(item) ?? 0, field), "duplicate", `two entries have the ${field} "${k}".`, `Each ${field} must be unique.`)
    seen.add(k)
  }
}

function label(check: Check): string {
  return `checks (${check.id})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value) ?? String(value)
}

/** Reads one object's fields, recording an error that names each bad one. */
class Fields {
  private readonly read = new Set<string>()

  private readonly obj: Record<string, unknown>
  /** Readable location, such as checks[0] (home). */
  private readonly where: string
  /** JSON pointer to this object. */
  private readonly at: string
  readonly issues: Issues
  /** Keys accepted beyond those read, for typo suggestions. */
  private readonly known: readonly string[]

  constructor(obj: Record<string, unknown>, where: string, at: string, issues: Issues, known: readonly string[] = []) {
    this.obj = obj
    this.where = where
    this.at = at
    this.issues = issues
    this.known = known
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined
  }

  raw(key: string): unknown {
    this.read.add(key)
    return this.obj[key]
  }

  error(key: string, code: IssueCode, message: string, fix?: string, index?: number) {
    const name = index === undefined ? key : `${key}[${index}]`
    const path = index === undefined ? `${this.at}${pointer(key)}` : `${this.at}${pointer(key, index)}`
    this.issues.add(`${this.where ? `${this.where}.` : ""}${name}`, path, code, message, fix)
  }

  private missing(key: string, hint?: string) {
    this.error(key, "required", hint ? `is required: ${hint}.` : "is required.")
  }

  id(): string | undefined {
    const value = this.string("id", { required: true })
    if (value !== undefined && !ID.test(value)) {
      this.error("id", "invalid", `${show(value)} must use lowercase letters, digits, "-" and "_", starting with a letter or digit. It appears in storage keys and URLs.`)
      return undefined
    }
    return value
  }

  string(key: string, opts: { required?: boolean; hint?: string } = {}): string | undefined {
    const value = this.raw(key)
    if (value === undefined) {
      if (opts.required) this.missing(key, opts.hint)
      return undefined
    }
    if (typeof value !== "string" || value === "") {
      this.error(key, "invalid", `must be a non-empty string${opts.hint ? ` (${opts.hint})` : ""}, got ${show(value)}.`)
      return undefined
    }
    return value
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], opts: { required?: boolean; transform?: (s: string) => string } = {}): T | undefined {
    const value = this.raw(key)
    if (value === undefined) {
      if (opts.required) this.error(key, "required", `is required: one of ${allowed.join(", ")}.`)
      return undefined
    }
    const s = typeof value === "string" && opts.transform ? opts.transform(value) : value
    if (typeof s === "string" && (allowed as readonly string[]).includes(s)) return s as T
    this.error(key, "invalid", `must be one of ${allowed.join(", ")}, got ${show(value)}.`)
    return undefined
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.raw(key)
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    this.error(key, "invalid", `must be true or false, got ${show(value)}.`)
    return fallback
  }

  number(key: string, fallback: number, opts: { above: number }): number {
    const value = this.raw(key)
    if (value === undefined) return fallback
    if (typeof value === "number" && Number.isFinite(value) && value > opts.above) return value
    this.error(key, "invalid", `must be a number above ${opts.above}, got ${show(value)}.`)
    return fallback
  }

  integer(key: string, fallback: number, opts: { min: number; max?: number }): number {
    const value = this.raw(key)
    if (value === undefined) return fallback
    if (typeof value === "number" && Number.isInteger(value) && value >= opts.min && (opts.max === undefined || value <= opts.max)) return value
    const range = opts.max === undefined ? `${opts.min} or more` : `from ${opts.min} to ${opts.max}`
    this.error(key, "invalid", `must be a whole number ${range}, got ${show(value)}.`)
    return fallback
  }

  /** A percentage above 0 and at most 100. */
  percentage(key: string): number | undefined {
    const value = this.raw(key)
    if (typeof value === "number" && value > 0 && value <= 100) return value
    this.error(key, "invalid", `must be a percentage above 0 and at most 100, such as 99.9, got ${show(value)}.`)
    return undefined
  }

  /** A fraction between 0 and 1, written as a number or as "1/3". */
  fraction(key: string, fallback: number): number {
    const value = this.raw(key)
    if (value === undefined) return fallback
    let n = Number.NaN
    if (typeof value === "number") n = value
    else if (typeof value === "string") {
      const m = /^([0-9]+)\/([0-9]+)$/.exec(value)
      if (m) n = Number(m[1]) / Number(m[2])
    }
    if (n > 0 && n < 1) return n
    this.error(key, "invalid", `must be a fraction between 0 and 1, such as 0.33 or "1/3", got ${show(value)}.`)
    return fallback
  }

  /** Seconds, written as a number of seconds or as "30s", "15m", "1h", "1d", "daily" or "hourly". */
  duration(key: string, fallback: number, opts?: { required?: false }): number
  duration(key: string, fallback: undefined, opts: { required: true }): number | undefined
  duration(key: string, fallback: number | undefined, opts: { required?: boolean } = {}): number | undefined {
    const value = this.raw(key)
    if (value === undefined) {
      if (opts.required) this.missing(key, 'a duration such as "15m", "1h" or "1d"')
      return fallback
    }
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
    if (value === "daily") return 86400
    if (value === "hourly") return 3600
    const m = typeof value === "string" ? DURATION.exec(value) : null
    if (m && Number(m[1]) > 0) return Number(m[1]) * UNIT_SECONDS[m[2] as keyof typeof UNIT_SECONDS]
    this.error(key, "invalid", `must be a duration such as "30s", "15m", "1h" or "1d", or a whole number of seconds, got ${show(value)}.`)
    return fallback
  }

  host(key: string, fallback?: string): string | undefined {
    const value = this.raw(key)
    if (value === undefined) {
      if (fallback === undefined) this.missing(key, "a host name such as www.example.com")
      return fallback
    }
    if (typeof value === "string" && HOST.test(value)) return value.toLowerCase()
    this.error(key, "invalid", `must be a host name such as www.example.com, without a scheme or path, got ${show(value)}.`)
    return undefined
  }

  url(key: string): string | undefined {
    const value = this.string(key, { required: true, hint: "the http or https URL to request" })
    if (value === undefined) return undefined
    let parsed: URL | null = null
    try {
      parsed = new URL(value)
    } catch {
      parsed = null
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      this.error(key, "invalid", `must be an http or https URL, got ${show(value)}.`)
      return undefined
    }
    return value
  }

  stringList<T extends string = string>(key: string, opts: { required?: boolean; allowed?: readonly T[]; pattern?: RegExp; what?: string } = {}): T[] | undefined {
    const value = this.raw(key)
    if (value === undefined) {
      if (opts.required) this.missing(key)
      return undefined
    }
    if (!Array.isArray(value)) {
      this.error(key, "invalid", `must be a list, got ${show(value)}.`)
      return undefined
    }
    const out: T[] = []
    const allowed: readonly string[] | undefined = opts.allowed
    value.forEach((item: unknown, i) => {
      const ok =
        typeof item === "string" &&
        item !== "" &&
        (!allowed || allowed.includes(item)) &&
        (!opts.pattern || opts.pattern.test(item))
      if (ok) out.push(item as T)
      else if (opts.allowed) this.error(key, "invalid", `must be one of ${opts.allowed.join(", ")}, got ${show(item)}.`, undefined, i)
      else this.error(key, "invalid", `must be ${opts.what ?? "a non-empty string"}, got ${show(item)}.`, undefined, i)
    })
    return out.length === value.length ? out : undefined
  }

  stringRecord(key: string): Record<string, string> {
    const value = this.raw(key)
    if (value === undefined) return {}
    if (!isRecord(value) || !Object.values(value).every((v) => typeof v === "string")) {
      this.error(key, "invalid", `must be an object of header names to string values, got ${show(value)}.`)
      return {}
    }
    return value as Record<string, string>
  }

  /** Status codes and classes: 204, "2xx", or a list of them. Default 2xx. */
  statusRanges(key: string): StatusRange[] {
    const value = this.raw(key)
    if (value === undefined) return [{ min: 200, max: 299 }]
    const items: unknown[] = Array.isArray(value) ? value : [value]
    const out: StatusRange[] = []
    for (const item of items) {
      if (typeof item === "number" && Number.isInteger(item) && item >= 100 && item <= 599) out.push({ min: item, max: item })
      else if (typeof item === "string" && /^[1-5]xx$/.test(item)) {
        const base = Number(item[0]) * 100
        out.push({ min: base, max: base + 99 })
      } else {
        this.error(key, "invalid", `must be status codes from 100 to 599 or classes such as "2xx", got ${show(item)}.`)
        return [{ min: 200, max: 299 }]
      }
    }
    if (!out.length) this.error(key, "empty", 'add at least one status code or class, or leave it out to accept any 2xx.')
    return out.length ? out : [{ min: 200, max: 299 }]
  }

  /** Reports keys that weren't read, suggesting the closest known one. */
  finish(opts: { skipUnknown?: boolean } = {}) {
    if (opts.skipUnknown) return
    const known = [...this.read, ...this.known]
    for (const key of Object.keys(this.obj)) {
      if (this.read.has(key) || this.known.includes(key)) continue
      const near = known.find((k) => distance(k.toLowerCase(), key.toLowerCase()) <= 2)
      this.error(key, "unknown-field", "isn't a known field.", near ? `Did you mean ${near}?` : undefined)
    }
  }
}

/** Edit distance, for typo suggestions. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length] ?? 0
}

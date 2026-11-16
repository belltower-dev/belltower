import { describe, expect, it } from "vitest"
import historySchema from "../schemas/history.schema.json" with { type: "json" }
import reportSchema from "../schemas/report.schema.json" with { type: "json" }
import statusSchema from "../schemas/status.schema.json" with { type: "json" }
import { buildHistory, buildReport, publicStatus, validateConfig, type Config } from "../src/index.ts"

/*
 * Checks real output against the published schemas, with a small checker
 * covering the keywords the schemas use, so the core needs no validator.
 */
type Schema = Record<string, unknown>

function check(value: unknown, schema: Schema, root: Schema, path = ""): string[] {
  if (typeof schema.$ref === "string") {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce<unknown>((s, k) => (s as Schema)[k], root)
    return check(value, target as Schema, root, path)
  }
  const errors: string[] = []
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v)
  if (schema.type !== undefined) {
    const types = ([] as string[]).concat(schema.type as string)
    const actual = typeOf(value)
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) return [`${path}: ${actual} isn't ${types.join(" or ")}`]
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path}: isn't ${String(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: ${String(value)} isn't one of ${schema.enum.join(", ")}`)
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: doesn't match ${schema.pattern}`)
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`)
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.items) value.forEach((v, i) => errors.push(...check(v, schema.items as Schema, root, `${path}/${i}`)))
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Schema>
    for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) errors.push(`${path}: missing ${key}`)
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) errors.push(...check(v, props[key], root, `${path}/${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}: ${key} isn't in the schema`)
    }
  }
  return errors
}

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }
function config(): Config {
  const result = validateConfig(
    {
      components: [{ name: "Website", target: 99.9, credits: [{ below: 99.9, percent: 10 }] }, { name: "API" }],
      notifiers: [{ id: "ops", type: "webhook", secret: "HOOK" }],
      checks: [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/" }],
    },
    [{ name: "us", capabilities: caps }],
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  return result.config
}

const incident = {
  format: "belltower.incident/1" as const,
  id: "home-202611151000",
  key: "home",
  priority: "P3" as const,
  components: ["Website"],
  checks: { home: { component: "Website", spans: [{ start: "2026-11-15T10:00:00.000Z" }], summary: "home has failed in us since 10:00 UTC.", regions: ["us"], firstFailures: {} } },
  startedAt: "2026-11-15T10:00:00.000Z",
  detectedAt: "2026-11-15T10:02:30.000Z",
}
const now = new Date("2026-11-15T12:00:00Z")
const since = new Date("2026-10-01T00:00:00Z")

describe("published schemas", () => {
  it("describe public/status.json", () => {
    const status = publicStatus(config(), { home: "down" }, [incident], now)
    expect(check(status, statusSchema as Schema, statusSchema as Schema)).toEqual([])
  })

  it("describe public/history.json", () => {
    const history = buildHistory(config(), [incident], [], since, now)
    expect(check(history, historySchema as Schema, historySchema as Schema)).toEqual([])
  })

  it("describe the monthly report", () => {
    const report = buildReport(config(), [incident], [], Date.parse("2026-11-01T00:00:00Z"), since, now)
    expect(check(report, reportSchema as Schema, reportSchema as Schema)).toEqual([])
  })

  it("catch a field the code adds without updating the schema", () => {
    const status = { ...publicStatus(config(), {}, [], now), secretToken: "x" }
    expect(check(status, statusSchema as Schema, statusSchema as Schema)).toEqual([": secretToken isn't in the schema"])
  })
})

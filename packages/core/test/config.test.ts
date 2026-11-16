import { describe, expect, it } from "vitest"
import { DEFAULT_THRESHOLDS, validateConfig, type Region } from "../src/index.ts"

const none = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }
const node = (name: string, sms = false): Region => ({ name, capabilities: { ...none, tlsInspector: true, skipTlsVerify: true, sms } })
const workers = (name: string): Region => ({ name, capabilities: none })
const regions = [node("us", true), node("eu")]

const base = () => ({
  components: [{ name: "Website" }, { name: "API" }],
  notifiers: [{ id: "ops", type: "email", to: ["ops@example.com"] }],
  checks: [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/" }] as Record<string, unknown>[],
})

function errorsFor(input: unknown, rs: readonly Region[] = regions): string[] {
  const result = validateConfig(input, rs)
  if (result.ok) throw new Error("expected the config to be refused")
  return result.errors
}

describe("validateConfig", () => {
  it("fills in the spec's defaults for an HTTP check", () => {
    const result = validateConfig(base(), regions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.checks[0]).toEqual({
      id: "home",
      type: "http",
      component: "Website",
      url: "https://www.example.com/",
      method: "GET",
      headers: {},
      expectStatus: [{ min: 200, max: 299 }],
      timeoutSeconds: 10,
      slowSeconds: 5,
      followRedirects: true,
      verifyTls: true,
      priority: "P3",
      public: true,
    })
    expect(result.config.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(result.config.components[0]).toEqual({ name: "Website", credits: [] })
    expect(result.config.notifiers[0]).toEqual({ id: "ops", type: "email", to: ["ops@example.com"], upTo: "P4" })
    expect(result.byRegion).toEqual({ us: ["home"], eu: ["home"] })
  })

  it("fills in heartbeat, email, tls and domain defaults", () => {
    const config = base()
    config.checks = [
      { id: "nightly", type: "heartbeat", component: "API", period: "1d", token: "NIGHTLY_TOKEN", public: false },
      { id: "mail", type: "email", component: "API", heartbeat: "nightly" },
      { id: "tls-www", type: "tls", component: "Website", host: "www.example.com", addresses: "all" },
      { id: "domain", type: "domain", component: "Website", domain: "example.com" },
    ]
    const withInbox: Region[] = [{ name: "us", capabilities: { ...none, tlsInspector: true, inbox: true } }]
    const result = validateConfig(config, withInbox)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [hb, mail, tls, domain] = result.config.checks
    expect(hb).toMatchObject({ period: 86400, grace: 300, token: "NIGHTLY_TOKEN", public: false })
    expect(mail).toMatchObject({ heartbeat: "nightly", within: 1800 })
    expect(tls).toMatchObject({ port: 443, servername: "www.example.com", addresses: "all", warnDays: 14, alertDays: 7, schedule: 86400 })
    expect(tls?.type === "tls" && tls.renewWithin).toBeCloseTo(1 / 3)
    expect(domain).toMatchObject({ warnDays: 30, alertDays: 14, schedule: 86400 })
  })

  it("reads status classes, a fraction written as text, and durations in seconds", () => {
    const config = base()
    config.checks = [
      { id: "home", type: "http", component: "Website", url: "https://www.example.com/", expectStatus: ["2xx", 304], method: "head" },
      { id: "tls-www", type: "tls", component: "Website", host: "www.example.com", renewWithin: "1/2", schedule: "hourly" },
      { id: "job", type: "heartbeat", component: "API", period: 900, grace: "2m", token: "JOB_TOKEN" },
    ]
    const result = validateConfig(config, regions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.checks[0]).toMatchObject({ method: "HEAD", expectStatus: [{ min: 200, max: 299 }, { min: 304, max: 304 }] })
    expect(result.config.checks[1]).toMatchObject({ renewWithin: 0.5, schedule: 3600 })
    expect(result.config.checks[2]).toMatchObject({ period: 900, grace: 120 })
  })

  it("names the field and the check in each error", () => {
    const config = base()
    config.checks = [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/", timeoutSeconds: "ten" }]
    expect(errorsFor(config)).toEqual(['checks[0] (home).timeoutSeconds: must be a number above 0, got "ten".'])
  })

  it("gives each issue a stable code, a JSON pointer, and a fix when there is one", () => {
    const config = base()
    config.checks = [
      { id: "home", type: "http", component: "Website", url: "https://www.example.com/", timeoutSeconds: "ten" },
      { id: "api", type: "http", component: "Billing", url: "https://api.example.com/", expectKeywords: "ok" },
    ]
    const result = validateConfig(config, regions)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([
      { code: "invalid", path: "/checks/0/timeoutSeconds", message: 'must be a number above 0, got "ten".' },
      { code: "unknown-field", path: "/checks/1/expectKeywords", message: "isn't a known field.", fix: "Did you mean expectKeyword?" },
      { code: "unknown-reference", path: "/checks/1/component", message: '"Billing" isn\'t in components.', fix: "Add it there, or use one of: Website, API." },
    ])
  })

  it("points at list items and capability problems", () => {
    const config = base()
    config.notifiers = [{ id: "ops", type: "email", to: ["ops@example.com", "not-an-address"] }]
    config.checks = [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/", verifyTls: false }]
    const listItem = validateConfig(config, regions)
    expect(!listItem.ok && listItem.issues[0]).toMatchObject({ code: "invalid", path: "/notifiers/0/to/1" })

    config.notifiers = [{ id: "ops", type: "email", to: ["ops@example.com"] }]
    const capability = validateConfig(config, [workers("us")])
    expect(!capability.ok && capability.issues[0]).toMatchObject({ code: "missing-capability", path: "/checks/0/verifyTls" })
  })

  it("reports every error at once", () => {
    const config = base()
    config.checks = [
      { id: "Home Page", type: "http", component: "Website", url: "ftp://example.com" },
      { id: "api", type: "http", component: "Billing", url: "https://api.example.com/" },
    ]
    const errors = errorsFor(config)
    expect(errors).toHaveLength(3)
    expect(errors[0]).toContain("checks[0] (Home Page).id")
    expect(errors[1]).toContain("checks[0] (Home Page).url: must be an http or https URL")
    expect(errors[2]).toContain('checks (api).component: "Billing" isn\'t in components')
  })

  it("suggests the field a typo meant", () => {
    const config = base()
    config.checks = [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/", expectKeywords: "Welcome" }]
    expect(errorsFor(config)).toEqual(["checks[0] (home).expectKeywords: isn't a known field. Did you mean expectKeyword?"])
  })

  it("refuses fields that belong to another check type", () => {
    const config = base()
    config.checks = [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/", period: "1h" }]
    expect(errorsFor(config)[0]).toContain("checks[0] (home).period: isn't a known field")
  })

  it("refuses an unknown check type and lists the types", () => {
    const config = base()
    config.checks = [{ id: "ping", type: "icmp", component: "Website" }]
    expect(errorsFor(config)).toEqual(['checks[0] (ping).type: must be one of http, heartbeat, email, tls, domain, got "icmp".'])
  })

  it("requires the sections and at least one of each", () => {
    expect(errorsFor({})).toEqual(["components: is required.", "notifiers: is required.", "checks: is required."])
    expect(errorsFor({ components: [], notifiers: [], checks: [] })).toEqual([
      "components: add at least one component.",
      "notifiers: add at least one notifier, or no alert can be sent.",
      "checks: add at least one check.",
    ])
  })

  it("refuses duplicate ids", () => {
    const config = base()
    config.checks.push({ id: "home", type: "http", component: "API", url: "https://api.example.com/" })
    expect(errorsFor(config)).toEqual(['checks: two entries have the id "home". Each id must be unique.'])
  })

  it("refuses slowSeconds at or above timeoutSeconds", () => {
    const config = base()
    config.checks = [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/", timeoutSeconds: 5 }]
    expect(errorsFor(config)[0]).toContain("slowSeconds: must be less than timeoutSeconds (5)")
  })

  it("refuses a body on a GET", () => {
    const config = base()
    config.checks = [{ id: "home", type: "http", component: "Website", url: "https://www.example.com/", body: "{}" }]
    expect(errorsFor(config)[0]).toContain("body: a GET request can't have a body")
  })

  it("refuses alertDays above warnDays", () => {
    const config = base()
    config.checks = [{ id: "domain", type: "domain", component: "Website", domain: "example.com", warnDays: 10 }]
    expect(errorsFor(config)[0]).toContain("alertDays: must not be more than warnDays (10)")
  })

  it("refuses a host written as a URL", () => {
    const config = base()
    config.checks = [{ id: "tls-www", type: "tls", component: "Website", host: "https://www.example.com" }]
    expect(errorsFor(config)).toEqual(['checks[0] (tls-www).host: must be a host name such as www.example.com, without a scheme or path, got "https://www.example.com".'])
  })

  it("refuses an email check whose heartbeat isn't a heartbeat check", () => {
    const config = base()
    config.checks.push({ id: "mail", type: "email", component: "API", heartbeat: "home" })
    expect(errorsFor(config)).toContain('checks (mail).heartbeat: "home" is a http check. Name a heartbeat check.')
  })

  it("takes a check's priority from its component unless it sets its own", () => {
    const config = base()
    config.components[0] = { name: "Website", priority: "P2" } as { name: string }
    config.checks.push({ id: "assets", type: "http", component: "Website", url: "https://cdn.example.com/", priority: 4 })
    config.checks.push({ id: "status", type: "http", component: "API", url: "https://api.example.com/", priority: "p1" })
    const result = validateConfig(config, regions)
    if (!result.ok) throw new Error(result.errors.join("\n"))
    expect(result.config.checks.map((c) => [c.id, c.priority])).toEqual([
      ["home", "P2"],
      ["assets", "P4"],
      ["status", "P1"],
    ])
    expect(result.config.components[0]).toEqual({ name: "Website", priority: "P2", credits: [] })
  })

  it("refuses a priority outside P1 to P5", () => {
    const config = base()
    config.checks[0] = { ...config.checks[0], priority: "P6" }
    expect(errorsFor(config)).toEqual(['checks[0] (home).priority: must be one of P1, P2, P3, P4, P5, got "P6".'])
  })

  it("says what replaced severity, critical and levels", () => {
    const config = base()
    config.checks[0] = { ...config.checks[0], severity: "critical" }
    config.components[0] = { name: "Website", critical: true } as { name: string }
    config.notifiers[0] = { ...config.notifiers[0], levels: ["critical"] } as never
    const errors = errorsFor(config)
    expect(errors).toHaveLength(3)
    expect(errors.join("\n")).toContain('components[0] (Website).critical: was replaced by priority. Use "priority": "P1"')
    expect(errors.join("\n")).toContain('notifiers[0] (ops).levels: was replaced by upTo.')
    expect(errors.join("\n")).toContain('checks[0] (home).severity: was replaced by priority.')
  })

  it("defaults notifiers to P4, SMS to P2, and refuses upTo P5", () => {
    const config = base()
    config.notifiers.push({ id: "pager", type: "sms", to: ["+15555550100"] } as never)
    const result = validateConfig(config, regions)
    if (!result.ok) throw new Error(result.errors.join("\n"))
    expect(result.config.notifiers.map((n) => n.upTo)).toEqual(["P4", "P2"])
    config.notifiers[1] = { id: "pager", type: "sms", to: ["+15555550100"], upTo: "P5" } as never
    expect(errorsFor(config)).toEqual(['notifiers[1] (pager).upTo: must be one of P1, P2, P3, P4, got "P5" (P5 is recorded and never sent).'])
  })

  it("accepts an incident key and refuses one that isn't an id", () => {
    const config = base()
    config.checks[0] = { ...config.checks[0], incidentKey: "database" }
    const result = validateConfig(config, regions)
    expect(result.ok && result.config.checks[0]?.incidentKey).toBe("database")
    config.checks[0] = { ...config.checks[0], incidentKey: "Main DB" }
    expect(errorsFor(config)[0]).toContain('checks[0] (home).incidentKey: "Main DB" must use lowercase letters')
  })

  it("refuses an sms notifier when no region can send SMS", () => {
    const config = base()
    config.notifiers.push({ id: "pager", type: "sms", to: ["+15555550100"] } as never)
    expect(errorsFor(config, [workers("us")])[0]).toContain("no region's adapter can send SMS")
  })

  it("refuses a phone number that isn't in international format", () => {
    const config = base()
    config.notifiers.push({ id: "pager", type: "sms", to: ["555-0100"] } as never)
    expect(errorsFor(config)[0]).toContain("notifiers[1] (pager).to[0]: must be a phone number in international format")
  })

  it("reads a component's target and credit tiers, highest threshold first", () => {
    const config = base()
    config.components[0] = { name: "Website", target: 99.9, credits: [{ below: 99.0, percent: 25 }, { below: 99.9, percent: 10 }] } as { name: string }
    const result = validateConfig(config, regions)
    expect(result.ok && result.config.components[0]).toEqual({
      name: "Website",
      target: 99.9,
      credits: [
        { below: 99.9, percent: 10 },
        { below: 99.0, percent: 25 },
      ],
    })
  })

  it("refuses a target or credit tier outside 0 to 100", () => {
    const config = base()
    config.components[0] = { name: "Website", target: 120, credits: [{ below: 99.9 }] } as { name: string }
    const result = validateConfig(config, regions)
    expect(!result.ok && result.issues.map((i) => [i.code, i.path])).toEqual([
      ["invalid", "/components/0/target"],
      ["invalid", "/components/0/credits/0"],
    ])
  })

  it("validates thresholds and keeps defaults for the rest", () => {
    const config = { ...base(), thresholds: { confirmRegions: 3 } }
    const result = validateConfig(config, regions)
    expect(result.ok && result.config.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, confirmRegions: 3 })
    expect(errorsFor({ ...base(), thresholds: { recoverMinutes: 0 } })).toEqual(["thresholds.recoverMinutes: must be a whole number 1 or more, got 0."])
  })

  it("passes on assignChecks' errors when no region can run a check", () => {
    const config = base()
    config.checks.push({ id: "tls-www", type: "tls", component: "Website", host: "www.example.com" })
    expect(errorsFor(config, [workers("us")])[0]).toContain("Add a region on a Node adapter")
  })

  it("refuses a config with no regions", () => {
    expect(errorsFor(base(), [])[0]).toContain("No regions are declared")
  })
})

describe("the page section", () => {
  it("defaults to a page named Status", () => {
    const result = validateConfig(base(), regions)
    expect(result.ok && result.config.page).toEqual({ name: "Status", poweredBy: true })
  })

  it("reads components' group, description and link", () => {
    const config = { ...base(), components: [{ name: "Website", group: "Apps", description: "The web app", link: "https://app.example.com/" }, { name: "API" }] }
    const result = validateConfig(config, regions)
    expect(result.ok && result.config.components[0]).toEqual({ name: "Website", group: "Apps", description: "The web app", link: "https://app.example.com/", credits: [] })
  })

  it("names each problem with the page's fields", () => {
    const errors = errorsFor({
      ...base(),
      page: {
        logo: { src: "logo.svg" },
        logoDark: "dark.svg",
        theme: { name: "nothing" },
        states: { operational: { light: "green-ish", dark: "#4ade80" }, outage: { light: "#f00", dark: "#f00" } },
        mode: "dim",
        footer: { links: [{ text: "Privacy", url: "javascript:alert(1)" }] },
        reportProblem: "support",
      },
    })
    expect(errors).toEqual([
      "page.name: is required: the deployment's name, shown in the header and the title.",
      'page.logo.alt: is required: text for people who can\'t see the logo, usually the name, such as "Example".',
      'page.logoDark: must be an object, got "dark.svg".',
      "page.theme: is an object without cssVars. Use a theme in the shadcn/ui registry format, with cssVars.light and cssVars.dark, or give its file path or URL.",
      'page.states.operational.light: must be a CSS color such as #15803d or oklch(0.6 0.15 150), got "green-ish".',
      "page.states.outage: isn't a known field.",
      "page.mode: was removed: the page always starts on the viewer's system setting, and viewers can choose light or dark. Remove page.mode.",
      'page.footer.links[0]: must be { "text": <words saying where it goes>, "url": <http, https or mailto address> }, got {"text":"Privacy","url":"javascript:alert(1)"}.',
      'page.reportProblem: must be an http, https or mailto address, got "support".',
    ])
  })
})

import { describe, expect, it } from "vitest"
import { buildFeeds, buildNotes, buildSummary, headline, publicPage, publicStatus, slug, validateConfig, type Config, type PageInput } from "../src/index.ts"

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }
function config(): Config {
  const result = validateConfig(
    {
      page: { name: "Example" },
      components: [{ name: "Website", group: "Apps", description: "The web app" }, { name: "API", group: "Apps" }, { name: "Billing" }],
      notifiers: [{ id: "ops", type: "webhook", secret: "HOOK" }],
      checks: [
        { id: "home", type: "http", component: "Website", url: "https://www.example.com/" },
        { id: "api", type: "http", component: "API", url: "https://api.example.com/" },
        { id: "billing", type: "http", component: "Billing", url: "https://billing.example.com/" },
      ],
    },
    [{ name: "us", capabilities: caps }],
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  return result.config
}

const now = new Date("2026-11-21T10:00:00Z")
const noteFiles = [
  {
    file: "slow-api.md",
    text: "---\ntype: incident\ntitle: Slow API & <errors>\ncomponent: API\nstart: 2026-11-21T09:00:00Z\nimpact: major\ndetected: api-202611210900\n---\nRequests are slow.\n\n## 2026-11-21 09:10 UTC Identified\nComponents: API (Partial outage)\nA bad deploy.\n\n## 2026-11-21 09:40 UTC\nRolling back.\n",
  },
  { file: "db.md", text: "---\ntype: maintenance\ntitle: Database upgrade\ncomponents: Billing\nstart: 2026-11-22T02:00:00Z\nend: 2026-11-22T03:00:00Z\n---\nA larger server.\n" },
  { file: "old.md", text: "---\ntype: maintenance\ntitle: Old work\ncomponents: Billing\nstart: 2026-11-01T02:00:00Z\nend: 2026-11-01T03:00:00Z\n---\nDone.\n" },
  { file: "notice.md", text: "---\ntype: notice\ntitle: New API address\n---\nIt moves on 1 December.\n" },
]

function input(): PageInput {
  const c = config()
  const notes = buildNotes(noteFiles, c, now).notes
  if (!notes) throw new Error("notes didn't build")
  const open = [
    { format: "belltower.incident/1" as const, id: "api-202611210900", key: "api", priority: "P3" as const, components: ["API"], checks: { api: { component: "API", spans: [{ start: "2026-11-21T09:00:00.000Z" }], summary: "", regions: [], firstFailures: {} } }, startedAt: "2026-11-21T09:00:00.000Z", detectedAt: "2026-11-21T09:02:00.000Z" },
    { format: "belltower.incident/1" as const, id: "billing-202611210950", key: "billing", priority: "P3" as const, components: ["Billing"], checks: { billing: { component: "Billing", spans: [{ start: "2026-11-21T09:50:00.000Z" }], summary: "", regions: [], firstFailures: {} } }, startedAt: "2026-11-21T09:50:00.000Z", detectedAt: "2026-11-21T09:52:00.000Z" },
  ]
  const status = publicStatus(c, { home: "up", api: "down", billing: "down" }, open, now)
  return { status, notes, page: publicPage(c, now), siteUrl: "https://status.example.com/", now }
}

describe("buildSummary", () => {
  it("gives the page, the indicator, components with groups, incidents and maintenance", () => {
    const summary = buildSummary(input()) as Record<string, any>
    expect(summary.page).toEqual({ id: "example", name: "Example", url: "https://status.example.com/", time_zone: "Etc/UTC", updated_at: "2026-11-21T10:00:00.000Z" })
    expect(summary.status).toEqual({ indicator: "critical", description: "A service is down" })
    expect(summary.components.map((c: any) => [c.id, c.status, c.group, c.group_id])).toEqual([
      ["website", "operational", false, "apps"],
      ["api", "major_outage", false, "apps"],
      ["billing", "major_outage", false, null],
      ["apps", "major_outage", true, null],
    ])
    expect(summary.incidents.map((i: any) => [i.id, i.name, i.status, i.impact])).toEqual([
      ["slow-api", "Slow API & <errors>", "identified", "major"],
      ["billing-202611210950", "Detected outage", "investigating", "major"],
    ])
    expect(summary.incidents[0].incident_updates.map((u: any) => [u.status, u.body])).toEqual([
      ["identified", "Rolling back."],
      ["identified", "A bad deploy."],
    ])
    expect(summary.incidents[0].incident_updates[1].affected_components).toEqual([{ code: "api", name: "API", new_status: "partial_outage" }])
    expect(summary.incidents[0].shortlink).toBe("https://status.example.com/incidents/slow-api.html")
    expect(summary.scheduled_maintenances.map((m: any) => [m.id, m.status, m.scheduled_for])).toEqual([["db", "scheduled", "2026-11-22T02:00:00.000Z"]])
  })
})

describe("buildFeeds", () => {
  it("lists incidents and maintenance, newest change first, escaped", () => {
    const { atom, rss, json } = buildFeeds(input())
    const feed = JSON.parse(json)
    // The maintenance was announced at 10:00, after the incident's last update.
    expect(feed.items.map((i: any) => [i.title, i.date_modified])).toEqual([
      ["Database upgrade (Scheduled)", "2026-11-21T10:00:00.000Z"],
      ["Slow API & <errors> (Identified)", "2026-11-21T09:40:00.000Z"],
      ["Old work (Completed)", "2026-11-01T02:00:00.000Z"],
    ])
    expect(feed.items[1].content_text).toContain("Identified at 2026-11-21 09:10 UTC\nComponents: API (Partial outage)\nA bad deploy.")
    expect(atom).toContain("<title>Slow API &amp; &lt;errors&gt; (Identified)</title>")
    expect(atom).toContain("<updated>2026-11-21T09:40:00.000Z</updated>")
    expect(rss).toContain('<guid isPermaLink="true">https://status.example.com/incidents/slow-api.html</guid>')
    expect(atom).not.toContain("New API address")
  })
})

describe("words and names", () => {
  it("says the overall state as a sentence and makes safe slugs", () => {
    expect(headline("operational")).toBe("All services are online")
    expect(slug("Données & Storage (EU)")).toBe("donnees-storage-eu")
    expect(slug("!!!")).toBe("group")
  })
})

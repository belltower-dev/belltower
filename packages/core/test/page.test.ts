import { describe, expect, it } from "vitest"
import { buildNotes, buildPage, memoryStore, publicPage, publicStatus, validateConfig, writePage, type Config, type Store } from "../src/index.ts"
import { renderMarkdown } from "../src/page/markdown.ts"
import { situation } from "../src/page/pages.ts"

const caps = { tlsInspector: false, inbox: false, sms: false, skipTlsVerify: false, timingBreakdown: false }
const now = new Date("2026-11-15T14:20:00Z")
const clock = { now: () => now }

function config(page: Record<string, unknown> = {}): Config {
  const result = validateConfig(
    {
      page: { name: "Example", ...page },
      components: [
        { name: "Website", group: "Apps", description: "The web app", target: 99.9 },
        { name: "API", group: "Apps" },
        { name: "Uploads", group: "Storage" },
      ],
      notifiers: [{ id: "ops", type: "webhook", secret: "HOOK" }],
      checks: [
        { id: "home", type: "http", component: "Website", url: "https://www.example.com/" },
        { id: "api", type: "http", component: "API", url: "https://api.example.com/" },
        { id: "up", type: "http", component: "Uploads", url: "https://up.example.com/" },
      ],
    },
    [{ name: "us", capabilities: caps }, { name: "eu", capabilities: caps }],
  )
  if (!result.ok) throw new Error(result.errors.join("\n"))
  return result.config
}

async function world(c = config(), notes: { file: string; text: string }[] = []): Promise<Store> {
  const store = memoryStore()
  const open = [{ format: "belltower.incident/1" as const, id: "api-202611151340", key: "api", priority: "P3" as const, components: ["API"], checks: { api: { component: "API", spans: [{ start: "2026-11-15T13:40:00.000Z" }], summary: "", regions: [], firstFailures: {} } }, startedAt: "2026-11-15T13:40:00.000Z", detectedAt: "2026-11-15T13:42:00.000Z" }]
  const status = publicStatus(c, { home: "up", api: "down", up: "up" }, open, now, new Set(), [
    { name: "us", lastResultsAt: "2026-11-15T14:19:00.000Z" },
    { name: "eu", lastResultsAt: "2026-11-15T13:50:00.000Z" },
  ])
  await store.put("public/status.json", JSON.stringify(status))
  await store.put("public/page.json", JSON.stringify(publicPage(c, now)))
  const built = buildNotes(notes, c, now)
  if (built.notes) await store.put("public/notes.json", JSON.stringify(built.notes))
  return store
}

describe("buildPage", () => {
  it("says what to do when decide() hasn't run", async () => {
    const result = await buildPage({ store: memoryStore(), clock, siteUrl: "https://status.example.com/" })
    expect(result).toEqual({ ok: false, problems: ["public/status.json is missing. Run decide() at least once before building the page.", "public/page.json is missing. Run decide() at least once before building the page."] })
  })

  it("builds every page, its Markdown copy, the feeds, summary.json and llms.txt", async () => {
    const result = await buildPage({ store: await world(), clock, siteUrl: "https://status.example.com" })
    if (!result.ok) throw new Error(result.problems.join("\n"))
    expect(Object.keys(result.files).sort()).toEqual([
      "apps.html", "apps.md", "components.html", "components.md", "feed.atom", "feed.json", "feed.rss", "incidents.html", "incidents.md",
      "incidents/api-202611151340.html", "incidents/api-202611151340.md", "index.html", "index.md", "llms.txt",
      "maintenance.html", "maintenance.md", "storage.html", "storage.md", "style.css", "summary.json",
    ])
    const index = result.files["index.html"] ?? ""
    expect(index).toContain("<span>One service is down</span></h1>")
    expect(index).toContain('<a href="apps.html">API</a>: Major outage')
    expect(index).toContain('<a class="small" href="components.html">All components</a>')
    expect(result.files["components.html"]).toContain('<h2 id="g-apps"><a href="apps.html">Apps</a></h2>')
    expect(index).toContain("eu has written no recent results")
    expect(index).toContain('href="incidents/api-202611151340.html">Detected outage</a>')
    expect(index).toContain('<link rel="alternate" type="text/markdown" href="index.md">')
    // No third-party requests: one local stylesheet, inline script, no remote assets.
    expect(index).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/)
    expect(result.files["incidents/api-202611151340.html"]).toContain('href="../style.css"')
    expect(result.files["style.css"]).toContain("--background: oklch(1 0 0);")
    expect(result.files["index.md"]).toContain("Days, oldest first")
  })

  it("escapes note text and allows only safe links", async () => {
    const note = { file: "x.md", text: "---\ntype: incident\ntitle: <script>alert(1)</script>\ncomponent: API\nstart: 2026-11-15T13:00:00Z\n---\nSee [the plan](https://example.com/plan) and [this](javascript:alert(1)).\n" }
    const result = await buildPage({ store: await world(config(), [note]), clock, siteUrl: "https://status.example.com/" })
    if (!result.ok) throw new Error(result.problems.join("\n"))
    const page = result.files["incidents/x.html"] ?? ""
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(page).not.toContain("<script>alert(1)")
    expect(page).toContain('<a href="https://example.com/plan">the plan</a>')
    expect(page).not.toContain('href="javascript:')
  })

  it("refuses a theme that fails contrast, and writes nothing", async () => {
    const theme = { name: "pale", cssVars: { light: { foreground: "#bbbbbb" }, dark: {} } }
    const store = await world(config({ theme }))
    const result = await buildPage({ store, clock, siteUrl: "https://status.example.com/" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]).toMatch(/^light mode: Text on the page background is 1\.\d+:1 \(#bbbbbb on oklch\(1 0 0\)\); it needs 4\.5:1\. Change the theme's foreground to oklch\(/)
    expect(await store.get("public/index.html")).toBeNull()
  })

  it("shows the name beside a logo mark, and not beside a wordmark", async () => {
    const mark = await buildPage({ store: await world(config({ logo: { src: "mark.svg", alt: "Example" } })), clock, siteUrl: "https://status.example.com/" })
    const word = await buildPage({ store: await world(config({ logo: { src: "word.svg", alt: "Example", wordmark: true } })), clock, siteUrl: "https://status.example.com/" })
    if (!mark.ok || !word.ok) throw new Error("build failed")
    expect(mark.files["index.html"]).toContain('<img class="logo-light" src="mark.svg" alt="Example" height="28"><span>Example</span></a>')
    expect(word.files["index.html"]).toContain('<img class="logo-light" src="word.svg" alt="Example" height="28"></a>')
    expect(mark.files["incidents/api-202611151340.html"]).toContain('src="../mark.svg"')
    expect(mark.files["index.html"]).toContain('<a class="brand" href="index.html" aria-label="Example status, home">')
    const linked = await buildPage({ store: await world(config({ link: "https://example.com/" })), clock, siteUrl: "https://status.example.com/" })
    expect(linked.ok && linked.files["index.html"]).toContain('<a class="brand" href="https://example.com/" aria-label="Go to Example">')
    expect(linked.ok && linked.files["index.html"]).not.toContain(">Go to Example</a>")
  })

  it("reads a theme by path through the adapter, and writes beside status.json", async () => {
    const store = await world(config({ theme: "theme.json" }))
    const theme = { cssVars: { light: { primary: "#1d4ed8" }, dark: { primary: "#93c5fd", "primary-foreground": "#0b1220" } } }
    const result = await buildPage({ store, clock, siteUrl: "https://status.example.com/", loadTheme: async (ref) => (ref === "theme.json" ? theme : null) })
    if (!result.ok) throw new Error(result.problems.join("\n"))
    expect(result.files["style.css"]).toContain("--primary: #1d4ed8;")
    await writePage(store, result.files)
    expect(await store.get("public/index.html")).toContain("<!doctype html>")
    const without = await buildPage({ store, clock, siteUrl: "https://status.example.com/" })
    expect(without.ok === false && without.problems[0]).toContain("this build can't read files")
  })
})

describe("page words", () => {
  it("keeps the headline short and leaves the names to the list", () => {
    const web = { name: "Web", state: "operational" as const }
    expect(situation([web, { name: "API", state: "partial" }], "partial")).toBe("One service is down")
    expect(situation([web, { name: "API", state: "major" }, { name: "Hooks", state: "degraded" }], "major")).toBe("Some services are down")
    expect(situation([web, { name: "Hooks", state: "degraded" }, { name: "B", state: "degraded" }], "degraded")).toBe("Some services are slow")
    expect(situation([web, { name: "DB", state: "maintenance" }], "maintenance")).toBe("Maintenance in progress")
    expect(situation([web, { name: "B", state: "operational" }], "operational")).toBe("All services are online")
    expect(situation([{ name: "Website", state: "major" }], "major")).toBe("Website is down")
  })

  it("renders lists, headings under the page's own, and code", () => {
    expect(renderMarkdown("# Cause\n\n- one\n- two\n\nUse `retry`.", 3)).toBe("<h3>Cause</h3>\n<ul><li>one</li><li>two</li></ul>\n<p>Use <code>retry</code>.</p>")
  })
})
